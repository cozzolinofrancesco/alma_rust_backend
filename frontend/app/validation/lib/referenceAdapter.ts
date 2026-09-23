import type { Claim, RetrievalResult, RetrievedChunk, ValidationResult, Verdict, SupportLevel } from '@/app/claim-validation/types';

// Per-claim validation modes that share the claim-validation spine. Each mode is
// a (ReferenceAdapter, Judge) pair: the adapter produces evidence for a claim,
// the judge turns that evidence into a verdict.
export type PerClaimMode = 'doc-doc' | 'doc-public' | 'doc-db' | 'self';

export interface AdapterContext {
  claims: Claim[];               // all claims (self-mode needs siblings)
  ownerEmail: string;
  // doc-doc:
  referenceFileUri?: string;
  referenceMimeType?: string;
  referenceFilename?: string;
  // doc-db:
  dbConnectionId?: string;
}

export interface ReferenceAdapter {
  mode: PerClaimMode;
  label: string;
  // One-time per-session setup (e.g. resolve a DB connection, list tables).
  prepare?(ctx: AdapterContext): Promise<void>;
  getEvidence(claim: Claim, ctx: AdapterContext): Promise<RetrievalResult>;
}

export interface Judge {
  judge(claim: Claim, retrieval: RetrievalResult, model?: string): Promise<ValidationResult>;
}

// Build a RetrievalResult from plain text chunks so non-corpus adapters can feed
// the same validate/judge path the corpus mode uses.
export function buildRetrieval(
  claimId: string,
  refId: string,
  chunks: Array<{ content: string; source_ref: string }>
): RetrievalResult {
  const retrieved: RetrievedChunk[] = chunks.map((c, i) => ({
    chunk_id: `${claimId}_chunk_${i}`,
    content: c.content,
    source_ref: c.source_ref,
  }));
  return {
    retrieval_id: `ret_${claimId}_${Date.now()}`,
    claim_id: claimId,
    corpus_id: refId,
    retrieved_chunks: retrieved,
    source_refs: retrieved.map((c) => c.source_ref),
    scores: [],
  };
}

// Construct a ValidationResult with sensible defaults for the custom judges
// (contradiction / reconciliation) that do not go through validateClaim.
export function makeResult(args: {
  claim: Claim;
  verdict: Verdict;
  support_level: SupportLevel;
  explanation: string;
  retrieval: RetrievalResult;
  confidence?: number;
  contradiction_flag?: boolean;
  insufficiency_flag?: boolean;
  evidence_snippets?: string[];
  evidence_sources?: string[];
  rag_quote?: string;
  rag_location?: string | null;
  action?: string;
  prompt_used?: string;
}): ValidationResult {
  return {
    result_id: `res_${args.claim.claim_id}_${Date.now()}`,
    claim_id: args.claim.claim_id,
    claim_text: args.claim.claim_text,
    verdict: args.verdict,
    support_level: args.support_level,
    explanation: args.explanation,
    evidence_snippets: args.evidence_snippets ?? [],
    evidence_sources: args.evidence_sources ?? args.retrieval.source_refs,
    contradiction_flag: args.contradiction_flag ?? args.verdict === 'contradicted',
    insufficiency_flag: args.insufficiency_flag ?? args.verdict === 'insufficient_evidence',
    confidence: args.confidence ?? 0,
    match_score: null,
    run_status: 'completed',
    prompt_used: args.prompt_used,
    retrieval_result: args.retrieval,
    action: args.action,
    rag_quote: args.rag_quote,
    rag_location: args.rag_location ?? null,
  };
}
