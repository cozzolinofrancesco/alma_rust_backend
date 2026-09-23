import type { Claim, RetrievalResult, ValidationResult } from '@/app/claim-validation/types';
import { validateClaim } from '@/app/claim-validation/lib/validationService';
import { callGeminiJson } from './geminiRaw';
import { makeResult, type Judge } from './referenceAdapter';

// defaultJudge — reuses the existing claim validator (support/contradict with a
// topic-coherence gate). Correct for doc-doc and doc-public.
export const defaultJudge: Judge = {
  async judge(claim: Claim, retrieval: RetrievalResult, model?: string): Promise<ValidationResult> {
    const renderedPrompt = `CLAIM TO VALIDATE:\n${claim.claim_text}`;
    const { result } = await validateClaim({
      claimId: claim.claim_id,
      claimText: claim.claim_text,
      renderedPrompt,
      retrieval,
      model,
    });
    return result;
  },
};

// contradictionJudge — self-consistency. The default validator frames everything
// as "is the claim supported", which hides contradictions; here the evidence is
// the document's OTHER claims and the question is whether any conflict.
const CONTRADICTION_SCHEMA = {
  type: 'object',
  properties: {
    STATUS: { type: 'string', enum: ['CONSISTENT', 'CONTRADICTED', 'UNRELATED'] },
    CONFLICTING_CLAIM: { type: 'string' },
    RATIONALE: { type: 'string' },
  },
  required: ['STATUS', 'RATIONALE'],
};

export const contradictionJudge: Judge = {
  async judge(claim: Claim, retrieval: RetrievalResult): Promise<ValidationResult> {
    if (retrieval.retrieved_chunks.length === 0) {
      return makeResult({
        claim, retrieval, verdict: 'insufficient_evidence', support_level: 'none',
        explanation: 'No other claims in the document to compare against.',
      });
    }
    const siblings = retrieval.retrieved_chunks
      .map((c, i) => `[Other claim ${i + 1}] ${c.content}`)
      .join('\n');
    const raw = await callGeminiJson<{ STATUS?: string; CONFLICTING_CLAIM?: string; RATIONALE?: string }>({
      system: [
        'You check a document for INTERNAL self-consistency.',
        'Given a target claim and a list of other claims from the SAME document, decide whether the target claim is CONTRADICTED by any other claim, is CONSISTENT with them, or is UNRELATED (no overlap).',
        'Only return CONTRADICTED when two statements cannot both be true. Be precise and conservative.',
      ].join('\n'),
      parts: [{ text: `TARGET CLAIM:\n${claim.claim_text}\n\nOTHER CLAIMS IN THE DOCUMENT:\n${siblings}` }],
      schema: CONTRADICTION_SCHEMA,
    });

    const status = raw.STATUS ?? 'UNRELATED';
    const contradicted = status === 'CONTRADICTED';
    return makeResult({
      claim,
      retrieval,
      verdict: contradicted ? 'contradicted' : status === 'CONSISTENT' ? 'supported' : 'unclear',
      support_level: status === 'CONSISTENT' ? 'moderate' : 'none',
      explanation: String(raw.RATIONALE ?? ''),
      contradiction_flag: contradicted,
      insufficiency_flag: false,
      confidence: contradicted || status === 'CONSISTENT' ? 0.8 : 0.3,
      evidence_snippets: raw.CONFLICTING_CLAIM ? [raw.CONFLICTING_CLAIM] : [],
      rag_quote: raw.CONFLICTING_CLAIM,
    });
  },
};

// reconciliationJudge — numeric reconciliation against DB rows. The default
// validator's MATCH_SCORE>=60 topic gate would wrongly reject a correct number
// whose surrounding wording differs, so this judge does value equality.
const RECONCILE_SCHEMA = {
  type: 'object',
  properties: {
    STATUS: { type: 'string', enum: ['MATCHING', 'NOT_MATCHING', 'VALUE_NOT_FOUND'] },
    CLAIMED_VALUE: { type: 'string' },
    DB_VALUE: { type: 'string' },
    RATIONALE: { type: 'string' },
  },
  required: ['STATUS', 'RATIONALE'],
};

export const reconciliationJudge: Judge = {
  async judge(claim: Claim, retrieval: RetrievalResult): Promise<ValidationResult> {
    if (retrieval.retrieved_chunks.length === 0) {
      return makeResult({
        claim, retrieval, verdict: 'insufficient_evidence', support_level: 'none',
        explanation: 'No database value could be retrieved for this figure (non-numeric claim or empty query result).',
        action: 'VERIFY_REFERENCE',
      });
    }
    const evidence = retrieval.retrieved_chunks.map((c) => c.content).join('\n');
    const raw = await callGeminiJson<{ STATUS?: string; CLAIMED_VALUE?: string; DB_VALUE?: string; RATIONALE?: string }>({
      system: [
        'You reconcile a numeric/statistical claim from a document against the actual value(s) returned by a read-only database query.',
        'Compare the figure stated in the claim to the value(s) in the query result.',
        'Return MATCHING if they agree (allowing for rounding/units), NOT_MATCHING if they conflict, or VALUE_NOT_FOUND if the result does not contain a comparable value.',
      ].join('\n'),
      parts: [{ text: `CLAIM:\n${claim.claim_text}\n\nDATABASE QUERY RESULT:\n${evidence}` }],
      schema: RECONCILE_SCHEMA,
    });

    const status = raw.STATUS ?? 'VALUE_NOT_FOUND';
    const matching = status === 'MATCHING';
    const notMatching = status === 'NOT_MATCHING';
    return makeResult({
      claim,
      retrieval,
      verdict: matching ? 'supported' : notMatching ? 'contradicted' : 'insufficient_evidence',
      support_level: matching ? 'strong' : 'none',
      explanation: [
        raw.RATIONALE ?? '',
        raw.CLAIMED_VALUE ? `Claimed: ${raw.CLAIMED_VALUE}` : '',
        raw.DB_VALUE ? `Database: ${raw.DB_VALUE}` : '',
      ].filter(Boolean).join(' '),
      contradiction_flag: notMatching,
      insufficiency_flag: status === 'VALUE_NOT_FOUND',
      confidence: matching || notMatching ? 0.9 : 0.2,
      evidence_snippets: retrieval.retrieved_chunks.map((c) => c.content),
      action: notMatching ? 'CORRECT_VALUE_OR_UNIT' : undefined,
    });
  },
};
