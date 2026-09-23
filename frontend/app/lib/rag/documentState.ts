// Shared normaliser for Gemini File Search document indexing state. The REST API
// returns `state` as either an enum string (ACTIVE/PROCESSING/FAILED/STATE_*) or
// a numeric code ('1' active, '3' failed). Anything not clearly active/failed is
// treated as still processing. Used by the corpus documents route and by the RAG
// optimizer, which must wait for ACTIVE before querying a freshly built store.
export type DocumentState = 'ACTIVE' | 'PROCESSING' | 'FAILED';

export function normaliseDocumentState(raw: string | undefined): DocumentState {
  if (!raw) return 'ACTIVE';
  const upper = String(raw).toUpperCase();
  if (upper === 'ACTIVE' || upper === 'STATE_ACTIVE' || raw === '1') return 'ACTIVE';
  if (upper === 'FAILED' || upper === 'STATE_FAILED' || raw === '3') return 'FAILED';
  return 'PROCESSING';
}

// Aggregate many per-chunk states into one: any FAILED → FAILED; all ACTIVE →
// ACTIVE; otherwise PROCESSING.
export function aggregateDocumentStates(states: DocumentState[]): DocumentState {
  if (states.length === 0) return 'PROCESSING';
  if (states.some((s) => s === 'FAILED')) return 'FAILED';
  if (states.every((s) => s === 'ACTIVE')) return 'ACTIVE';
  return 'PROCESSING';
}
