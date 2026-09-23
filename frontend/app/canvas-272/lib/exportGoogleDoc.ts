
import type { StructuredDoc } from './exportFormatter';

export interface GoogleDocExportResult {
  id: string;
  webViewLink: string | null;
  name: string;
}

export async function exportStructuredDocToGoogleDoc(doc: StructuredDoc): Promise<GoogleDocExportResult> {
  const response = await fetch('/api/docs/create-from-structured', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ doc }),
  });

  if (!response.ok) {
    const err = (await response.json().catch(() => ({}))) as { error?: string; details?: string };
    throw new Error(err?.details || err?.error || `Google Doc export failed (HTTP ${response.status})`);
  }

  const data = (await response.json()) as {
    document: { id: string; webViewLink: string | null; name: string };
  };
  return data.document;
}
