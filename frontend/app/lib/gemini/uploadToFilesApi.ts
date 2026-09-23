
import { fetchWithTimeout } from '../fetchWithTimeout';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_BASE_URL =
  process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

export async function uploadToGeminiFilesApi(
  fileBuffer: Buffer,
  filename: string,
  mimeType: string
): Promise<string> {
  const initRes = await fetchWithTimeout(
    `${GEMINI_BASE_URL}/upload/v1beta/files?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol':            'resumable',
        'X-Goog-Upload-Command':             'start',
        'X-Goog-Upload-Header-Content-Length': String(fileBuffer.byteLength),
        'X-Goog-Upload-Header-Content-Type':   mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: filename } }),
    }
  );

  if (!initRes.ok) {
    const err = await initRes.text().catch(() => 'unknown');
    throw new Error(`Gemini Files API init failed: ${initRes.status} – ${err}`);
  }

  const uploadUrl = initRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error('Gemini Files API did not return an upload URL');
  }

  const uploadRes = await fetchWithTimeout(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length':        String(fileBuffer.byteLength),
      'X-Goog-Upload-Offset':  '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: fileBuffer,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text().catch(() => 'unknown');
    throw new Error(`Gemini Files API upload failed: ${uploadRes.status} – ${err}`);
  }

  const fileData = (await uploadRes.json()) as { file?: { uri?: string } };
  const fileUri = fileData?.file?.uri;

  if (!fileUri) {
    throw new Error('Gemini Files API did not return a file URI');
  }

  return fileUri;
}
