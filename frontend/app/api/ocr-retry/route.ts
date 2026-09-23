import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_MODEL } from '../../lib/modelConfig';
import { geminiOCR } from '../../lib/geminiOCR';
import pdf2pic from 'pdf2pic';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { googleAuthFailure } from '@/app/lib/googleAuthErrors';
import { refreshAccessToken } from '../../lib/refreshAccessToken';
import { google } from 'googleapis';

interface PageResult {
  status: 'success' | 'error';
  driveId?: string;
  error?: string;
  modelUsed?: string;
  processingTime?: number;
  textLength?: number;
  timestamp?: string;
}

export async function POST(request: NextRequest) {
  let model = DEFAULT_MODEL;
  
  try {
    const session = await getApiSession(request);
    const scriptCaller = request.headers.has('x-api-key');
    if (!session?.accessToken || (!scriptCaller && (!session.refreshToken || typeof session.accessTokenExpires !== 'number'))) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    console.log('🔄 OCR Retry API - Processing request...');
    
    const formData = await request.formData();
    const projectId = formData.get('project_id') as string;
    const pageNumber = parseInt(formData.get('page_number') as string);
    model = formData.get('model') as string || DEFAULT_MODEL;
    const fileName = formData.get('file_name') as string;
    
    if (!projectId || !pageNumber || !fileName) {
      return NextResponse.json(
        { error: 'Missing required parameters: project_id, page_number, file_name' },
        { status: 400 }
      );
    }

    console.log(`📄 Retrying OCR for ${fileName}, page ${pageNumber} with model ${model}`);
    
    const startTime = Date.now();
    
    console.log('🔹 Checking user session...');
    let accessToken = session.accessToken;
    let refreshToken = session.refreshToken;
    let expires = session.accessTokenExpires ?? 0;
    const bufferMs = 30 * 60 * 1000;

    const minutesLeft = Math.ceil((expires - Date.now()) / (60 * 1000));
    console.log(`🔒 Token has ${minutesLeft} min left`);
    if (refreshToken && Date.now() >= expires - bufferMs) {
      console.log('⚠️ Token expiring soon, refreshing...');
      const out = await refreshAccessToken({
        accessToken,
        refreshToken,
        accessTokenExpires: expires,
      });
      if (out.error || !out.accessToken) {
        console.error('❌ Failed to refresh access token:', out.error);
        return NextResponse.json(
          { error: 'Failed to refresh authentication token' },
          { status: 401 }
        );
      }
      accessToken = out.accessToken;
      refreshToken = out.refreshToken ?? refreshToken;
      expires = out.accessTokenExpires!;
      console.log(`✅ Token refreshed successfully`);
    }

    console.log(`📥 Initializing Google Drive API...`);
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ 
      access_token: accessToken, 
      refresh_token: refreshToken 
    });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    console.log(`🔍 Searching for file ${fileName} in project ${projectId}...`);
    
    const pdfsFolderQuery = `name='PDFs' and parents in '${projectId}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const folderListResponse = await drive.files.list({
      q: pdfsFolderQuery,
      fields: 'files(id, name)',
      pageSize: 10
    });
    
    let targetFile = null;
    
    if (folderListResponse.data.files?.length && folderListResponse.data.files[0].id) {
      const pdfsFolderId = folderListResponse.data.files[0].id;
      console.log(`📁 Found PDFs folder: ${pdfsFolderId}, searching for ${fileName}...`);
      
      const exactSearchQuery = `name='${fileName}' and parents in '${pdfsFolderId}' and trashed=false`;
      const exactSearchResponse = await drive.files.list({
        q: exactSearchQuery,
        fields: 'files(id, name)',
        pageSize: 10
      });
      
      targetFile = exactSearchResponse.data.files?.[0];
      
      if (!targetFile) {
        console.log(`🔍 Exact match failed, trying pattern search for numbered prefixes...`);
        const patternSearchQuery = `name contains '${fileName}' and parents in '${pdfsFolderId}' and trashed=false`;
        const patternSearchResponse = await drive.files.list({
          q: patternSearchQuery,
          fields: 'files(id, name)',
          pageSize: 50
        });
        
        targetFile = patternSearchResponse.data.files?.find(file => {
          const name = file.name || '';
          return name === fileName || name.match(new RegExp(`^\\(\\d+\\)\\s+${fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
        });
        
        if (targetFile) {
          console.log(`✅ Found file with pattern matching: ${targetFile.name}`);
        }
      }
    }
    
    if (!targetFile) {
      console.log(`🔍 PDFs folder search failed, trying project root...`);
      const rootSearchQuery = `name='${fileName}' and parents in '${projectId}' and trashed=false`;
      const rootSearchResponse = await drive.files.list({
        q: rootSearchQuery,
        fields: 'files(id, name)',
        pageSize: 10
      });
      
      targetFile = rootSearchResponse.data.files?.[0];
    }

    if (!targetFile || !targetFile.id) {
      throw new Error(`File ${fileName} not found in Google Drive project ${projectId}`);
    }
    
    console.log(`✅ Found target file: ${targetFile.name} (ID: ${targetFile.id})`);

    console.log(`📥 Downloading original PDF file: ${targetFile.id}`);
    const fileDownloadResponse = await drive.files.get({
      fileId: targetFile.id,
      alt: 'media'
    }, { responseType: 'arraybuffer' });

    const pdfBuffer = Buffer.from(fileDownloadResponse.data as ArrayBuffer);
    
    const tempDir = path.join(process.cwd(), 'tmp', `retry-${uuidv4()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });
    
    const tempPdfPath = path.join(tempDir, 'original.pdf');
    await fs.promises.writeFile(tempPdfPath, pdfBuffer);

    try {
      console.log(`🖼️ Converting page ${pageNumber} to image...`);
      
      const convert = pdf2pic.fromPath(tempPdfPath, {
        density: 600,
        saveFilename: `page_${pageNumber}`,
        savePath: tempDir,
        format: "png",
        width: 2481,
        height: 3507
      });

      const pageImage = await convert(pageNumber, { responseType: "buffer" });
      
      if (!pageImage.buffer) {
        throw new Error(`Failed to convert page ${pageNumber} to image`);
      }

      const pageImagePath = path.join(tempDir, `page_${pageNumber}.png`);
      await fs.promises.writeFile(pageImagePath, pageImage.buffer);

      console.log(`🤖 Processing with ${model} model...`);
      
      const ocrResponse = await geminiOCR(pageImagePath, `${fileName}_page_${pageNumber}`, model);
      
      if (!ocrResponse.text || ocrResponse.error) {
        throw new Error(`OCR processing failed: ${ocrResponse.error || 'No text extracted'}`);
      }

      const processingTime = Date.now() - startTime;
      
      console.log(`📤 Uploading OCR result to Google Drive...`);
      
      const resultText = `OCR Result - Page ${pageNumber}\nModel: ${model}\nProcessed: ${new Date().toISOString()}\n\n${ocrResponse.text}`;
      const resultFileName = `${fileName.replace('.pdf', '')}_page_${pageNumber}_${model.replace('gemini-', '')}_retry.txt`;
      
      console.log(`📤 Uploading OCR result to Google Drive Extracts folder...`);
      
      const extractsFolderQuery = `name='Extracts' and parents in '${projectId}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
      const extractsFolderResponse = await drive.files.list({
        q: extractsFolderQuery,
        fields: 'files(id, name)'
      });

      let extractsFolderId = extractsFolderResponse.data.files?.[0]?.id;
      
      if (!extractsFolderId) {
        const createFolderResponse = await drive.files.create({
          requestBody: {
            name: 'Extracts',
            parents: [projectId],
            mimeType: 'application/vnd.google-apps.folder'
          }
        });
        extractsFolderId = createFolderResponse.data.id!;
        console.log(`📁 Created Extracts folder: ${extractsFolderId}`);
      }

      const uploadResponse = await drive.files.create({
        requestBody: {
          name: resultFileName,
          parents: [extractsFolderId]
        },
        media: {
          mimeType: 'text/plain',
          body: resultText
        }
      });

      const driveId = uploadResponse.data.id || `retry_${pageNumber}_${Date.now()}`;
      console.log(`✅ Successfully uploaded to Google Drive with ID: ${driveId}`);

      const result: PageResult = {
        status: 'success',
        driveId,
        modelUsed: model,
        processingTime,
        textLength: ocrResponse.text.length,
        timestamp: new Date().toISOString()
      };

      console.log(`✅ OCR retry completed successfully for page ${pageNumber}`);
      
      return NextResponse.json({
        success: true,
        ...result
      });

    } finally {
      try {
        await fs.promises.rm(tempDir, { recursive: true });
      } catch (cleanupError) {
        console.warn('⚠️ Failed to clean up temporary files:', cleanupError);
      }
    }

  } catch (error) {
    const authFailure = googleAuthFailure(error);
    if (authFailure) return NextResponse.json(authFailure, { status: 401 });
    console.error('❌ OCR retry failed:', error);
    
    const result: PageResult = {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      modelUsed: model,
      timestamp: new Date().toISOString()
    };

    return NextResponse.json({
      success: false,
      ...result
    }, { status: 500 });
  }
} 