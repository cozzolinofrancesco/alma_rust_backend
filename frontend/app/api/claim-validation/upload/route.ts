import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import formidable from 'formidable';
import { readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { IncomingMessage } from 'http';
import { Readable } from 'stream';
import { uploadToGeminiFilesApi } from '@/app/lib/gemini/uploadToFilesApi';

export const config = { api: { bodyParser: false } };

function generateDocumentId(): string {
  return `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function webRequestToNode(request: Request): Promise<IncomingMessage> {
  const arrayBuffer = await request.arrayBuffer();
  const buffer      = Buffer.from(arrayBuffer);

  const readable = new Readable({
    read() {
      this.push(buffer);
      this.push(null);
    },
  }) as unknown as IncomingMessage;

  readable.headers = Object.fromEntries(request.headers.entries());
  readable.method  = request.method;
  readable.url     = request.url;

  return readable;
}

export async function POST(request: Request) {
  const session = await getApiSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const nodeReq = await webRequestToNode(request);
    const form    = formidable({ maxFileSize: 50 * 1024 * 1024 });

    const [, files] = await form.parse(nodeReq);

    const pdfField = files['pdf'];
    const pdfFile  = Array.isArray(pdfField) ? pdfField[0] : pdfField;

    if (!pdfFile) {
      return NextResponse.json({ error: 'No PDF file provided' }, { status: 400 });
    }

    const mimeType = pdfFile.mimetype ?? 'application/pdf';
    if (!mimeType.includes('pdf')) {
      return NextResponse.json({ error: 'Only PDF files are supported' }, { status: 400 });
    }

    const filename   = pdfFile.originalFilename ?? pdfFile.newFilename ?? 'document.pdf';
    const fileBuffer = await readFile(pdfFile.filepath);

    console.log(`[Upload] Uploading ${filename} (${fileBuffer.byteLength} bytes) to Gemini Files API`);

    const fileUri    = await uploadToGeminiFilesApi(fileBuffer, filename, mimeType);
    const documentId = generateDocumentId();

    try {
      await writeFile(path.join(tmpdir(), `cv_split_${documentId}.pdf`), fileBuffer);
    } catch (cacheErr) {
      console.warn('[Upload] Could not cache PDF for splitting:', cacheErr);
    }

    console.log(`[Upload] Success – fileUri=${fileUri} documentId=${documentId}`);

    return NextResponse.json({
      fileUri,
      filename,
      mimeType,
      document_id: documentId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Upload failed';
    console.error('[Upload] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
