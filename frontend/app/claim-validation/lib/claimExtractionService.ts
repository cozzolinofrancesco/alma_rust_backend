import type { Claim, RawExtractedClaim } from '../types';
import { createIntegrityRecordSync } from '@/app/lib/integrity';
import type { IntegrityRecord } from '@/app/lib/integrity';
import { getModelInfo } from '@/app/lib/modelConfig';
import { claimResponse, fetchClaimModel, ClaimModelFailure, type ClaimModelMetadata, type ClaimModelOptions, type ClaimModelResponse } from './modelRequest';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

const CLAIM_EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          CLAIM_TEXT:  { type: 'string' },
          CLAIM_REF:   { type: 'string' },
          SOURCE_PAGE: { type: 'number' },
          CLAIM_ID:      { type: 'string' },
          CLAIM_TYPE:    { type: 'string' },
          CLAIM_SUMMARY: { type: 'string' },
          claim_text:            { type: 'string' },
          claim_type:            { type: 'string' },
          source_page:           { type: 'number' },
          source_snippet:        { type: 'string' },
          extraction_confidence: { type: 'number' },
        },
        required: [],
      },
    },
  },
  required: ['claims'],
};

export interface ClaimExtractionInput extends ClaimModelOptions {
  fileUri?: string;
  mimeType?: string;
  rawText?: string;
  documentId: string;
  extractionPrompt: string;
  model?: string;
}

export interface ClaimExtractionOutput {
  claims: Claim[];
  rawCount: number;
  extraction_integrity_record: IntegrityRecord;
  rawText?: string;
  metadata?: ClaimModelMetadata;
}

function generateClaimId(documentId: string, index: number): string {
  return `claim_${documentId.slice(0, 8)}_${index.toString().padStart(4, '0')}`;
}

/**
 * Recover the maximal prefix of complete claim objects from a truncated JSON
 * response (e.g. when Gemini hits maxOutputTokens mid-array). Scans char-by-char
 * tracking string state so braces/quotes inside string values are ignored, then
 * cuts the claims array after the last *complete* top-level object and closes it.
 * The trailing half-written object is dropped entirely — never repaired — so no
 * claim is emitted with a value cut off mid-string. Returns a parseable JSON
 * string, or null if no claims array could be located.
 */
export function salvageClaimsArray(text: string): string | null {
  let inString = false;
  let escape = false;
  let started = false;     // entered the claims array yet?
  let arrayStart = -1;     // index of the array's opening '['
  let depth = 0;           // nesting depth inside the array
  let lastElementEnd = -1; // index just past the last complete top-level element

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }

    if (!started) {
      if (ch === '[') { arrayStart = i; started = true; }
      continue;
    }

    if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === ']' && depth === 0) {
      // The array closed cleanly; nothing was truncated inside it.
      lastElementEnd = i;
      break;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) lastElementEnd = i + 1; // a top-level element just closed
    }
  }

  if (arrayStart === -1) return null;
  if (lastElementEnd === -1) return `${text.slice(0, arrayStart + 1)}]}`;
  return `${text.slice(0, lastElementEnd)}]}`;
}

function isUppercaseSchema(raw: RawExtractedClaim): boolean {
  return Boolean(raw.CLAIM_TEXT ?? raw.CLAIM_ID ?? raw.CLAIM_TYPE);
}

function normaliseRawClaim(raw: RawExtractedClaim, documentId: string, index: number): Claim {
  if (isUppercaseSchema(raw)) {
    const claimText  = String(raw.CLAIM_TEXT ?? '').trim();
    const sourcePage = typeof raw.SOURCE_PAGE === 'number' ? raw.SOURCE_PAGE : null;
    const claimRef   = raw.CLAIM_REF != null ? String(raw.CLAIM_REF).trim() : null;
    const claimType    = String(raw.CLAIM_TYPE ?? 'GENERAL').trim().toUpperCase();
    const claimSummary = String(raw.CLAIM_SUMMARY ?? claimText).trim();

    return {
      claim_id:              generateClaimId(documentId, index),
      document_id:           documentId,
      claim_text:            claimText,
      claim_type:            claimType,
      source_page:           sourcePage,
      source_snippet:        claimSummary,
      extraction_confidence: 0.8,
      review_status:         'pending',
      selected:              false,
      claim_summary:         claimSummary,
      claim_ref:             claimRef,
    };
  }

  return {
    claim_id:              generateClaimId(documentId, index),
    document_id:           documentId,
    claim_text:            String(raw.claim_text ?? '').trim(),
    claim_type:            String(raw.claim_type ?? 'general').trim().toLowerCase(),
    source_page:           typeof raw.source_page === 'number' ? raw.source_page : null,
    source_snippet:        String(raw.source_snippet ?? '').trim(),
    extraction_confidence: Math.min(1, Math.max(0, Number(raw.extraction_confidence ?? 0.5))),
    review_status:         'pending',
    selected:              false,
  };
}

