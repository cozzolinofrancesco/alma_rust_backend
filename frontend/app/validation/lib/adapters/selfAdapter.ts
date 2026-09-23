import type { Claim, RetrievalResult } from '@/app/claim-validation/types';
import { buildRetrieval, type AdapterContext, type ReferenceAdapter } from '../referenceAdapter';

// self: evidence for each claim is the OTHER claims in the same document, ranked
// by lexical overlap so the contradiction judge sees the most related siblings.
const TOP_K = 8;

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().match(/[a-z0-9]+/g)?.filter((t) => t.length > 3) ?? []
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

export function createSelfAdapter(): ReferenceAdapter {
  return {
    mode: 'self',
    label: 'Document self-consistency',
    async getEvidence(claim: Claim, ctx: AdapterContext): Promise<RetrievalResult> {
      const target = tokenize(claim.claim_text);
      const ranked = ctx.claims
        .filter((c) => c.claim_id !== claim.claim_id && c.claim_text.trim().length > 0)
        .map((c) => ({ c, score: overlap(target, tokenize(c.claim_text)) }))
        .sort((x, y) => y.score - x.score)
        .slice(0, TOP_K)
        .map(({ c }) => ({ content: c.claim_text, source_ref: c.claim_id }));
      return buildRetrieval(claim.claim_id, 'self', ranked);
    },
  };
}
