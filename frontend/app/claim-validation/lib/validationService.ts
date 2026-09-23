import type { ValidationResult, RetrievalResult, RawValidationOutput, Verdict, SupportLevel } from '../types';
import { z } from 'zod';
import { claimResponse, fetchClaimModel, ClaimModelFailure, type ClaimModelMetadata, type ClaimModelOptions, type ClaimModelResponse } from './modelRequest';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

const VALIDATION_SCHEMA = {
  type: 'object',
  properties: {
    STATUS:               { type: 'string', enum: ['MATCHING', 'PARTIALLY_MATCHING', 'NOT_MATCHING', 'SOURCE_NOT_FOUND'] },
    SUPPORT_STRENGTH:     { type: 'string', enum: ['STRONG', 'MODERATE', 'WEAK', 'NONE'] },
    RATIONALE:            { type: 'string' },
    RAG_QUOTE:            { type: 'string' },
    RAG_LOCATION:         { type: 'string' },
    CONTRADICTION_PRESENT: { type: 'boolean' },
    INSUFFICIENT_EVIDENCE: { type: 'boolean' },
    ACTION:               { type: 'string', enum: ['NO_ACTION_NEEDED', 'CORRECT_VALUE_OR_UNIT', 'CLARIFY_WORDING', 'VERIFY_REFERENCE', 'FLAG_FOR_MEDICAL_REVIEW'] },
    MATCH_SCORE:          { type: 'number' },
  },
  required: ['STATUS', 'SUPPORT_STRENGTH', 'RATIONALE', 'ACTION', 'CONTRADICTION_PRESENT', 'INSUFFICIENT_EVIDENCE', 'MATCH_SCORE'],
};

const MIN_MATCH_SCORE = 60;

const STATUS_TO_VERDICT: Record<string, Verdict> = {
  MATCHING:           'supported',
  PARTIALLY_MATCHING: 'partially_supported',
  NOT_MATCHING:       'contradicted',
  SOURCE_NOT_FOUND:   'insufficient_evidence',
};

const STRENGTH_TO_SUPPORT: Record<string, SupportLevel> = {
  STRONG:   'strong',
  MODERATE: 'moderate',
  WEAK:     'weak',
  NONE:     'none',
};

export interface ValidationInput extends ClaimModelOptions {
  claimId: string;
  claimText: string;
  renderedPrompt: string;
  retrieval: RetrievalResult;
  model?: string;
}

export interface ValidationOutput {
  result: ValidationResult;
  rawText?: string;
  metadata?: ClaimModelMetadata;
}

const strictValidationSchema = z.object({
  STATUS: z.enum(['MATCHING', 'PARTIALLY_MATCHING', 'NOT_MATCHING', 'SOURCE_NOT_FOUND']),
  SUPPORT_STRENGTH: z.enum(['STRONG', 'MODERATE', 'WEAK', 'NONE']),
  RATIONALE: z.string().trim().min(1), RAG_QUOTE: z.string().optional(), RAG_LOCATION: z.string().nullable().optional(),
  CONTRADICTION_PRESENT: z.boolean(), INSUFFICIENT_EVIDENCE: z.boolean(),
  ACTION: z.enum(['NO_ACTION_NEEDED', 'CORRECT_VALUE_OR_UNIT', 'CLARIFY_WORDING', 'VERIFY_REFERENCE', 'FLAG_FOR_MEDICAL_REVIEW']),
  MATCH_SCORE: z.number().finite().min(0).max(100),
}).strict();

function buildEvidenceContext(retrieval: RetrievalResult): string {
  if (retrieval.retrieved_chunks.length === 0) {
    return 'No evidence was retrieved from the corpus.';
  }
  return retrieval.retrieved_chunks
    .map((c, i) => `[Evidence ${i + 1}] (source: ${c.source_ref})\n${c.content}`)
    .join('\n\n');
}

