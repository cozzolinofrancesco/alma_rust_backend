import fs from 'fs/promises';
import fetch from 'node-fetch';
import path from 'path';
import { DEFAULT_MODEL, DEFAULT_API_TIMEOUT_MS, GEMINI_MODELS } from './modelConfig';
import { GoogleGenerativeAI } from '@google/generative-ai';

interface GeminiFileResponse {
  file: {
    uri: string;
    name: string;
  };
}

interface GeminiGenerateResponse {
  candidates?: {
    content?: {
      parts?: {
        text?: string;
      }[];
    };
  }[];
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://gemini.example/api';


const _genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

const DEFAULT_GENERATION_CONFIG = {
  maxOutputTokens: 65535,
  temperature: 0.1,
  topP: 0.95,
  topK: 20,
  candidateCount: 1,
  presencePenalty: 0.0,
  frequencyPenalty: 0.0,
};

export async function geminiOCR(
  filePath: string,
  displayName?: string,
  model: string = DEFAULT_MODEL,
): Promise<{ text: string | null; error?: string }> {
  console.log('🚀 Starting geminiOCR');
  console.log(`📁 File: ${filePath}`);
  console.log(`🚀 Using model: ${model} (default: ${DEFAULT_MODEL})`);
  try {
    displayName = displayName || path.basename(filePath);
    console.log(`🔖 Display Name: ${displayName}`);

    console.log('🔄 ► Uploading file to Gemini …');
    const { fileUri, fileName } = await uploadFileToGemini(filePath, displayName);
    if (!fileUri || !fileName) {
      throw new Error('❌ Gemini upload failed: Missing file URI or file name.');
    }
    console.log('✅ Upload complete:', { fileUri, fileName });

    const requestData = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Extract the text and format it in LaTeX.' },
            {
              fileData: {
                mimeType: 'image/png',
                fileUri,
              },
            },
          ],
        },
      ],
      generationConfig: DEFAULT_GENERATION_CONFIG,
      systemInstruction: {
        role: 'system',
        parts: [{ text: 'Extract all text and format in LaTeX. Return as plain text.' }],
      },
    };

    console.log('📝 Generation request data:', JSON.stringify(requestData, null, 2));
    console.log(`🚀 ► Sending to model "${model}" …`);
    const content = await generateContent(requestData, model);
    console.log('✅ Generation response content:', content);
    console.log(`📊 Content length: ${content ? content.length : 0} characters`);

    console.log('🗑️ ► Deleting uploaded file …');
    await deleteGeminiFile(fileName);
    console.log('✅ File deletion done');

    console.log('🏁 geminiOCR complete');
    return { text: content };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error('💥 geminiOCR error:', errorMsg);
    return { text: null, error: errorMsg };
  }
}

async function uploadFileToGemini(
  filePath: string,
  displayName: string
): Promise<{ fileUri: string | null; fileName: string | null }> {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📦 uploadFileToGemini start');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    console.log('🔍 ► Checking file stats …');
    const fileStat = await fs.stat(filePath);
    const numBytes = fileStat.size;
    console.log(`📐 File size: ${numBytes} bytes`);

    const uploadInitUrl = `${GEMINI_BASE_URL}/upload/v1beta/files?key=${GEMINI_API_KEY}`;
    console.log(`🔄 ► INIT upload at: ${uploadInitUrl}`);
    const initRes = await fetch(uploadInitUrl, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(numBytes),
        'X-Goog-Upload-Header-Content-Type': 'image/png',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
    });
    console.log(`📶 INIT response status: ${initRes.status}`);

    if (!initRes.ok) {
      const body = await initRes.text();
      throw new Error(`❌ Upload init failed: ${body}`);
    }

    const uploadUrl = initRes.headers.get('X-Goog-Upload-Url')!;
    console.log('🔗 Resumable upload URL:', uploadUrl);

    console.log('📤 ► Uploading file bytes …');
    const fileBuffer = await fs.readFile(filePath);
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': String(numBytes),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: fileBuffer,
    });
    console.log(`📶 UPLOAD response status: ${uploadRes.status}`);

    if (!uploadRes.ok) {
      const body = await uploadRes.text();
      throw new Error(`❌ File upload failed: ${body}`);
    }

    const jsonData = (await uploadRes.json()) as GeminiFileResponse;
    console.log('✅ Uploaded file metadata');

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📦 uploadFileToGemini end');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return { fileUri: jsonData.file.uri, fileName: jsonData.file.name };
  } catch (err) {
    console.error('💥 uploadFileToGemini error:', err);
    return { fileUri: null, fileName: null };
  }
}

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: { parts?: { text?: string }[] };
  }>;
}

async function generateContent(
  data: unknown,
  model: string
): Promise<string | null> {
  const fallbackModel = GEMINI_MODELS.flash;
  const maxAttempts = 3;
  let attempt = 0;

  while (attempt < maxAttempts) {
    const currentModel = attempt === 0 ? model : fallbackModel;
    console.log(`🤖 generateContent using model "${currentModel}" (attempt ${attempt + 1})`);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        console.log(`⏰ Request timeout for model "${currentModel}"`);
        controller.abort();
      }, DEFAULT_API_TIMEOUT_MS);

      try {
        console.log(`📡 Making API request to Gemini for model "${currentModel}"...`);
        const startTime = Date.now();
        
        const res = await fetch(
          `${GEMINI_BASE_URL}/v1beta/models/${encodeURIComponent(currentModel)}:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
            signal: controller.signal
          }
        );

        const requestTime = Date.now() - startTime;
        console.log(`📈 API response received in ${requestTime}ms (status: ${res.status})`);

        if (!res.ok) {
          const errBody = await res.text();
          throw new Error(`HTTP ${res.status}: ${errBody}`);
        }

        console.log(`🔄 Parsing JSON response...`);
        const body = (await res.json()) as GeminiGenerateResponse;
        const text = body.candidates?.[0]?.content?.parts?.[0]?.text ?? null;

        if (!text) {
          console.error(
            `⚠️ No text returned on model "${currentModel}". Full response:\n`,
            JSON.stringify(body, null, 2)
          );
          throw new Error("Empty text part from model");
        }

        console.log(`✅ Text extraction successful: ${text.length} characters`);
        return text;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      const errorType = isTimeout ? 'TIMEOUT' : 'ERROR';
      console.error(`${errorType} on attempt ${attempt + 1}: ${err}`);
      attempt++;
      if (attempt >= maxAttempts) {
        console.log("❌ All attempts failed");
        return null;
      }
      console.log(`🔄 Retrying with "${fallbackModel}"`);
    }
  }

  return null;
}

async function deleteGeminiFile(fileName: string) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚮 deleteGeminiFile start');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    const safeName = fileName.replace(/^files\//, '');
    const deleteUrl = `${GEMINI_BASE_URL}/v1beta/files/${safeName}?key=${GEMINI_API_KEY}`;
    console.log('🔄 ► DELETE at:', deleteUrl);
    const res = await fetch(deleteUrl, { method: 'DELETE' });
    console.log(`📶 DELETE response status: ${res.status}`);
  } catch (err) {
    console.warn('⚠️ deleteGeminiFile warning:', err);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚮 deleteGeminiFile end');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}
