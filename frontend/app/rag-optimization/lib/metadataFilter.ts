// AIP-160 metadata-filter builders for Gemini File Search `metadata_filter`.
// Filters are now user-defined expressions (FilterSpec.expr); these builders back
// the UI quick-add buttons and validate LLM-generated filters.

// Escape a value for an AIP-160 double-quoted string literal.
export function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function buildPdfNameFilter(names: readonly string[]): string | undefined {
  const clauses = names.filter(Boolean).map((n) => `pdf_name = "${escapeFilterValue(n)}"`);
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(' OR ')})`;
}

// Filter on the stable `file_id` custom metadata (2026-07+). Immune to the
// filename/chunk-name mismatch that makes pdf_name filters silently return 0 chunks.
export function buildFileIdFilter(ids: readonly string[]): string | undefined {
  const clauses = ids.filter(Boolean).map((id) => `file_id = "${escapeFilterValue(id)}"`);
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(' OR ')})`;
}

// Normalize a document name for tolerant matching: drop a page-range chunk suffix
// (`<base>_p0-300.pdf`), drop the `.pdf` extension, lowercase + trim. Reconciles
// legacy saved selections (which may carry the old chunk name) against live docs.
export function normalizeDocName(name: string): string {
  return name
    .trim()
    .replace(/_p\d+-\d+\.pdf$/i, '')
    .replace(/\.pdf$/i, '')
    .toLowerCase();
}

export interface SelectableDoc {
  fileId: string | null;
  pdfName: string;
}

export type SubsetFilterAction = 'apply' | 'search-all' | 'block';
export interface SubsetFilterResult {
  filter?: string;
  action: SubsetFilterAction;
  reason?: string;
}

// Decide the query-time metadata_filter for a document-subset selection, shared by
// every run path (form + graph). Prefers the stable file_id; falls back to pdf_name
// (with tolerant name matching) for pre-file_id corpora. `selected` values may be
// fileIds (new) or legacy pdfName strings — both resolve against `allDocs`.
//   search-all -> no filter (empty selection, or the selection covers every doc)
//   block      -> selection matches nothing in this corpus (fast, actionable fail)
//   apply      -> a real subset filter (file_id preferred, else pdf_name)
export function resolveSubsetFilter(
  selected: readonly string[],
  allDocs: readonly SelectableDoc[],
): SubsetFilterResult {
  const selectable = allDocs.filter((d) => d.pdfName || d.fileId);
  if (selected.length === 0 || selectable.length === 0) {
    return { action: 'search-all', reason: 'no selection' };
  }

  const byFileId = new Map(selectable.filter((d) => d.fileId).map((d) => [d.fileId as string, d]));
  const byNorm = new Map<string, SelectableDoc>();
  for (const d of selectable) {
    const norm = normalizeDocName(d.pdfName);
    if (norm && !byNorm.has(norm)) byNorm.set(norm, d);
  }

  const matched: SelectableDoc[] = [];
  for (const sel of selected) {
    const hit = byFileId.get(sel) ?? byNorm.get(normalizeDocName(sel));
    if (hit && !matched.includes(hit)) matched.push(hit);
  }

  if (matched.length === 0) {
    return { action: 'block', reason: 'selected documents are not in this corpus' };
  }
  if (matched.length >= selectable.length) {
    return { action: 'search-all', reason: 'all documents selected' };
  }

  // Prefer file_id when every matched doc carries one; else fall back to pdf_name.
  const filter = matched.every((d) => d.fileId)
    ? buildFileIdFilter(matched.map((d) => d.fileId as string))
    : buildPdfNameFilter(matched.map((d) => d.pdfName));
  return { action: 'apply', filter };
}

export function buildDocTypeFilter(docTypes: readonly string[]): string | undefined {
  const clauses = docTypes.filter(Boolean).map((d) => `doc_type = "${escapeFilterValue(d)}"`);
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(' OR ')})`;
}

// Numeric range over the page_start/page_end metadata (requires numeric_value).
export function buildPageRangeFilter(start: number, end: number): string {
  return `page_start >= ${start} AND page_end <= ${end}`;
}

export function andFilters(filters: Array<string | undefined>): string | undefined {
  const present = filters.filter((f): f is string => Boolean(f));
  if (present.length === 0) return undefined;
  return present.map((f) => (f.includes(' OR ') && !f.startsWith('(') ? `(${f})` : f)).join(' AND ');
}

// Resolve the per-item filter for a query-time strategy. Strategies are derived
// from labels the user controls (tags), never from expectedSourceDoc — filtering
// on ground truth would inflate retrieval metrics and confound the objective.
//   none       -> no filter (search everything)
//   doc_type   -> scope to the item's tags as doc_type values, if any
// Lightweight sanity check for an AIP-160 metadata_filter expression. Empty = ok
// (no filter). Rejects obviously malformed input (unbalanced quotes/parens, no
// comparison operator). Not a full parser — Gemini is the final authority.
export function validateFilterExpr(expr: string): { ok: boolean; reason?: string } {
  const e = expr.trim();
  if (e === '') return { ok: true };
  const quotes = (e.match(/"/g) ?? []).length;
  if (quotes % 2 !== 0) return { ok: false, reason: 'Unbalanced quotes' };
  let depth = 0;
  for (const ch of e) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth < 0) return { ok: false, reason: 'Unbalanced parentheses' };
  }
  if (depth !== 0) return { ok: false, reason: 'Unbalanced parentheses' };
  if (!/[<>=]|\b(AND|OR)\b/i.test(e)) return { ok: false, reason: 'No comparison operator' };
  return { ok: true };
}

// Resolve the per-item filter for a query-time strategy.
export function resolveQueryFilter(strategy: string, item: { tags?: string[] }): string | undefined {
  if (strategy === 'doc_type' && item.tags && item.tags.length > 0) {
    return `doc_type = "${escapeFilterValue(item.tags[0])}"`;
  }
  return undefined;
}
