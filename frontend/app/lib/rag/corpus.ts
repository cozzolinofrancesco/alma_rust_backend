import type { OAuth2Client } from 'googleapis-common';
import { CorpusEntry, CorpusFile } from './types';
import { fetchWithTimeout } from '@/app/lib/fetchWithTimeout';
import { downloadFileStream, getFolderMetadata } from './drive';
import { createWriteStream } from 'fs';
import { unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { addOrUpdateCorpus, loadRegistry } from './registry';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

function generateCorpusName(folderId: string): string {
  const normalized = folderId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `corpora/folder-${normalized}`;
}

async function getOrCreateGeminiCorpus(
  folderId: string,
  displayName: string
): Promise<string> {
  const corpusName = generateCorpusName(folderId);

  try {
    const checkUrl = `${GEMINI_BASE_URL}/v1beta/${corpusName}?key=${GEMINI_API_KEY}`;
    const checkResponse = await fetchWithTimeout(checkUrl, { method: 'GET' });

    if (checkResponse.ok) {
      console.log(`✅ [Corpus] Using existing corpus: ${corpusName}`);
      return corpusName;
    }
  } catch (error) {
    console.log(`⚠️ [Corpus] Corpus check failed, will create new: ${error}`);
  }

  try {
    const createUrl = `${GEMINI_BASE_URL}/v1beta/corpora?key=${GEMINI_API_KEY}`;
    const createResponse = await fetchWithTimeout(createUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: corpusName,
        displayName: displayName,
      }),
    });

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      throw new Error(`Failed to create corpus: ${errorText}`);
    }

    const result = await createResponse.json();
    console.log(`✅ [Corpus] Created new corpus: ${result.name}`);
    return result.name;
  } catch (error) {
    console.error('❌ [Corpus] Failed to create corpus:', error);
    throw error;
  }
}

async function addFileToCorpusAsDocument(
  corpusName: string,
  fileUri: string,
  displayName: string
): Promise<void> {
  console.log(`📄 [Ingest] Adding file as document to corpus: ${displayName}`);

  const url = `${GEMINI_BASE_URL}/v1beta/${corpusName}/documents?key=${GEMINI_API_KEY}`;
  
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      display_name: displayName,
      custom_metadata: [
        {
          key: 'source_file_uri',
          string_value: fileUri
        },
        {
          key: 'source',
          string_value: 'google_drive'
        }
      ]
    }),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`❌ [Ingest] Failed to add document to corpus:`, errorText);
    
    console.warn(
      `⚠️ [Ingest] Known Issue: Gemini Semantic Retrieval doesn't support direct file->corpus linking.\n` +
      `Files uploaded via Files API cannot be automatically added to corpus.\n` +
      `This requires text extraction, which defeats the purpose of streaming large files.\n` +
      `File URI: ${fileUri}`
    );
    
    throw new Error(`Failed to add document to corpus: ${errorText}`);
  }
  
  const result = await response.json();
  console.log(`✅ [Ingest] Document created in corpus: ${result.name}`);
}

async function uploadDriveFileToGemini(
  fileId: string,
  fileName: string,
  mimeType: string,
  auth: OAuth2Client
): Promise<string> {
  console.log(`📤 [Ingest] Starting upload: ${fileName}`);

  const tempPath = join(tmpdir(), `gemini-rag-${Date.now()}-${fileName}`);

  try {
    const { stream: driveStream, mimeType: downloadedMimeType } = await downloadFileStream(fileId, auth, mimeType);
    const writeStream = createWriteStream(tempPath);
    await pipeline(driveStream as NodeJS.ReadableStream, writeStream);

    console.log(`💾 [Ingest] Downloaded to temp: ${tempPath}`);

    const fs = await import('fs/promises');
    const stats = await fs.stat(tempPath);
    const fileSize = stats.size;

    console.log(`📊 [Ingest] File size: ${fileSize} bytes`);

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
        file: {
          display_name: fileName,
        },
      }),
    });

    if (!initResponse.ok) {
      const errorText = await initResponse.text();
      throw new Error(`Upload init failed: ${errorText}`);
    }

    const uploadUrl = initResponse.headers.get('X-Goog-Upload-Url');
    if (!uploadUrl) {
      throw new Error('No upload URL in response');
    }

    console.log(`🔗 [Ingest] Got upload URL`);

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
      const errorText = await uploadResponse.text();
      throw new Error(`File upload failed: ${errorText}`);
    }

    const uploadResult = await uploadResponse.json();
    console.log(`✅ [Ingest] Upload complete: ${uploadResult.file.uri}`);

    return uploadResult.file.uri;
  } finally {
    try {
      await unlink(tempPath);
    } catch (error) {
      console.warn(`⚠️ [Ingest] Failed to clean up temp file: ${error}`);
    }
  }
}

