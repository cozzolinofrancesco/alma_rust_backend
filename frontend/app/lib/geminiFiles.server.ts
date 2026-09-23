import path from 'node:path';
import { DEFAULT_API_TIMEOUT_MS } from './modelConfig';

export function inferGeminiMimeType(filename: string): string {
  const types: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
    '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.tiff': 'image/tiff', '.tif': 'image/tiff', '.pdf': 'application/pdf',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  };
  return types[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

function providerUrl(value: string, file = false): URL {
  const base = new URL(process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com');
  const url = new URL(value);
  if (url.origin !== base.origin || url.username || url.password || (file && !/^\/v1beta\/files\/[a-zA-Z0-9_-]+$/.test(url.pathname))) throw new Error('Invalid temporary provider file URL.');
  return url;
}

export async function deleteGeminiFile(uri: string): Promise<void> {
  const url = providerUrl(uri, true);
  url.searchParams.set('key', process.env.GEMINI_API_KEY ?? '');
  const response = await fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(10000), redirect: 'error' });
  await response.body?.cancel();
  if (!response.ok && response.status !== 404) throw new Error('Temporary provider file cleanup failed.');
}

export async function uploadFileToGeminiFilesAPI(file: File, signal?: AbortSignal): Promise<string> {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(DEFAULT_API_TIMEOUT_MS)]) : AbortSignal.timeout(DEFAULT_API_TIMEOUT_MS);
  requestSignal.throwIfAborted();
  const initUrl = new URL('/upload/v1beta/files', process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com');
  initUrl.searchParams.set('key', process.env.GEMINI_API_KEY ?? '');
  const initialized = await fetch(initUrl, {
    method: 'POST', signal: requestSignal, redirect: 'error',
    headers: { 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(file.size),
      'X-Goog-Upload-Header-Content-Type': file.type || inferGeminiMimeType(file.name), 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: { display_name: file.name } }),
  });
  if (!initialized.ok) {
    await initialized.body?.cancel();
    throw new Error(`Temporary file initialization failed (HTTP ${initialized.status}).`);
  }
  const target = initialized.headers.get('X-Goog-Upload-Url');
  await initialized.body?.cancel();
  if (!target) throw new Error('The provider did not return an upload URL.');
  const uploaded = await fetch(providerUrl(target), {
    method: 'POST', signal: requestSignal, redirect: 'error',
    headers: { 'Content-Length': String(file.size), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: Buffer.from(await file.arrayBuffer()),
  });
  if (!uploaded.ok) {
    await uploaded.body?.cancel();
    throw new Error(`Temporary file upload failed (HTTP ${uploaded.status}).`);
  }
  const result = await uploaded.json() as { file?: { uri?: unknown } };
  if (typeof result.file?.uri !== 'string') throw new Error('The provider did not return a temporary file URI.');
  return providerUrl(result.file.uri, true).toString();
}