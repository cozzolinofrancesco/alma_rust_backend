'use client';

// Drives "upload local files -> create/extend a file-search corpus -> poll the
// job -> get a durable corpusId" for an agent step. Reuses the existing
// /api/rag/corpora/local + /api/rag/jobs endpoints (the same pipeline the RAG
// corpus manager uses) so an uploaded PDF becomes a persisted corpus that BOTH
// the single-step run and the graph "Run All" can query.

import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';

export type IngestionPhase = 'idle' | 'uploading' | 'indexing' | 'ready' | 'error';

const POLL_INTERVAL_MS = 3000;
const MAX_CONSECUTIVE_MISSES = 4;

const jobStatusSchema = z.object({
  status: z.enum(['pending', 'processing', 'completed', 'failed', 'completed_with_errors', 'cancelled']),
  corpusId: z.string().optional(),
  error: z.string().optional(),
  totalFiles: z.number().optional(),
  processedFiles: z.number().optional(),
});

const startResponseSchema = z.object({ jobId: z.string().min(1) });

export interface IngestionState {
  phase: IngestionPhase;
  jobId: string | null;
  corpusId: string | null;
  error: string | null;
  processed: number;
  total: number;
}

const INITIAL: IngestionState = {
  phase: 'idle',
  jobId: null,
  corpusId: null,
  error: null,
  processed: 0,
  total: 0,
};

export interface StartArgs {
  files: File[];
  displayName: string;
  existingCorpusId?: string;
}

export function useLocalCorpusIngestion(onReady?: (corpusId: string) => void) {
  const [state, setState] = useState<IngestionState>(INITIAL);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // Poll the active job whenever we have a jobId and aren't in a terminal phase.
  useEffect(() => {
    const { jobId, phase } = state;
    if (!jobId || phase === 'ready' || phase === 'error' || phase === 'idle') return;

    let cancelled = false;
    let misses = 0;

    const tick = async () => {
      try {
        const res = await fetch(`/api/rag/jobs/${encodeURIComponent(jobId)}`, { credentials: 'include' });
        if (!res.ok) {
          misses += 1;
          if (misses >= MAX_CONSECUTIVE_MISSES && !cancelled) {
            setState((s) => ({ ...s, phase: 'error', error: `Job status unavailable (HTTP ${res.status})` }));
          }
          return;
        }
        misses = 0;
        const job = jobStatusSchema.parse(await res.json());
        if (cancelled) return;

        const processed = job.processedFiles ?? 0;
        const total = job.totalFiles ?? 0;

        if (job.status === 'completed' || job.status === 'completed_with_errors') {
          if (job.corpusId) {
            setState((s) => ({ ...s, phase: 'ready', corpusId: job.corpusId!, processed, total, error: null }));
            onReadyRef.current?.(job.corpusId);
          } else {
            setState((s) => ({ ...s, phase: 'error', error: job.error || 'Indexing finished without a corpus id', processed, total }));
          }
        } else if (job.status === 'failed' || job.status === 'cancelled') {
          setState((s) => ({ ...s, phase: 'error', error: job.error || `Indexing ${job.status}`, processed, total }));
        } else {
          setState((s) => ({ ...s, phase: 'indexing', processed, total }));
        }
      } catch {
        misses += 1;
        if (misses >= MAX_CONSECUTIVE_MISSES && !cancelled) {
          setState((s) => ({ ...s, phase: 'error', error: 'Lost contact with the indexing job' }));
        }
      }
    };

    void tick();
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [state.jobId, state.phase]);

  const start = useCallback(async ({ files, displayName, existingCorpusId }: StartArgs): Promise<string> => {
    if (files.length === 0) throw new Error('No files to index');
    setState({ ...INITIAL, phase: 'uploading', total: files.length });

    const fd = new FormData();
    if (existingCorpusId) {
      fd.append('mode', 'existing');
      fd.append('existingCorpusId', existingCorpusId);
    } else {
      fd.append('mode', 'new');
      fd.append('displayName', displayName);
    }
    fd.append('allowPartialSuccess', 'true');
    files.forEach((f) => fd.append('file', f));

    let jobId: string;
    try {
      const res = await fetch('/api/rag/corpora/local', { method: 'POST', body: fd, credentials: 'include' });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Upload failed (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
      }
      jobId = startResponseSchema.parse(await res.json()).jobId;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      setState((s) => ({ ...s, phase: 'error', error: message }));
      throw err;
    }

    setState((s) => ({ ...s, phase: 'indexing', jobId }));
    return jobId;
  }, []);

  // Resume polling for a job started earlier (e.g. the editor was reopened
  // while indexing was still running).
  const resume = useCallback((jobId: string) => {
    setState({ ...INITIAL, phase: 'indexing', jobId });
  }, []);

  const reset = useCallback(() => setState(INITIAL), []);

  return { ...state, start, resume, reset };
}
