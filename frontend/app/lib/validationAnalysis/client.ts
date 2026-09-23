import type { z } from 'zod';
import type { analysisRequestSchema } from './schema';

export async function requestValidationAnalysis<Result>(payload: z.input<typeof analysisRequestSchema>, file?: File): Promise<Result> {
  let body: FormData | string;
  if (file) {
    if (file.size > 30 * 1024 * 1024) throw new Error('Analysis uploads must not exceed 30 MB.');
    const upload = file.type ? file : new File([file], file.name, { type: 'application/pdf' });
    const digest = await crypto.subtle.digest('SHA-256', await upload.arrayBuffer());
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    body = new FormData();
    body.set('payload', JSON.stringify({ ...payload, sources: [{ sourceId: 'document', kind: 'upload', name: upload.name, mimeType: upload.type, sha256 }] }));
    body.set('file:document', upload);
  } else {
    body = JSON.stringify(payload);
  }
  const response = await fetch('/api/validation/analysis', {
    method: 'POST', credentials: 'include', headers: file ? undefined : { 'Content-Type': 'application/json' }, body,
  });
  const result = await response.json() as { data?: Result; error?: string | { message?: string } };
  if (!response.ok || result.data === undefined) {
    throw new Error(typeof result.error === 'string' ? result.error : result.error?.message ?? `Analysis failed (${response.status}).`);
  }
  return result.data;
}