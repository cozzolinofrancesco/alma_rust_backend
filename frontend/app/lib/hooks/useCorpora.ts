'use client';

import { useCallback, useEffect, useState } from 'react';

export interface CorpusItem {
  id: string;
  displayName: string;
  corpusId?: string;
  source?: { folderName?: string; ownerEmail?: string };
  files?: Array<{ name: string; status: string }>;
  createdAt?: string;
}

export interface UseCorporaResult {
  corpora: CorpusItem[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useCorpora(): UseCorporaResult {
  const [corpora, setCorpora] = useState<CorpusItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/rag/corpora');
      if (!res.ok) throw new Error('Failed to load corpora');
      const data = (await res.json()) as { corpora?: CorpusItem[] };
      setCorpora(data.corpora ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load corpora');
      setCorpora([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { corpora, loading, error, refetch };
}