function injectEvidence(renderedPrompt: string, evidenceContext: string): string {
  const PLACEHOLDER = '{{RAG_EVIDENCE}}';
  if (renderedPrompt.includes(PLACEHOLDER)) {
    return renderedPrompt.replaceAll(PLACEHOLDER, evidenceContext);
  }
  return `${renderedPrompt}

--- RETRIEVED EVIDENCE ---
${evidenceContext}
---

Based on the evidence above, provide your structured validation verdict.`;
}

export async function validateClaim(input: ValidationInput): Promise<ValidationOutput> {
  const { claimId, claimText, renderedPrompt, retrieval } = input;
  const model = input.model ?? 'gemini-3-flash-preview';

  if (retrieval.retrieved_chunks.length === 0) {
    console.log(`[Validation] claim=${claimId} skipped — no grounded evidence retrieved`);
    return {
      result: {
        result_id:          `res_skipped_${claimId}_${Date.now()}`,
        claim_id:           claimId,
        claim_text:         claimText,
        verdict:            'insufficient_evidence',
        support_level:      'none',
        explanation:        'No relevant evidence was retrieved from the corpus for this claim.',
        evidence_snippets:  [],
        evidence_sources:   [],
        contradiction_flag: false,
        insufficiency_flag: true,
        confidence:         0,
        match_score:        null,
        run_status:         'skipped',
        prompt_used:        renderedPrompt,
        retrieval_result:   retrieval,
        action:             'VERIFY_REFERENCE',
        rag_quote:          '',
        rag_location:       null,
      },
    };
  }

  const evidenceContext = buildEvidenceContext(retrieval);
  const userMessage     = injectEvidence(renderedPrompt, evidenceContext);

  const endpoint = `${GEMINI_BASE_URL}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    systemInstruction: {
      role: 'system',
      parts: [{
        text: [
          'You are a rigorous claim validation assistant.',
          '',
          'STEP 1 — MATCH_SCORE (mandatory, produce this first):',
          'Score how well the retrieved corpus passage matches the claim on a scale of 0–100.',
          '  0  = completely different topic, no overlap whatsoever.',
          '  30 = same general area but no specific alignment.',
          '  60 = same topic and partial alignment of facts.',
          '  85 = same topic, same specific finding, minor wording difference.',
          ' 100 = verbatim or near-verbatim match.',
          'Return this as MATCH_SCORE.',
          '',
          'STEP 2 — TOPIC COHERENCE GATE:',
          'If MATCH_SCORE < 60, you MUST return STATUS = SOURCE_NOT_FOUND, SUPPORT_STRENGTH = NONE, INSUFFICIENT_EVIDENCE = true, ACTION = VERIFY_REFERENCE. Stop here.',
          '',
          'STEP 3 — VERDICT (only when MATCH_SCORE >= 60):',
          'Evaluate whether the on-topic evidence supports, partially supports, or contradicts the claim. Be precise and conservative.',
          '',
          'Return a strict JSON object matching the required schema.',
        ].join('\n'),
      }],
    },
    generationConfig: {
      temperature:      0.1,
      topP:             0.95,
      topK:             20,
      responseMimeType: 'application/json',
      responseSchema:   VALIDATION_SCHEMA,
      ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
    },
  };

  if (!input.strictCompletion) console.log(`[Validation] Validating claim=${claimId} model=${model}`);
  const startedAt = Date.now();
  const response = await fetchClaimModel(endpoint, body, input);

  if (!response.ok) {
    if (input.strictCompletion) {
      await response.body?.cancel();
      throw new ClaimModelFailure('claim_provider_error', `Claim validation returned HTTP ${response.status}.`);
    }
    const errText = await response.text().catch(() => 'unknown');
    throw new Error(`Gemini validation failed for claim ${claimId}: ${response.status} – ${errText}`);
  }

  const data = await response.json() as ClaimModelResponse;
  const { rawText, metadata } = claimResponse(data, model, startedAt, input);
  if (!rawText) {
    throw new Error(`Gemini returned empty validation response for claim ${claimId}`);
  }

  let raw: RawValidationOutput;
  try {
    raw = JSON.parse(rawText) as RawValidationOutput;
  } catch {
    if (input.strictCompletion) throw new ClaimModelFailure('invalid_claim_json', 'Claim validation did not return valid JSON.', rawText, metadata);
    throw new Error(`Failed to parse validation JSON for claim ${claimId}: ${rawText.slice(0, 200)}`);
  }

  if (input.strictCompletion && !strictValidationSchema.safeParse(raw).success) throw new ClaimModelFailure('invalid_claim_schema', 'Claim validation did not match its verdict schema.', rawText, metadata);

  const matchScore = typeof raw.MATCH_SCORE === 'number'
    ? Math.min(100, Math.max(0, raw.MATCH_SCORE))
    : null;
  if (matchScore === null) {
    console.warn(`[Validation] claim=${claimId} returned no MATCH_SCORE — gate disabled, confidence unknown`);
  }

  const confidence = matchScore !== null ? matchScore / 100 : 0;

  const scoreBelowThreshold = matchScore !== null && matchScore < MIN_MATCH_SCORE;

  let verdict: Verdict;
  let supportLevel: SupportLevel;
  let explanation: string;
  let evidenceSnippets: string[];
  let evidenceSources: string[];
  let contradictionFlag: boolean;
  let insufficiencyFlag: boolean;
  let action: string | undefined;
  let ragQuote: string | undefined;
  let ragLocation: string | null | undefined;

  if (scoreBelowThreshold) {
    verdict           = 'insufficient_evidence';
    supportLevel      = 'none';
    explanation       = `MATCH_SCORE=${matchScore} is below the minimum threshold (${MIN_MATCH_SCORE}). The retrieved corpus passage is not sufficiently related to this claim.`;
    evidenceSnippets  = [];
    evidenceSources   = [];
    contradictionFlag = false;
    insufficiencyFlag = true;
    action            = 'VERIFY_REFERENCE';
    ragQuote          = undefined;
    ragLocation       = null;
  } else {
    verdict           = STATUS_TO_VERDICT[raw.STATUS ?? ''] ?? 'unclear';
    supportLevel      = STRENGTH_TO_SUPPORT[raw.SUPPORT_STRENGTH ?? ''] ?? 'none';
    explanation       = String(raw.RATIONALE ?? '');
    ragQuote          = String(raw.RAG_QUOTE ?? '');
    ragLocation       = raw.RAG_LOCATION ?? null;
    evidenceSnippets  = ragQuote ? [ragQuote] : [];
    evidenceSources   = ragLocation ? [ragLocation] : [];
    contradictionFlag = Boolean(raw.CONTRADICTION_PRESENT);
    insufficiencyFlag = Boolean(raw.INSUFFICIENT_EVIDENCE);
    action            = raw.ACTION ?? undefined;
  }

  const result: ValidationResult = {
    result_id:          `res_${claimId}_${Date.now()}`,
    claim_id:           claimId,
    claim_text:         claimText,
    verdict,
    support_level:      supportLevel,
    explanation,
    evidence_snippets:  evidenceSnippets,
    evidence_sources:   evidenceSources,
    contradiction_flag: contradictionFlag,
    insufficiency_flag: insufficiencyFlag,
    confidence,
    match_score:        matchScore,
    run_status:         'completed',
    prompt_used:        userMessage,
    retrieval_result:   retrieval,
    action,
    rag_quote:          ragQuote,
    rag_location:       ragLocation,
  };

  if (!input.strictCompletion) console.log(`[Validation] claim=${claimId} verdict=${result.verdict} match_score=${matchScore ?? 'n/a'}`);

  return { result, ...(input.strictCompletion ? { rawText, metadata } : {}) };
}
