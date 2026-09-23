import type { ValidationResult, Verdict, SupportLevel } from '../types';

export interface ResultSummary {
  total:               number;
  supported:           number;
  partially_supported: number;
  contradicted:        number;
  insufficient:        number;
  unclear:             number;
  failed:              number;
  skipped:             number;
  avg_confidence:      number;
}

export function computeSummary(results: ValidationResult[]): ResultSummary {
  const verdictCounts: Record<Verdict, number> = {
    supported:              0,
    partially_supported:    0,
    contradicted:           0,
    insufficient_evidence:  0,
    unclear:                0,
  };

  let failed        = 0;
  let skipped       = 0;
  let confidenceSum = 0;
  let confCount     = 0;

  for (const r of results) {
    if (r.run_status === 'failed') {
      failed += 1;
    } else if (r.run_status === 'skipped') {
      skipped += 1;
    } else {
      verdictCounts[r.verdict] = (verdictCounts[r.verdict] ?? 0) + 1;
      confidenceSum += r.confidence;
      confCount     += 1;
    }
  }

  return {
    total:               results.length,
    supported:           verdictCounts.supported,
    partially_supported: verdictCounts.partially_supported,
    contradicted:        verdictCounts.contradicted,
    insufficient:        verdictCounts.insufficient_evidence,
    unclear:             verdictCounts.unclear,
    failed,
    skipped,
    avg_confidence:      confCount > 0 ? confidenceSum / confCount : 0,
  };
}

const VALID_VERDICTS = new Set<string>(['supported', 'partially_supported', 'contradicted', 'insufficient_evidence', 'unclear']);
const VALID_SUPPORT  = new Set<string>(['strong', 'moderate', 'weak', 'none']);

export function isValidVerdict(v: string): v is Verdict {
  return VALID_VERDICTS.has(v);
}

export function isValidSupportLevel(s: string): s is SupportLevel {
  return VALID_SUPPORT.has(s);
}

function escapeCsv(value: string | number | boolean | null | undefined): string {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

const CSV_HEADERS = [
  'claim_text',
  'status',
  'support_strength',
  'match_score',
  'action',
  'rag_quote',
  'rag_location',
  'rationale',
  'contradiction_flag',
  'insufficient_evidence',
  'run_status',
] as const;

export function exportToCsv(results: ValidationResult[]): string {
  const header = CSV_HEADERS.join(',');
  const rows   = results.map((r) =>
    [
      r.claim_text,
      mapVerdictToStatus(r.verdict),
      r.support_level,
      r.match_score ?? '',
      r.action ?? '',
      r.rag_quote ?? '',
      r.rag_location ?? '',
      r.explanation,
      r.contradiction_flag,
      r.insufficiency_flag,
      r.run_status,
    ]
      .map(escapeCsv)
      .join(',')
  );
  return [header, ...rows].join('\n');
}

function mapVerdictToStatus(verdict: string): string {
  const map: Record<string, string> = {
    supported:              'MATCHING',
    partially_supported:    'PARTIALLY_MATCHING',
    contradicted:           'NOT_MATCHING',
    insufficient_evidence:  'SOURCE_NOT_FOUND',
    unclear:                'NEEDS_REVIEW',
  };
  return map[verdict] ?? verdict.toUpperCase();
}

export interface ExportRow {
  claim_text:            string;
  status:                string;
  support_strength:      string;
  match_score:           number | null;
  action?:               string;
  rag_quote?:            string;
  rag_location?:         string | null;
  rationale:             string;
  contradiction_flag:    boolean;
  insufficient_evidence: boolean;
  run_status:            string;
  error_message?:        string;
  integrity_record?:     ValidationResult['integrity_record'];
}

export function exportToJson(results: ValidationResult[]): ExportRow[] {
  return results.map((r) => ({
    claim_text:            r.claim_text,
    status:                mapVerdictToStatus(r.verdict),
    support_strength:      r.support_level,
    match_score:           r.match_score ?? null,
    ...(r.action       ? { action:       r.action }       : {}),
    ...(r.rag_quote    ? { rag_quote:    r.rag_quote }    : {}),
    ...(r.rag_location !== undefined ? { rag_location: r.rag_location } : {}),
    rationale:             r.explanation,
    contradiction_flag:    r.contradiction_flag,
    insufficient_evidence: r.insufficiency_flag,
    run_status:            r.run_status,
    ...(r.error_message    ? { error_message:    r.error_message }    : {}),
    ...(r.integrity_record ? { integrity_record: r.integrity_record } : {}),
  }));
}
