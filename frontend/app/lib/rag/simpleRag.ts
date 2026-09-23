
import type { OAuth2Client } from 'googleapis-common';
import { downloadFileStream, getFolderMetadata } from './drive';
import { addOrUpdateCorpus, loadRegistry } from './registry';
import { CorpusEntry, CorpusFile } from './types';
import { GEMINI_MODELS } from '@/app/lib/modelConfig';
import { fetchWithTimeout } from '@/app/lib/fetchWithTimeout';
import { createWriteStream } from 'fs';
import { unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

const SIMPLE_RAG_MODEL = GEMINI_MODELS.flash;

async function uploadFileToGemini(
  fileId: string,
  fileName: string,
  mimeType: string,
  auth: OAuth2Client
): Promise<string> {
  console.log(`📤 [SimpleRAG] Uploading: ${fileName}`);

  const tempPath = join(tmpdir(), `gemini-simple-${Date.now()}-${fileName}`);

  try {
    const { stream: driveStream, mimeType: downloadedMimeType } = await downloadFileStream(fileId, auth, mimeType);
    const writeStream = createWriteStream(tempPath);
    await pipeline(driveStream as NodeJS.ReadableStream, writeStream);

    const fs = await import('fs/promises');
    const stats = await fs.stat(tempPath);
    const fileSize = stats.size;

    console.log(`📊 [SimpleRAG] Size: ${fileSize} bytes`);

    const uploadInitUrl = `${GEMINI_BASE_URL}/upload/v1beta/files?key=${GEMINI_API_KEY}`;
    const initResponse = await fetchWithTimeout(uploadInitUrl, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(fileSize),
        'X-Goog-Upload-Header-Content-Type': downloadedMimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        file: { display_name: fileName },
      }),
    });

    if (!initResponse.ok) {
      throw new Error(`Upload init failed: ${await initResponse.text()}`);
    }

    const uploadUrl = initResponse.headers.get('X-Goog-Upload-Url');
    if (!uploadUrl) throw new Error('No upload URL');

    const fileBuffer = await fs.readFile(tempPath);
    const uploadResponse = await fetchWithTimeout(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': String(fileSize),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: fileBuffer,
    });

    if (!uploadResponse.ok) {
      throw new Error(`Upload failed: ${await uploadResponse.text()}`);
    }

    const result = await uploadResponse.json();
    console.log(`✅ [SimpleRAG] Uploaded: ${result.file.name}`);

    return result.file.name;
  } finally {
    try {
      await unlink(tempPath);
    } catch (error) {
      console.warn(`⚠️ [SimpleRAG] Cleanup failed: ${error}`);
    }
  }
}

export async function createSimpleRagFromDrive(
  folderId: string,
  displayName: string,
  selectedFileIds: string[],
  files: Array<{ id: string; name: string; mimeType: string; size: number }>,
  auth: OAuth2Client
): Promise<CorpusEntry> {
  console.log(`🚀 [SimpleRAG] Creating RAG collection: ${displayName}`);

  const folderMetadata = await getFolderMetadata(folderId, auth);

  const entry: CorpusEntry = {
    id: `simple-rag-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    corpusId: `simple-rag-${folderId}`,
    displayName,
    source: {
      type: 'drive_folder',
      folderId,
      folderName: folderMetadata.name,
      ownerEmail: folderMetadata.owners?.[0]?.emailAddress,
    },
    files: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const selectedFiles = files.filter((f) => selectedFileIds.includes(f.id));

  for (const file of selectedFiles) {
    const corpusFile: CorpusFile = {
      fileId: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      status: 'indexing',
    };

    entry.files.push(corpusFile);

    try {
      const geminiFileName = await uploadFileToGemini(
        file.id,
        file.name,
        file.mimeType,
        auth
      );

      corpusFile.status = 'indexed';
      corpusFile.geminiFileUri = geminiFileName;
      corpusFile.indexedAt = new Date().toISOString();

      console.log(`✅ [SimpleRAG] Ready: ${file.name}`);
    } catch (error) {
      console.error(`❌ [SimpleRAG] Failed: ${file.name}`, error);
      corpusFile.status = 'error';
      corpusFile.error = error instanceof Error ? error.message : 'Unknown error';
    }

    await addOrUpdateCorpus(entry, auth);
  }

  entry.updatedAt = new Date().toISOString();
  await addOrUpdateCorpus(entry, auth);

  console.log(`🎉 [SimpleRAG] Done: ${entry.id}`);
  return entry;
}

export async function querySimpleRag(
  ragId: string,
  fileUris: string[],
  messages: Array<{ role: string; text: string }>,
  systemInstruction?: string
): Promise<{ response: string; metadata?: Record<string, unknown> }> {
  console.log(`🔍 [SimpleRAG] Querying with ${fileUris.length} files`);

  if (!messages || messages.length === 0) {
    throw new Error('No messages provided');
  }

  const contents = messages.map((msg, idx) => {
    const parts: Array<{ text?: string; file_data?: { file_uri: string } }> = [
      { text: msg.text }
    ];

    if (idx === 0 && msg.role === 'user') {
      fileUris.forEach(uri => {
        parts.push({
          file_data: {
            file_uri: uri
          }
        });
      });
    }

    return {
      role: msg.role === 'user' ? 'user' : 'model',
      parts,
    };
  });

  const requestBody: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: 0.1,
      topP: 0.95,
      topK: 20,
    },
  };

  if (systemInstruction) {
    requestBody.systemInstruction = {
      parts: [{ text: systemInstruction }],
    };
  }

  try {
    const url = `${GEMINI_BASE_URL}/v1beta/models/${SIMPLE_RAG_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    console.log(`📡 [SimpleRAG] Sending to Gemini...`);

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ [SimpleRAG] Error: ${errorText}`);
      throw new Error(`Query failed: ${errorText}`);
    }

    const result = await response.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text || '';

    console.log(`✅ [SimpleRAG] Got response (${text.length} chars)`);

    return {
      response: text,
      metadata: {
        ragId,
        fileCount: fileUris.length,
        model: SIMPLE_RAG_MODEL,
      },
    };
  } catch (error) {
    console.error(`❌ [SimpleRAG] Query failed:`, error);
    throw error;
  }
}

export async function listSimpleRags(auth: OAuth2Client): Promise<CorpusEntry[]> {
  const registry = await loadRegistry(auth);
  return registry.corpora;
}

