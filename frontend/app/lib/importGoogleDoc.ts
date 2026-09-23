// Fetch the plain text of a Google Doc from its share URL via the server
// importer (mirrors exportGoogleDoc.ts in shape). The server uses the user's
// Drive credentials, so only docs the user can access are importable.
export async function importGoogleDocText(url: string): Promise<string> {
  const response = await fetch('/api/docs/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    const err = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(err?.error || `Google Doc import failed (HTTP ${response.status})`);
  }

  const data = (await response.json()) as { text: string };
  return data.text ?? '';
}
