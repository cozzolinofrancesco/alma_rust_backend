'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StructuredDoc } from '../../canvas-272/lib/exportFormatter';
import { useLanguage } from '../../contexts/LanguageContext';
import type { ReviewerId, ReviewRun } from '../lib/reviewers/types';
import { runReviewCommittee } from '../lib/reviewers/runReview';
import { computeDocHash } from '../lib/reviewers/docHash';
import { readLocalReviewRun, writeLocalReviewRun } from '../lib/reviewers/storage';

interface UseReviewStateOptions {
  projectId: string | null;
  agentId: string | null;
  currentDoc: StructuredDoc | null;
}

export interface ReviewStateResult {
  latestRun: ReviewRun | null;
  isStale: boolean;
  isRunning: boolean;
  runError: string | null;
  runReview: (reviewerIds: ReviewerId[], sectionDoc?: StructuredDoc) => Promise<void>;
  acknowledgeComment: (reviewerId: ReviewerId, commentId: string, acked: boolean) => void;
  clearRun: () => void;
}

export function useReviewState({
  projectId,
  agentId,
  currentDoc,
}: UseReviewStateOptions): ReviewStateResult {
  const { t } = useLanguage();
  const [latestRun, setLatestRun] = useState<ReviewRun | null>(null);
  const [currentDocHash, setCurrentDocHash] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const currentDocRef = useRef<StructuredDoc | null>(null);
  useEffect(() => { currentDocRef.current = currentDoc; }, [currentDoc]);

  useEffect(() => {
    if (!projectId || !agentId) {
      setLatestRun(null);
      return;
    }
    const stored = readLocalReviewRun(projectId, agentId);
    setLatestRun(stored);
  }, [projectId, agentId]);

  useEffect(() => {
    if (!currentDoc) {
      setCurrentDocHash(null);
      return;
    }
    let cancelled = false;
    computeDocHash(currentDoc).then((hash) => {
      if (!cancelled) setCurrentDocHash(hash);
    });
    return () => { cancelled = true; };
  }, [currentDoc]);

  const isStale = useMemo(() => {
    if (!latestRun || !currentDocHash) return false;
    return latestRun.docHash !== currentDocHash;
  }, [latestRun, currentDocHash]);

  const runReview = useCallback(async (reviewerIds: ReviewerId[], sectionDoc?: StructuredDoc) => {
    const fullDoc = currentDocRef.current;
    if (!fullDoc) {
      setRunError(t('agentnodesPage.review.errNoDocument'));
      return;
    }
    if (!projectId || !agentId) {
      setRunError(t('agentnodesPage.review.errNoAgent'));
      return;
    }
    const docToAnalyse = sectionDoc ?? fullDoc;
    setIsRunning(true);
    setRunError(null);
    try {
      const run = await runReviewCommittee(docToAnalyse, reviewerIds);
      setLatestRun(run);
      writeLocalReviewRun(projectId, agentId, run);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : t('agentnodesPage.review.errGeneric'));
    } finally {
      setIsRunning(false);
    }
  }, [projectId, agentId, t]);

  const acknowledgeComment = useCallback(
    (reviewerId: ReviewerId, commentId: string, acked: boolean) => {
      setLatestRun((prev) => {
        if (!prev) return prev;
        const updated: ReviewRun = {
          ...prev,
          reports: prev.reports.map((r) => {
            if (r.reviewerId !== reviewerId) return r;
            return {
              ...r,
              comments: r.comments.map((c) =>
                c.id === commentId ? { ...c, acknowledged: acked } : c,
              ),
            };
          }),
        };
        if (projectId && agentId) writeLocalReviewRun(projectId, agentId, updated);
        return updated;
      });
    },
    [projectId, agentId],
  );

  const clearRun = useCallback(() => {
    setLatestRun(null);
    setRunError(null);
  }, []);

  return {
    latestRun,
    isStale,
    isRunning,
    runError,
    runReview,
    acknowledgeComment,
    clearRun,
  };
}
