// Client wrappers for the agent step QC backend (`/api/ai-agents/step-qc`).
// QC extracts verifiable claims from a step's answer and verifies each against
// a linked corpus. Keep `QcRow`/`QcStatus` in sync with the route's exported
// shape in `app/api/ai-agents/step-qc/route.ts`.

export type QcStatus =
  | 'MATCHING'
  | 'PARTIALLY_MATCHING'
  | 'NOT_MATCHING'
  | 'SOURCE_NOT_FOUND'
  | 'PENDING';

export interface QcRow {
  claim: string;
  status: QcStatus;
  action: string;
  ragLocation: string | null;
  rationale: string;
  sourceDoc: string;
}

export type QcPhase = 'idle' | 'extracting' | 'selecting' | 'verifying' | 'done';

const QC_ENDPOINT = '/api/ai-agents/step-qc';

// Extract verifiable claims from the produced answer. `noClaims` is true when the
// answer contained nothing to verify (distinct from an empty array on error).
export async function extractClaims(
  corpusId: string,
  generatedText: string,
): Promise<{ claims: string[]; noClaims: boolean }> {
  const res = await fetch(QC_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ mode: 'extract', corpusId, generatedText }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `HTTP ${res.status}`);
  }
  const data = (await res.json()) as { claims?: string[]; message?: string };
  const claims = (data.claims ?? []).filter(Boolean);
  return { claims, noClaims: data.message === 'no_claims_found' || claims.length === 0 };
}

// Verify the given claims against the corpus, invoking `onRow` for each verified
// claim as the NDJSON stream arrives. Resolves on `done`; throws on `error`.
export async function verifyClaims(
  corpusId: string,
  claims: string[],
  onRow: (row: QcRow) => void,
): Promise<void> {
  const res = await fetch(QC_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ mode: 'verify', corpusId, claims }),
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const event = JSON.parse(trimmed) as
        | { type: 'row'; row: QcRow }
        | { type: 'done' }
        | { type: 'error'; error: string };
      if (event.type === 'row') {
        onRow(event.row);
      } else if (event.type === 'error') {
        throw new Error(event.error);
      }
    }
  }
}
