
import type { Canvas272Layer } from '../../canvas-272/lib/types';
import { isSynthesisReportLayer } from '../../lib/reportCreation/synthesisCorpus';

export {
  isSection1ReportLayer,
  isSection3ReportLayer,
  isSynthesisReportLayer,
  SECTION_1_LAYER_TAG,
  SECTION_3_LAYER_TAG,
  stripSynthesisClinicalCorpusBinding,
  stripSection3ClinicalCorpusBinding,
  sanitizeReportCreationLayers,
} from '../../lib/reportCreation/synthesisCorpus';

const CORPUS_ID_PATTERN = /^(filesearch-|fileSearchStores\/)/;

function readStr(layer: Canvas272Layer, key: string): string {
  const v = (layer as unknown as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : '';
}

function readRagKnowledge(
  layer: Canvas272Layer,
): Array<{ id?: string; filename?: string; name?: string }> {
  const v = (layer as unknown as Record<string, unknown>).ragKnowledge;
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is { id?: string; filename?: string; name?: string } =>
    typeof x === 'object' && x !== null,
  );
}

export function resolveLayerCorpusId(layer: Canvas272Layer): string {
  if (isSynthesisReportLayer(layer)) {
    return '';
  }
  const explicit = readStr(layer, 'corpusId');
  if (explicit) return explicit;
  const rag = readRagKnowledge(layer);
  if (rag.length === 0) return '';
  if (rag.length === 1 && typeof rag[0]?.id === 'string' && rag[0].id) {
    return rag[0].id;
  }
  for (const entry of rag) {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    if (id && CORPUS_ID_PATTERN.test(id)) return id;
  }
  return '';
}

export function resolveLayerCorpusDisplayHint(layer: Canvas272Layer): string | undefined {
  const corpusId = resolveLayerCorpusId(layer);
  if (!corpusId) return undefined;
  const rag = readRagKnowledge(layer);
  const entry = rag.find((e) => typeof e.id === 'string' && e.id === corpusId);
  if (!entry) return undefined;
  const fromFilename = typeof entry.filename === 'string' ? entry.filename.trim() : '';
  const fromName = typeof entry.name === 'string' ? entry.name.trim() : '';
  const raw = fromFilename || fromName;
  if (!raw || raw === corpusId) return undefined;
  return raw;
}

export function collectLayerCorpusDisplayHints(layer: Canvas272Layer | null): string[] {
  if (!layer) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    const t = typeof raw === 'string' ? raw.trim() : '';
    if (t.length < 4 || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    out.push(t);
  };
  const resolved = resolveLayerCorpusDisplayHint(layer);
  if (resolved) push(resolved);
  // A corpus attached via the picker stores its name here (not in ragKnowledge), so
  // include it — otherwise a cross-user corpus has no display-name hint to match on.
  push(readStr(layer, 'corpusDisplayName'));
  for (const e of readRagKnowledge(layer)) {
    if (typeof e.filename === 'string') push(e.filename);
    if (typeof e.name === 'string') push(e.name);
  }
  return out;
}

function normalizeCorpusMatchLabel(s: string): string {
  return s.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

const CORPUS_HINT_STOPWORDS = new Set([
  'pdf', 'doc', 'docs', 'txt', 'png', 'jpg', 'jpeg', 'gif', 'csv', 'xlsx',
  'the', 'and', 'for', 'with', 'v1', 'v2', 'v3',
]);

export function corpusRegistryHaystackForMatching(c: CorpusRegistryRow): string {
  const parts: string[] = [];
  const add = (s: unknown) => {
    if (typeof s === 'string' && s.trim()) parts.push(s.trim());
  };
  add(c.displayName);
  add((c as { name?: string }).name);
  add(c.source?.folderName);
  const files = Array.isArray(c.files) ? c.files : [];
  for (const f of files) {
    if (typeof f?.name === 'string' && f.name.trim()) {
      parts.push(basenamePath(f.name));
    }
  }
  return normalizeCorpusMatchLabel(parts.join(' '));
}

export function registryRowMatchesCorpusHints(
  registryHaystack: string,
  hints: string[],
): boolean {
  const label = normalizeCorpusMatchLabel(registryHaystack);
  if (!label) return false;
  for (const hint of hints) {
    const h = normalizeCorpusMatchLabel(hint);
    if (h.length >= 4 && label.includes(h)) return true;
    const tokens = h
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !CORPUS_HINT_STOPWORDS.has(t));
    if (tokens.some((t) => label.includes(t))) return true;
  }
  return false;
}

