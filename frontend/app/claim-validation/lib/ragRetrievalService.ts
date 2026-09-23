
import type { CorpusEntry } from '@/app/lib/rag/types';
import type { RetrievalResult, RetrievedChunk } from '../types';

export interface QueryResultShape {
  response?: string;
  isGrounded?: boolean;
  groundingChunks?: Array<{ text: string; uri?: string; title?: string }>;
  metadata?: Record<string, unknown> & { storeName?: string };
}

export function mapQueryResultToRetrievalResult(
  claimId: string,
  corpusId: string,
  queryResult: QueryResultShape,
  corpus: CorpusEntry
): RetrievalResult {
  const storeRef =
    (queryResult.metadata?.storeName as string) ?? corpus.displayName ?? 'file_search';

  const rawChunks = queryResult.groundingChunks ?? [];

  if (queryResult.isGrounded === true && rawChunks.length > 0) {
    const chunks: RetrievedChunk[] = rawChunks.map((c, i) => ({
      chunk_id:   `${claimId}_chunk_${i}`,
      content:    c.text,
      source_ref: c.uri ?? c.title ?? storeRef,
      page:       undefined,
    }));

    return {
      retrieval_id:     `ret_${claimId}_${Date.now()}`,
      claim_id:         claimId,
      corpus_id:        corpusId,
      retrieved_chunks: chunks,
      source_refs:      chunks.map((c) => c.source_ref),
      scores:           [],
    };
  }

  const fallbackContent = queryResult.response ?? '';
  if (queryResult.isGrounded === true && fallbackContent.length > 0) {
    return {
      retrieval_id:     `ret_${claimId}_${Date.now()}`,
      claim_id:         claimId,
      corpus_id:        corpusId,
      retrieved_chunks: [{ chunk_id: `${claimId}_chunk_0`, content: fallbackContent, source_ref: storeRef }],
      source_refs:      [storeRef],
      scores:           [],
    };
  }

  return {
    retrieval_id:     `ret_${claimId}_${Date.now()}`,
    claim_id:         claimId,
    corpus_id:        corpusId,
    retrieved_chunks: [],
    source_refs:      [],
    scores:           [],
  };
}
