import type { SelectableDoc } from './metadataFilter';

// Client helper: fetch a corpus's selectable documents (each with the stable
// `fileId`, 2026-07+) so a subset selection can be resolved to a `file_id`
// metadata filter. Returns [] on any failure so callers can safely fall back to
// searching the whole corpus rather than sending a dead pdf_name filter.
export async function fetchCorpusDocsForFilter(corpusId: string): Promise<SelectableDoc[]> {
  try {
    const r = await fetch(`/api/rag/corpora/${corpusId}/documents`, { credentials: 'include' });
    if (!r.ok) return [];
    const data = (await r.json()) as { documents?: SelectableDoc[] };
    return data.documents ?? [];
  } catch {
    return [];
  }
}
