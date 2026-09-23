import type { ValidationResult, Verdict } from '../types';

// Pure model: turn validation results into a force-graph of
// claim → evidence → source. No React/DOM here so it can be unit-tested and
// rendered by any graph lib. Source nodes are deduped across all results, which
// is what makes claims visually cluster around the documents that back them.

export type ResultNodeKind = 'claim' | 'evidence' | 'source';

export interface ResultGraphNode {
  id: string;
  kind: ResultNodeKind;
  label: string;
  color: string;
  /** Relative node size (claims emphasized). */
  weight: number;
  /** Full text for the detail panel / tooltip. */
  detail: string;
  /** Present on claim nodes. */
  verdict?: Verdict | 'failed' | 'skipped';
  /** Present on source nodes — the raw source ref. */
  sourceRef?: string;
}

export interface ResultGraphLink {
  source: string;
  target: string;
  /** 0–1, drives edge width/opacity (from match/chunk score). */
  weight: number;
}

export interface ResultGraph {
  nodes: ResultGraphNode[];
  links: ResultGraphLink[];
}

/** Claim-node color keyed by the verdict (or run_status for non-completed). */
export const VERDICT_COLORS: Record<Verdict | 'failed' | 'skipped', string> = {
  supported: '#16a34a',            // green
  partially_supported: '#2563eb',  // blue
  contradicted: '#dc2626',         // red
  insufficient_evidence: '#d97706',// amber
  unclear: '#6b7280',              // gray
  failed: '#7f1d1d',               // dark red
  skipped: '#9ca3af',              // light gray
};

export const EVIDENCE_COLOR = '#a78bfa'; // violet
export const SOURCE_COLOR = '#0891b2';   // cyan

/** Human-readable label for a claim node's verdict/status (for the legend). */
export const VERDICT_LABELS: Record<Verdict | 'failed' | 'skipped', string> = {
  supported: 'Supported',
  partially_supported: 'Partially supported',
  contradicted: 'Contradicted',
  insufficient_evidence: 'Insufficient evidence',
  unclear: 'Unclear',
  failed: 'Failed',
  skipped: 'Skipped',
};

export function claimVerdictKey(r: ValidationResult): Verdict | 'failed' | 'skipped' {
  if (r.run_status === 'failed') return 'failed';
  if (r.run_status === 'skipped') return 'skipped';
  return r.verdict;
}

export function verdictColor(r: ValidationResult): string {
  return VERDICT_COLORS[claimVerdictKey(r)] ?? VERDICT_COLORS.unclear;
}

function truncate(s: string, max = 60): string {
  const clean = (s ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function normalizeSourceRef(ref: string): string {
  return (ref ?? '').trim().toLowerCase();
}

interface EvidenceItem {
  content: string;
  sourceRef: string;
  score: number; // 0–1
}

/** Extract evidence items from a result using the best-available representation. */
function extractEvidence(r: ValidationResult): EvidenceItem[] {
  const chunks = r.retrieval_result?.retrieved_chunks;
  if (chunks && chunks.length > 0) {
    return chunks
      .filter((c) => (c.source_ref ?? '').trim() || (c.content ?? '').trim())
      .map((c) => ({
        content: c.content ?? '',
        sourceRef: (c.source_ref ?? '').trim() || 'unknown source',
        score: typeof c.score === 'number' ? Math.max(0, Math.min(1, c.score)) : 0.5,
      }));
  }
  const matchScore = typeof r.match_score === 'number' ? Math.max(0, Math.min(1, r.match_score / 100)) : 0.5;
  if (r.evidence_snippets.length > 0) {
    return r.evidence_snippets.map((snippet, i) => ({
      content: snippet,
      sourceRef: (r.evidence_sources[i] ?? '').trim() || 'unknown source',
      score: matchScore,
    }));
  }
  if (r.rag_quote && r.rag_quote.trim()) {
    return [{ content: r.rag_quote, sourceRef: (r.rag_location ?? '').trim() || 'unknown source', score: matchScore }];
  }
  return [];
}

export function buildResultsGraph(results: ValidationResult[]): ResultGraph {
  const nodes: ResultGraphNode[] = [];
  const links: ResultGraphLink[] = [];
  const sourceNodeIds = new Map<string, string>(); // normalized ref -> node id

  for (const r of results) {
    const claimId = `claim:${r.claim_id}`;
    nodes.push({
      id: claimId,
      kind: 'claim',
      label: truncate(r.claim_text, 48),
      color: verdictColor(r),
      weight: 8,
      detail: r.claim_text,
      verdict: claimVerdictKey(r),
    });

    const evidence = extractEvidence(r);
    evidence.forEach((ev, i) => {
      const evidenceId = `evidence:${r.result_id}:${i}`;
      nodes.push({
        id: evidenceId,
        kind: 'evidence',
        label: truncate(ev.content, 40),
        color: EVIDENCE_COLOR,
        weight: 3,
        detail: ev.content,
      });
      links.push({ source: claimId, target: evidenceId, weight: ev.score });

      const norm = normalizeSourceRef(ev.sourceRef);
      let sourceId = sourceNodeIds.get(norm);
      if (!sourceId) {
        sourceId = `src:${norm || `unknown:${r.result_id}:${i}`}`;
        sourceNodeIds.set(norm, sourceId);
        nodes.push({
          id: sourceId,
          kind: 'source',
          label: truncate(ev.sourceRef, 36),
          color: SOURCE_COLOR,
          weight: 5,
          detail: ev.sourceRef,
          sourceRef: ev.sourceRef,
        });
      }
      links.push({ source: evidenceId, target: sourceId, weight: ev.score });
    });
  }

  return { nodes, links };
}
