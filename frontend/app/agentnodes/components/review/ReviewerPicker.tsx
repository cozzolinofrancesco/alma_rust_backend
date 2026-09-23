'use client';

import { useState } from 'react';
import { useLanguage } from '../../../contexts/LanguageContext';
import { REVIEWERS } from '../../lib/reviewers/registry';
import { reviewerLocalizedAnchor, reviewerLocalizedDescription, reviewerLocalizedName } from '../../lib/reviewers/labels';
import type { ReviewerId } from '../../lib/reviewers/types';

interface ReviewerPickerProps {
  isRunning: boolean;
  runError: string | null;
  onRun: (reviewerIds: ReviewerId[]) => void;
}

export default function ReviewerPicker({ isRunning, runError, onRun }: ReviewerPickerProps) {
  const { t } = useLanguage();
  const [selected, setSelected] = useState<Set<ReviewerId>>(
    new Set<ReviewerId>(['document-quality']),
  );

  const toggle = (id: ReviewerId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleRun = () => {
    if (selected.size === 0 || isRunning) return;
    onRun(Array.from(selected));
  };

  const countLabel =
    selected.size === 0
      ? t('agentnodesPage.review.noReviewersSelected')
      : selected.size === 1
        ? t('agentnodesPage.review.reviewersSelectedOneParallel')
        : t('agentnodesPage.review.reviewersSelectedParallel', { count: selected.size });

  return (
    <div className="an-review-picker">
      <div className="an-review-picker__header">
        <span className="an-review-picker__title">{t('agentnodesPage.review.selectReviewersTitle')}</span>
        <span className="an-review-readonly-badge">{t('agentnodesPage.review.pickerReadonlyBadge')}</span>
      </div>

      <div className="an-review-picker__list">
        {REVIEWERS.map((r) => (
          <label key={r.id} className="an-review-picker__item">
            <input
              type="checkbox"
              className="an-review-picker__checkbox"
              checked={selected.has(r.id)}
              onChange={() => toggle(r.id)}
              disabled={isRunning}
            />
            <span className="an-review-picker__item-body">
              <span className="an-review-picker__item-name">{reviewerLocalizedName(t, r.id)}</span>
              <span className="an-review-picker__item-anchor">{reviewerLocalizedAnchor(t, r.id)}</span>
              <span className="an-review-picker__item-desc">{reviewerLocalizedDescription(t, r.id)}</span>
            </span>
          </label>
        ))}
      </div>

      {runError && (
        <div className="an-review-picker__error">{runError}</div>
      )}

      <div className="an-review-picker__footer">
        <span className="an-review-picker__count">{countLabel}</span>
        <button
          type="button"
          className="c272-btn c272-btn--primary"
          disabled={selected.size === 0 || isRunning}
          onClick={handleRun}
        >
          {isRunning ? t('agentnodesPage.review.runningReview') : t('agentnodesPage.review.runReviewCta')}
        </button>
      </div>
    </div>
  );
}
