export const runtime = 'nodejs';

import { createId } from '@paralleldrive/cuid2';
import formidable, { Fields, Files, File as FormidableFile } from 'formidable';
import fs from 'fs/promises';
import { drive_v3, google } from 'googleapis';
import { IncomingMessage } from 'http';
import { Socket } from 'net';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { googleAuthFailure } from '@/app/lib/googleAuthErrors';
import { NextResponse } from 'next/server';
import path from 'path';
import { fromPath as pdf2picFromPath } from 'pdf2pic';
import { Readable } from 'stream';
import { geminiOCR } from '../../lib/geminiOCR';
import { DEFAULT_MODEL, type ModelValue } from '../../lib/modelConfig';
import { refreshAccessToken } from '../../lib/refreshAccessToken';

const FALLBACK_MODEL: ModelValue = 'gemini-3.1-pro-preview';

export const config = {
  api: {
    bodyParser: false,
  },
};

interface PageResult {
  status: 'success' | 'error';
  driveId?: string;
  error?: string;
  modelUsed?: string;
  processingTime?: number;
  textLength?: number;
  timestamp?: string;
}

async function cleanupTmpUploadsOcr(maxAgeHours: number = 24): Promise<void> {
  const baseTmp = path.join(process.cwd(), 'tmp_uploads_ocr');

  try {
    console.log('🧹 Starting comprehensive cleanup of tmp_uploads_ocr...');

    try {
      await fs.access(baseTmp);
    } catch {
      console.log('📁 tmp_uploads_ocr directory does not exist, nothing to clean');
      return;
    }

    const items = await fs.readdir(baseTmp);
    const now = Date.now();
    const maxAge = maxAgeHours * 60 * 60 * 1000;
    let cleanedCount = 0;
    let errorCount = 0;

    for (const item of items) {
      const itemPath = path.join(baseTmp, item);

      try {
        const stats = await fs.stat(itemPath);
        const ageMs = now - stats.mtime.getTime();

        if (stats.isDirectory() && ageMs > maxAge) {
          console.log(`🗑️ Removing old directory: ${item} (${Math.round(ageMs / (60 * 60 * 1000))}h old)`);
          await fs.rm(itemPath, { recursive: true, force: true });
          cleanedCount++;
        } else if (stats.isDirectory()) {
          console.log(`⏳ Keeping recent directory: ${item} (${Math.round(ageMs / (60 * 60 * 1000))}h old)`);
        }
      } catch (err) {
        console.error(`❌ Error processing ${item}:`, err);
        errorCount++;
      }
    }

    console.log(`✅ Cleanup completed: ${cleanedCount} directories removed, ${errorCount} errors`);

    const remainingItems = await fs.readdir(baseTmp);
    if (remainingItems.length === 0) {
      console.log('🗂️ Removing empty tmp_uploads_ocr directory');
      await fs.rmdir(baseTmp);
    }

  } catch (err) {
    console.error('❌ Error during tmp_uploads_ocr cleanup:', err);
  }
}