export async function extractClaims(input: ClaimExtractionInput): Promise<ClaimExtractionOutput> {
  const { fileUri, mimeType, rawText, documentId, extractionPrompt } = input;
  const model = input.model ?? 'gemini-3-flash-preview';

  const resolvedPrompt = rawText
    ? extractionPrompt.replace(/\{\{INPUT_TEXT\}\}/g, rawText)
    : extractionPrompt.replace(/\{\{INPUT_TEXT\}\}/g, 'the uploaded document');

  const endpoint = `${GEMINI_BASE_URL}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const parts: Array<{ text: string } | { fileData: { mimeType: string; fileUri: string } }> = rawText
    ? [{ text: resolvedPrompt }]
    : [
        { fileData: { mimeType: mimeType ?? 'application/pdf', fileUri: fileUri! } },
        { text: resolvedPrompt },
      ];

  const maxOutputTokens = input.maxOutputTokens ?? getModelInfo(model)?.maxOutputTokens ?? 65_536;

  const body = {
    contents: [
      {
        role: 'user',
        parts,
      },
    ],
    generationConfig: {
      temperature:      0.1,
      topP:             0.95,
      topK:             20,
      maxOutputTokens,
      responseMimeType: 'application/json',
      responseSchema:   CLAIM_EXTRACTION_SCHEMA,
    },
  };

  if (!input.strictCompletion) console.log(`[ClaimExtraction] Calling Gemini model=${model} ${rawText ? '(raw-text mode)' : `with fileUri=${fileUri}`}`);
  const startedAt = Date.now();
  const response = await fetchClaimModel(endpoint, body, input);

  if (!response.ok) {
    if (input.strictCompletion) {
      await response.body?.cancel();
      throw new ClaimModelFailure('claim_provider_error', `Claim extraction returned HTTP ${response.status}.`);
    }
    const errText = await response.text().catch(() => 'unknown');
    throw new Error(`Gemini claim extraction failed: ${response.status} – ${errText}`);
  }

  const data = await response.json() as ClaimModelResponse;
  const { rawText: geminiResponseText, metadata } = claimResponse(data, model, startedAt, input);
  const finishReason = metadata.finishReason;
  if (finishReason && finishReason !== 'STOP') {
    console.warn(`[ClaimExtraction] Gemini finishReason=${finishReason} (model=${model}) — output may be truncated`);
  }
  if (!geminiResponseText) {
    throw new Error('Gemini returned empty claim extraction response');
  }

  let parsed: { claims: RawExtractedClaim[] };
  try {
    parsed = JSON.parse(geminiResponseText);
  } catch {
    if (input.strictCompletion) throw new ClaimModelFailure('invalid_claim_json', 'The extracted claims were not complete valid JSON.', geminiResponseText, metadata);
    const salvaged = salvageClaimsArray(geminiResponseText);
    if (!salvaged) {
      throw new Error(`Failed to parse claim extraction JSON: ${geminiResponseText.slice(0, 200)}`);
    }
    try {
      parsed = JSON.parse(salvaged) as { claims: RawExtractedClaim[] };
      console.warn(
        `[ClaimExtraction] Recovered ${parsed.claims?.length ?? 0} claim(s) from truncated JSON ` +
        `(finishReason=${finishReason ?? 'unknown'})`
      );
    } catch {
      throw new Error(`Failed to parse claim extraction JSON: ${geminiResponseText.slice(0, 200)}`);
    }
  }

  if (!Array.isArray(parsed.claims)) {
    if (input.strictCompletion) throw new ClaimModelFailure('invalid_claim_schema', 'The extraction response has no claims array.', geminiResponseText, metadata);
    throw new Error('Claim extraction output missing "claims" array');
  }

  const claims = parsed.claims
    .filter((c) => (c.CLAIM_TEXT ?? c.claim_text)?.trim())
    .map((c, i) => normaliseRawClaim(c, documentId, i));

  if (input.strictCompletion && claims.length !== parsed.claims.length) throw new ClaimModelFailure('invalid_claim_schema', 'Some extracted claims were empty or invalid.', geminiResponseText, metadata);
  if (!input.strictCompletion) console.log(`[ClaimExtraction] Extracted ${claims.length} claims (raw: ${parsed.claims.length})`);

  const extraction_integrity_record = createIntegrityRecordSync({
    name: `Extraction: ${documentId}`,
    previousChainHash: null,
    components: [
      { type: 'user_input',         label: 'Document File URI',    value: rawText ? '(raw-text mode)' : (fileUri ?? '') },
      { type: 'user_input',         label: 'Document MIME Type',   value: rawText ? 'text/plain' : (mimeType ?? '') },
      { type: 'user_input',         label: 'Document ID',          value: documentId },
      { type: 'final_prompt',       label: 'Extraction Prompt',    value: resolvedPrompt },
      { type: 'model_config',       label: 'Model',                value: model },
      { type: 'model_config',       label: 'Model Settings',       value: { temperature: 0.1, topP: 0.95, topK: 20 } },
      { type: 'execution_metadata', label: 'Timestamp',            value: new Date().toISOString() },
      { type: 'output',             label: 'Extracted Claims',     value: claims.map((c) => ({
          id:   c.claim_id,
          text: c.claim_text,
          ref:  c.claim_ref  ?? null,
          page: c.source_page ?? null,
        })) },
      { type: 'output',             label: 'Raw Claim Count',      value: parsed.claims.length },
      { type: 'output',             label: 'Filtered Claim Count', value: claims.length },
    ],
  });

  return { claims, rawCount: parsed.claims.length, extraction_integrity_record, ...(input.strictCompletion ? { rawText: geminiResponseText, metadata } : {}) };
}
