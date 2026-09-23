'use client';

import { useEffect } from 'react';
import { useLanguage } from '../../../contexts/LanguageContext';
import ReviewPanel from './ReviewPanel';
import ReviewerPicker from './ReviewerPicker';
import type { ReviewRun, ReviewerId } from '../../lib/reviewers/types';

interface ReviewPanelModalProps {
  open: boolean;
  latestRun: ReviewRun | null;
  isStale: boolean;
  isRunning: boolean;
  runError: string | null;
  onClose: () => void;
  onRun: (reviewerIds: ReviewerId[]) => void;
  onAcknowledge: (reviewerId: ReviewerId, commentId: string, acked: boolean) => void;
  onJumpToStep?: (stepNumber: string) => void;
}

export default function ReviewPanelModal({
  open,
  latestRun,
  isStale,
  isRunning,
  runError,
  onClose,
  onRun,
  onAcknowledge,
  onJumpToStep,
}: ReviewPanelModalProps) {
  const { t } = useLanguage();

  useEffect(() => {
    if (!open) return undefined;
    const handle = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="c272-modal-backdrop" onClick={onClose}>
      <div
        className="c272-modal an-review-modal"
        role="dialog"
        aria-label={t('agentnodesPage.review.modalTitle')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="c272-modal__header">
          <span className="c272-modal__title">{t('agentnodesPage.review.modalTitle')}</span>
          <button type="button" className="c272-modal__close" onClick={onClose} aria-label={t('agentnodesPage.review.modalClose')}>✕</button>
        </div>

        <div className="an-review-modal__body">
          <ReviewerPicker
            isRunning={isRunning}
            runError={runError}
            onRun={onRun}
          />

          {latestRun && (
            <div className="an-review-modal__results">
              <ReviewPanel
                run={latestRun}
                isStale={isStale}
                onAcknowledge={onAcknowledge}
                onJumpToStep={onJumpToStep}
              />
            </div>
          )}
        </div>

        <div className="c272-modal__footer">
          <button type="button" className="c272-btn" onClick={onClose}>{t('agentnodesPage.review.modalClose')}</button>
        </div>
      </div>
    </div>
  );
}