async function cleanupDirectoryWithRetries(dirPath: string, retries: number = 3): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`🧹 Cleanup attempt ${attempt}/${retries} for: ${dirPath}`);
      await fs.rm(dirPath, { recursive: true, force: true });
      console.log(`✅ Successfully cleaned up: ${dirPath}`);
      return;
    } catch (err) {
      console.error(`❌ Cleanup attempt ${attempt} failed for ${dirPath}:`, err);

      if (attempt === retries) {
        console.error(`💥 All cleanup attempts failed for ${dirPath}. Manual cleanup may be required.`);
        return;
      }

      const delay = Math.pow(2, attempt) * 1000;
      console.log(`⏳ Waiting ${delay}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

export async function POST(request: Request) {
  console.log('🔹 [START] REGULAR OCR REQUEST - Enhanced Debug Mode');
  console.log('⏱️ Request timestamp:', new Date().toISOString());
  console.log(`🔧 Using default model: ${DEFAULT_MODEL}`);

  let tmpDir: string | null = null;
  let pdfPath: string | null = null;

  const debugMode = process.env.NODE_ENV === 'development' || process.env.OCR_DEBUG_PRESERVE_FILES === 'true';
  if (debugMode) {
    console.log('🐛 DEBUG MODE: Files will be preserved for debugging');
  }

  try {
    const session = await getApiSession(request);
    const scriptCaller = request.headers.has('x-api-key');
    if (!session?.accessToken || (!scriptCaller && (!session.refreshToken || typeof session.accessTokenExpires !== 'number'))) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    console.log('🧹 Running cleanup of old temp directories...');
    const cleanupStartTime = Date.now();
    await cleanupTmpUploadsOcr(1);
    console.log(`✅ Cleanup completed in ${Date.now() - cleanupStartTime}ms`);

    console.log('🔹 Checking user session...');
    let accessToken = session.accessToken;
    let refreshToken = session.refreshToken;
    let expires = session.accessTokenExpires ?? 0;
    const bufferMs = 30 * 60 * 1000;

    console.log('🔹 Parsing form data...');
    const formData = await parseFormData(request);
    console.log('✅ Form data parsed successfully');
    const projectId = formData.get('project_id') as string;
    const pdfFile = formData.get('pdf_file') as File;
    const startPage = Math.max(1, Number(formData.get('start_page') || 1));
    const endPage = Math.max(startPage, Number(formData.get('end_page') || startPage));

    if (!pdfFile) {
      console.log('❌ No PDF file provided.');
      return NextResponse.json({ error: 'No pdf_file provided' }, { status: 400 });
    }

    console.log('🔹 Creating temporary directory...');
    const baseTmp = path.join(process.cwd(), 'tmp_uploads_ocr');
    await fs.mkdir(baseTmp, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(baseTmp, 'pdf-'));
    console.log(`✅ Temp directory: ${tmpDir}`);

    pdfPath = path.join(tmpDir, `${createId()}.pdf`);
    const arrayBuffer = await pdfFile.arrayBuffer();
    await fs.writeFile(pdfPath, Buffer.from(arrayBuffer));
    console.log(`✅ PDF saved to ${pdfPath}`);

    console.log('🔹 Converting PDF to images...');
    const imageResults = await convertPdfToImages(pdfPath, startPage, endPage, tmpDir);
    if (imageResults.length === 0) {
      console.log('❌ No images were created, aborting OCR.');
      return NextResponse.json(
        { error: 'PDF conversion failed or no pages in range' },
        { status: 500 }
      );
    }
    console.log(`✅ Converted ${imageResults.length} pages to images`);

    console.log('🔹 Initializing Google OAuth...');
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID!,
      process.env.GOOGLE_CLIENT_SECRET!,
      process.env.GOOGLE_REDIRECT_URI!
    );
    oauth2Client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    console.log('🔹 Ensuring "Extracts" folder exists...');
    const extractsFolderId = await ensureFolder(drive, 'Extracts', projectId);
    console.log(`✅ Extracts folder ID: ${extractsFolderId}`);

    const pdfName = path.parse(pdfFile.name).name;
    console.log(`🔹 Ensuring folder for ${pdfName} exists...`);
    const targetFolderId = await ensureFolder(drive, pdfName, extractsFolderId);
    console.log(`✅ Folder for PDF: ${targetFolderId}`);

    const uploadResults: Record<number, PageResult> = {};

    for (const { page, path: imgPath } of imageResults) {
      let modelUsed = DEFAULT_MODEL;

      const minutesLeft = Math.ceil((expires - Date.now()) / (60 * 1000));
      console.log(`🔒 Token has ${minutesLeft} min left`);
      if (refreshToken && Date.now() >= expires - bufferMs) {
        console.log('⚠️ Token expiring soon, refreshing mid-run...');
        const out = await refreshAccessToken({
          accessToken,
          refreshToken,
          accessTokenExpires: expires,
        });
        if (out.error || !out.accessToken) {
          console.error('❌ Failed to refresh access token during loop:', out.error);
          throw new Error('Unable to refresh access token during loop: ' + (out.error || 'Unknown reason'));
        }
        accessToken = out.accessToken;
        refreshToken = out.refreshToken ?? refreshToken;
        expires = out.accessTokenExpires!;
        oauth2Client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
        const newMinutesLeft = Math.ceil((expires - Date.now()) / (60 * 1000));
        console.log(
          `✅ Token refreshed; now expires at ${new Date(expires).toISOString()} (${newMinutesLeft} min left)`
        );
      }

      try {
        console.log(`🔹 STARTING OCR FOR PAGE ${page} - ${imgPath}`);
        const pageStartTime = Date.now();

        let { text, error } = await geminiOCR(imgPath);

        if (!text && error && modelUsed !== FALLBACK_MODEL) {
          console.log(`🔄 Page ${page} failed with ${modelUsed}, retrying with fallback model...`);
          const fallbackAttempt = await geminiOCR(imgPath, undefined, FALLBACK_MODEL);
          if (fallbackAttempt.text) {
            text = fallbackAttempt.text;
            error = undefined;
            modelUsed = FALLBACK_MODEL;
            console.log(`✅ Page ${page} succeeded with fallback model`);
          } else {
            console.log(`❌ Page ${page} failed with both primary and fallback models`);
            error = `Failed with both models: ${fallbackAttempt.error || error}`;
          }
        }

        const ocrTime = Date.now() - pageStartTime;

        if (!text) {
          console.warn(`❌ PAGE ${page} OCR FAILED (${(ocrTime / 1000).toFixed(2)}s): ${error}`);
          uploadResults[page] = {
            status: 'error',
            error: error || 'OCR did not produce any text',
            modelUsed,
            processingTime: ocrTime,
            timestamp: new Date().toISOString()
          };
          continue;
        }

        console.log(`✅ PAGE ${page} OCR SUCCESS:`);
        console.log(`   📝 Text length: ${text.length} characters`);
        console.log(`   ⏱️  OCR time: ${(ocrTime / 1000).toFixed(2)}s`);
        console.log(`   🚀 Model used: ${modelUsed}`);
        console.log(`   📊 Rate: ${Math.round(text.length / (ocrTime / 1000))} chars/sec`);

        if (debugMode && tmpDir) {
          const localTexPath = path.join(tmpDir, `page_${page}.tex`);
          await fs.writeFile(localTexPath, text, 'utf-8');
          console.log(`🐛 DEBUG: Saved LaTeX to ${localTexPath}`);
        }

        const texBuffer = Buffer.from(text, 'utf-8');
        const texName = `${page}.tex`;
        const media = {
          mimeType: 'text/plain',
          body: BufferToStream(texBuffer),
        };

        console.log(`🔹 Uploading ${texName} to Google Drive...`);
        const uploadStartTime = Date.now();
        const createRes = await drive.files.create({
          requestBody: {
            name: texName,
            parents: [targetFolderId],
          },
          media,
          fields: 'id',
        });
        const uploadTime = Date.now() - uploadStartTime;

        if (createRes.data.id) {
          console.log(`✅ Page ${page} uploaded to Drive in ${uploadTime}ms (ID: ${createRes.data.id})`);
          uploadResults[page] = {
            status: 'success',
            driveId: createRes.data.id,
            modelUsed,
            processingTime: ocrTime,
            textLength: text.length,
            timestamp: new Date().toISOString()
          };
        } else {
          console.log(`❌ Page ${page} Drive upload failed: No file ID returned`);
          uploadResults[page] = {
            status: 'error',
            error: 'Drive upload failed',
            modelUsed,
            processingTime: ocrTime,
            timestamp: new Date().toISOString()
          };
        }
      } catch (pageErr: unknown) {
        const authFailure = googleAuthFailure(pageErr);
        if (authFailure) return NextResponse.json({ ...authFailure, project_id: projectId, results: uploadResults }, { status: 401 });
        console.error(`❌ Error during OCR/upload for page ${page}:`, pageErr);
        const msg = pageErr instanceof Error ? pageErr.message : 'Unknown error';
        uploadResults[page] = {
          status: 'error',
          error: msg,
          modelUsed: modelUsed || DEFAULT_MODEL,
          timestamp: new Date().toISOString()
        };
      }
    }

    console.log('✅ OCR process completed successfully.');
    return NextResponse.json({
      project_id: projectId,
      folder_id: targetFolderId,
      results: uploadResults,
    });
  } catch (err: unknown) {
    const authFailure = googleAuthFailure(err);
    if (authFailure) return NextResponse.json(authFailure, { status: 401 });
    console.error('❌ Fatal error in POST handler:', err);
    const msg = err instanceof Error ? err.message : 'An unknown error occurred during OCR processing.';
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    const cleanupPromises: Promise<void>[] = [];

    if (pdfPath) {
      cleanupPromises.push(
        (async () => {
          try {
            console.log(`🗑️ Removing PDF file: ${pdfPath}`);
            await fs.unlink(pdfPath);
          } catch (err) {
            console.error(`⚠️ Error removing PDF file ${pdfPath}:`, err);
          }
        })()
      );
    }

    if (tmpDir && !debugMode) {
      cleanupPromises.push(cleanupDirectoryWithRetries(tmpDir));
    } else if (tmpDir && debugMode) {
      console.log(`🐛 DEBUG MODE: Preserving temp directory: ${tmpDir}`);
    }

    if (!debugMode) {
      await Promise.allSettled(cleanupPromises);
      console.log('🔹 OCR request processing finished - cleanup completed.');
    } else {
      console.log('🔹 OCR request processing finished - files preserved for debugging.');
    }
  }
}

async function convertPdfToImages(
  pdfPath: string,
  startPage: number,
  endPage: number,
  baseTempDir: string
): Promise<{ page: number; path: string }[]> {
  console.log('🔹 Converting PDF pages to images...');

  const outDir = path.join(baseTempDir, `${createId()}_pages`);
  await fs.mkdir(outDir, { recursive: true });

  const pdf2pic = pdf2picFromPath(pdfPath, {
    density: 600,
    savePath: outDir,
    format: 'png',
    quality: 100,
  });

  console.log('📐 PDF conversion settings: 600 DPI, maintaining original aspect ratio, PNG format');

  const images: { page: number; path: string }[] = [];
  for (let i = startPage; i <= endPage; i++) {
    try {
      console.log(`🔹 Converting page ${i} to high-res image (600 DPI)...`);
      const result = await pdf2pic(i);
      if (result?.path) {
        console.log(`✅ Page ${i} → ${result.path}`);
        images.push({ page: i, path: result.path });
      } else {
        console.warn(`⚠️ Page ${i} conversion returned no path.`);
      }
    } catch (convErr: unknown) {
      console.error(`❌ Error converting page ${i} at 600 DPI:`, convErr);

      try {
        console.log(`🔄 Trying page ${i} with fallback resolution (300 DPI)...`);
        const fallbackPdf2pic = pdf2picFromPath(pdfPath, {
          density: 300,
          savePath: outDir,
          format: 'png',
          quality: 100,
        });

        const fallbackResult = await fallbackPdf2pic(i);
        if (fallbackResult?.path) {
          console.log(`✅ Page ${i} converted with fallback → ${fallbackResult.path}`);
          images.push({ page: i, path: fallbackResult.path });
        } else {
          console.error(`❌ Page ${i} failed even with fallback resolution`);
        }
      } catch (fallbackErr: unknown) {
        console.error(`❌ Page ${i} fallback conversion failed:`, fallbackErr);
      }
    }
  }

  return images;
}

async function parseFormData(request: Request): Promise<FormData> {
  console.log('🔹 Parsing form data...');

  const req = Object.assign(new IncomingMessage(null as unknown as Socket), {
    headers: Object.fromEntries(request.headers.entries()),
    method: request.method,
    url: request.url,
  });

  req._read = () => { };
  if (request.body) {
    const reader = request.body.getReader();
    req._read = async function () {
      const { done, value } = await reader.read();
      if (done) {
        this.push(null);
      } else {
        this.push(value);
      }
    };
  }

  const form = formidable({
    multiples: true,
    maxFileSize: 30 * 1024 * 1024,
    maxTotalFileSize: 60 * 1024 * 1024,
    maxFieldsSize: 50 * 1024 * 1024,
  });
  const [fields, files]: [Fields, Files] = await new Promise((resolve, reject) => {
    form.parse(req, (err, fld, fls) => {
      if (err) return reject(err);
      resolve([fld, fls]);
    });
  });

  console.log('✅ Form data parsed:', fields, files);
  const formData = new FormData();

  for (const [key, val] of Object.entries(fields)) {
    if (Array.isArray(val)) {
      formData.append(key, val[0]);
    } else if (typeof val === 'string') {
      formData.append(key, val);
    }
  }

  for (const [key, fileList] of Object.entries(files)) {
    const arr = Array.isArray(fileList) ? fileList : [fileList];
    for (const fileData of arr as FormidableFile[]) {
      if (fileData?.filepath) {
        const buffer = await fs.readFile(fileData.filepath);
        const filename = fileData.originalFilename || 'blob';
        const mimetype = fileData.mimetype || 'application/octet-stream';
        formData.append(key, new File([new Uint8Array(buffer)], filename, { type: mimetype }));
        break;
      }
    }
  }

  return formData;
}

async function ensureFolder(
  drive: drive_v3.Drive,
  folderName: string,
  parentId: string
): Promise<string> {
  console.log(`🔹 ensureFolder: "${folderName}" under parent ${parentId}`);
  const q = `'${parentId}' in parents and name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const listRes = await drive.files.list({ q, fields: 'files(id)' });
  const existingId = listRes.data.files?.[0]?.id;
  if (existingId) {
    console.log(`✅ Reusing folder "${folderName}" (${existingId})`);
    return existingId;
  }
  console.log(`🔹 Creating folder "${folderName}" under parent ${parentId}`);
  const createRes = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });
  if (!createRes.data.id) {
    throw new Error(`Failed to create folder "${folderName}"`);
  }
  console.log(`✅ Created folder "${folderName}" (${createRes.data.id})`);
  return createRes.data.id;
}

function BufferToStream(binary: Buffer): Readable {
  const readable = new Readable();
  readable.push(binary);
  readable.push(null);
  return readable;
}