export function matchRegistryRowsByLayerHints(
  corpora: CorpusRegistryRow[],
  layer: Canvas272Layer | null,
): CorpusRegistryRow[] {
  if (!layer || corpora.length === 0) return [];
  const hints = collectLayerCorpusDisplayHints(layer);
  if (hints.length === 0) return [];
  return corpora.filter((c) =>
    registryRowMatchesCorpusHints(corpusRegistryHaystackForMatching(c), hints),
  );
}

function scoreRegistryRowAgainstHints(row: CorpusRegistryRow, hints: string[]): number {
  const hay = corpusRegistryHaystackForMatching(row);
  let score = 0;
  for (const hint of hints) {
    const h = normalizeCorpusMatchLabel(hint);
    if (h.length >= 4 && hay.includes(h)) score += 1000 + h.length;
    const tokens = h.split(/\s+/).filter(
      (t) => t.length >= 3 && !CORPUS_HINT_STOPWORDS.has(t),
    );
    for (const tok of tokens) {
      if (hay.includes(tok)) score += tok.length * 10;
    }
  }
  return score;
}

export function pickRegistryRowDisambiguatedByHints(
  corpora: CorpusRegistryRow[],
  layer: Canvas272Layer | null,
): CorpusRegistryRow | null {
  const rows = matchRegistryRowsByLayerHints(corpora, layer);
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  const hints = collectLayerCorpusDisplayHints(layer);
  if (hints.length === 0) return null;
  const scored = rows.map((row) => ({
    row,
    score: scoreRegistryRowAgainstHints(row, hints),
  }));
  scored.sort((a, b) => b.score - a.score);
  if (scored[0].score <= 0) return null;
  if (scored.length > 1 && scored[0].score === scored[1].score) return null;
  return scored[0].row;
}

export function orderedRegistryFetchIdsFromLayerHints(
  corpora: CorpusRegistryRow[],
  layer: Canvas272Layer | null,
): string[] {
  const rows = matchRegistryRowsByLayerHints(corpora, layer);
  if (rows.length === 0 || !layer) return [];
  const hints = collectLayerCorpusDisplayHints(layer);
  if (hints.length === 0) return [];
  const scored = rows
    .map((row) => ({ row, score: scoreRegistryRowAgainstHints(row, hints) }))
    .sort((a, b) => b.score - a.score);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined) => {
    const t = typeof raw === 'string' ? raw.trim() : '';
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  for (const { row } of scored) {
    push(row.id);
    push(typeof row.corpusId === 'string' ? row.corpusId : undefined);
  }
  return out;
}

export function collectCorpusIdCandidatesFromLayer(layer: Canvas272Layer | null): string[] {
  if (!layer) return [];
  if (isSynthesisReportLayer(layer)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    const t = typeof raw === 'string' ? raw.trim() : '';
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  push(readStr(layer, 'corpusId'));
  push(resolveLayerCorpusId(layer));
  for (const e of readRagKnowledge(layer)) {
    const id = typeof e?.id === 'string' ? e.id.trim() : '';
    if (!id || !CORPUS_ID_PATTERN.test(id)) continue;
    push(id);
  }
  return out;
}

export type CorpusRegistryRow = {
  id?: string;
  corpusId?: string;
  displayName?: string;
  name?: string;
  source?: { folderName?: string };
  files?: Array<{ name?: string; status?: string }>;
};

function basenamePath(p: string): string {
  const s = p.trim();
  if (!s) return '';
  return s.split(/[/\\]/).pop() ?? s;
}

export function corpusRegistryEntryLabel(c: CorpusRegistryRow): string {
  const d = typeof c.displayName === 'string' ? c.displayName.trim() : '';
  if (d) return d;
  const n = typeof c.name === 'string' ? c.name.trim() : '';
  if (n) return n;
  const fn = typeof c.source?.folderName === 'string' ? c.source.folderName.trim() : '';
  if (fn) return fn;
  const files = Array.isArray(c.files) ? c.files : [];
  const indexed = files.find((f) => f?.status === 'indexed');
  const idxName = typeof indexed?.name === 'string' ? basenamePath(indexed.name) : '';
  if (idxName) return idxName;
  const anyF = files.find((f) => typeof f?.name === 'string' && f.name.trim());
  const anyName = typeof anyF?.name === 'string' ? basenamePath(anyF.name) : '';
  if (anyName) return anyName;
  const id = typeof c.id === 'string' ? c.id.trim() : '';
  if (id) return id;
  const store = typeof c.corpusId === 'string' ? c.corpusId.trim() : '';
  return store;
}

export function technicalCorpusIdMenuLabel(id: string): string {
  const t = typeof id === 'string' ? id.trim() : '';
  if (!t) return 'Attached corpus';
  if (t.length <= 44) return `${t} (attached on layer)`;
  return `${t.slice(0, 18)}…${t.slice(-12)} (attached on layer)`;
}
