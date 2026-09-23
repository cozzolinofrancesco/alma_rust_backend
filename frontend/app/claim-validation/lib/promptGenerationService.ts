import type { Claim } from '../types';

export interface RenderedPrompt {
  prompt_text: string;
  claim_id: string;
  placeholders_replaced: string[];
}

const PLACEHOLDER_MAP: Record<string, (c: Claim) => string> = {
  '{{claim_text}}':            (c) => c.claim_text,
  '{{claim_type}}':            (c) => c.claim_type,
  '{{source_page}}':           (c) => c.source_page !== null ? String(c.source_page) : 'unknown',
  '{{source_snippet}}':        (c) => c.source_snippet || '(no snippet available)',
  '{{extraction_confidence}}': (c) => c.extraction_confidence.toFixed(2),
  '{{CLAIM_ID}}':              (c) => c.claim_id,
  '{{CLAIM_TEXT}}':            (c) => c.claim_text,
  '{{CLAIM_TYPE}}':            (c) => c.claim_type,
  '{{CLAIM_SUMMARY}}':         (c) => c.claim_summary ?? c.source_snippet ?? '(no summary available)',
  '{{SOURCE_PAGE}}':           (c) => c.source_page !== null ? String(c.source_page) : 'unknown',
  '{{CLAIM_REF}}':             (c) => c.claim_ref != null ? String(c.claim_ref) : 'null',
};

export function renderValidationPrompt(template: string, claim: Claim): RenderedPrompt {
  let result = template;
  const replaced: string[] = [];

  for (const [placeholder, resolver] of Object.entries(PLACEHOLDER_MAP)) {
    if (result.includes(placeholder)) {
      result = result.replaceAll(placeholder, resolver(claim));
      replaced.push(placeholder);
    }
  }

  return {
    prompt_text:           result,
    claim_id:              claim.claim_id,
    placeholders_replaced: replaced,
  };
}