export async function createCorpusFromDrive(
  folderId: string,
  displayName: string,
  selectedFileIds: string[],
  files: Array<{ id: string; name: string; mimeType: string; size: number }>,
  auth: OAuth2Client
): Promise<CorpusEntry> {
  console.log(`🚀 [Corpus] Creating corpus "${displayName}" from folder ${folderId}`);

  const folderMetadata = await getFolderMetadata(folderId, auth);

  const corpusName = await getOrCreateGeminiCorpus(folderId, displayName);

  const entry: CorpusEntry = {
    id: `corpus-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    corpusId: corpusName,
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
      const fileUri = await uploadDriveFileToGemini(
        file.id,
        file.name,
        file.mimeType,
        auth
      );

      await addFileToCorpusAsDocument(corpusName, fileUri, file.name);

      corpusFile.status = 'indexed';
      corpusFile.geminiFileUri = fileUri;
      corpusFile.indexedAt = new Date().toISOString();

      console.log(`✅ [Corpus] File indexed: ${file.name}`);
    } catch (error) {
      console.error(`❌ [Corpus] Failed to index ${file.name}:`, error);
      corpusFile.status = 'error';
      corpusFile.error = error instanceof Error ? error.message : 'Unknown error';
    }

    await addOrUpdateCorpus(entry, auth);
  }

  entry.updatedAt = new Date().toISOString();
  await addOrUpdateCorpus(entry, auth);

  console.log(`🎉 [Corpus] Corpus creation complete: ${entry.id}`);
  return entry;
}

export async function listUserCorpora(auth: OAuth2Client): Promise<CorpusEntry[]> {
  const registry = await loadRegistry(auth);
  return registry.corpora;
}

export async function queryCorpus(
  corpusId: string,
  corpusName: string,
  messages: Array<{ role: string; text: string }>,
  systemInstruction?: string
): Promise<{ response: string; metadata?: Record<string, unknown> }> {
  console.log(`🔍 [Query] Querying corpus: ${corpusName}`);
  console.log(`📝 [Query] Messages: ${messages.length}`);
  console.log(`📚 [Query] System instruction: ${systemInstruction ? 'Yes' : 'No'}`);

  if (!messages || messages.length === 0) {
    throw new Error('No messages provided for query');
  }

  const userQuestion = messages[messages.length - 1].text;

  const conversationContext = messages
    .slice(-3)
    .map(m => `${m.role}: ${m.text}`)
    .join('\n');

  const requestBody: Record<string, unknown> = {
    contents: [{
      parts: [{ text: userQuestion }],
    }],
    answer_style: 'VERBOSE',
    semantic_retriever: {
      source: corpusName,
      query: {
        parts: [{ text: conversationContext }],
      }
    },
  };

  if (systemInstruction) {
    console.warn(`⚠️ [Query] System instruction provided but not directly supported by aqa model`);
    console.warn(`💡 [Query] Consider including instructions in your query text instead`);
  }

  try {
    const url = `${GEMINI_BASE_URL}/v1beta/models/aqa:generateAnswer?key=${GEMINI_API_KEY}`;
    
    console.log(`📡 [Query] Sending request to Gemini generateAnswer API`);
    console.log(`🎯 [Query] Corpus: ${corpusName}`);
    console.log(`🔍 [Query] Query text: "${userQuestion.substring(0, 100)}..."`);
    
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ [Query] API Error (${response.status}):`, errorText);
      
      if (errorText.includes('No passages found')) {
        throw new Error(
          `No relevant information found in the corpus. This usually means:\n` +
          `1. The corpus is empty (no documents have been added)\n` +
          `2. Your query doesn't match any content in the corpus\n` +
          `3. The documents are still being indexed (try again in a few minutes)\n\n` +
          `Corpus: ${corpusName}`
        );
      }
      
      if (errorText.includes('corpus or document name format')) {
        throw new Error(
          `Invalid corpus format. The corpus resource name may be incorrect.\n` +
          `Expected format: corpora/folder-xxxxx\n` +
          `Received: ${corpusName}`
        );
      }
      
      throw new Error(`Corpus query failed (${response.status}): ${errorText}`);
    }

    const result = await response.json();
    const text = result.answer?.content?.parts?.[0]?.text || '';
    const answerableProbability = result.answerableProbability || 0;

    console.log(`✅ [Query] Response generated (${text.length} chars)`);
    console.log(`🎯 [Query] Answerable probability: ${answerableProbability}`);
    console.log(`📊 [Query] Used corpus: ${corpusName}`);

    if (result.groundingAttributions) {
      console.log(`📚 [Query] Grounded in ${result.groundingAttributions.length} sources`);
    }

    return {
      response: text,
      metadata: {
        corpusId,
        corpusName,
        model: 'aqa',
        answerableProbability,
        groundingAttributions: result.groundingAttributions,
        method: 'semantic_retrieval',
        systemInstruction: systemInstruction || null,
      },
    };
  } catch (error) {
    console.error('❌ [Query] Failed:', error);
    if (error instanceof Error) {
      console.error('❌ [Query] Error message:', error.message);
    }
    throw error;
  }
}
