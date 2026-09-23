import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import type { Session } from '@/app/lib/authOptions';
import { google } from 'googleapis';
import { writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createRefreshableAuth } from '@/app/lib/rag/auth';
import { uploadToGeminiFilesApi } from '@/app/lib/gemini/uploadToFilesApi';

function generateDocumentId(): string {
  return `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function POST(request: Request) {
  const session = (await getApiSession(request)) as Session | null;
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { fileId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { fileId } = body;
  if (!fileId || typeof fileId !== 'string') {
    return NextResponse.json({ error: 'fileId is required' }, { status: 400 });
  }

  const auth = createRefreshableAuth(
    session.accessToken,
    session.refreshToken ?? undefined,
  );
  const drive = google.drive({ version: 'v3', auth });

  try {
    const meta = await drive.files.get({
      fileId,
      fields: 'id, name, mimeType',
      supportsAllDrives: true,
    });

    const filename = meta.data.name ?? 'document.pdf';
    const mimeType = meta.data.mimeType ?? 'application/pdf';

    console.log(`[drive-register] Downloading "${filename}" (${fileId}) from Drive…`);
    const downloadRes = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );

    const fileBuffer = Buffer.from(downloadRes.data as ArrayBuffer);
    console.log(`[drive-register] Downloaded ${fileBuffer.byteLength} bytes`);

    const documentId    = generateDocumentId();
    const geminiFileUri = await uploadToGeminiFilesApi(fileBuffer, filename, mimeType);
    console.log(`[drive-register] Uploaded to Gemini Files API: ${geminiFileUri}`);

    try {
      await writeFile(path.join(tmpdir(), `cv_split_${documentId}.pdf`), fileBuffer);
    } catch (cacheErr) {
      console.warn('[drive-register] Could not cache PDF for splitting:', cacheErr);
    }

    return NextResponse.json({
      fileUri:     geminiFileUri,
      filename,
      mimeType,
      document_id: documentId,
      source:      'gdrive',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to register Drive file';
    console.error('[drive-register]', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
