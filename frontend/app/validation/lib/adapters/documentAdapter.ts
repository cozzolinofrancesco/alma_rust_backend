import type { Claim, RetrievalResult } from '@/app/claim-validation/types';
import { callGeminiText } from '../geminiRaw';
import { buildRetrieval, type AdapterContext, type ReferenceAdapter } from '../referenceAdapter';

// doc-doc: evidence for each claim is the set of passages in reference document B
// (uploaded to the Gemini Files API) that bear on the claim. Verdict is produced
// by the default judge (support/contradict).
const NO_EVIDENCE = 'NONE';

export function createDocumentAdapter(): ReferenceAdapter {
  return {
    mode: 'doc-doc',
    label: 'Document vs document',
    async getEvidence(claim: Claim, ctx: AdapterContext): Promise<RetrievalResult> {
      if (!ctx.referenceFileUri) {
        return buildRetrieval(claim.claim_id, 'doc-b', []);
      }
      const text = await callGeminiText({
        system: [
          'You extract evidence from a reference document.',
          `Given a claim, quote the passages from the attached document that are relevant to verifying it (supporting OR contradicting).`,
          `If the document contains nothing relevant, reply with exactly "${NO_EVIDENCE}".`,
          'Return only the quoted passages, separated by blank lines. No commentary.',
        ].join('\n'),
        parts: [
          { fileData: { mimeType: ctx.referenceMimeType ?? 'application/pdf', fileUri: ctx.referenceFileUri } },
          { text: `CLAIM:\n${claim.claim_text}` },
        ],
      });

      const trimmed = text.trim();
      if (!trimmed || trimmed.toUpperCase().startsWith(NO_EVIDENCE)) {
        return buildRetrieval(claim.claim_id, 'doc-b', []);
      }
      const source = ctx.referenceFilename ?? 'reference document';
      const passages = trimmed.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).slice(0, 6);
      return buildRetrieval(
        claim.claim_id,
        'doc-b',
        passages.map((content) => ({ content, source_ref: source }))
      );
    },
  };
}
