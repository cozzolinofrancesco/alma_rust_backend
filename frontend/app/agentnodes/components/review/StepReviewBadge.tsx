'use client';

import { useLanguage } from '../../../contexts/LanguageContext';

export type BadgeState = 'pass' | 'warn' | 'block';

interface StepReviewBadgeProps {
  state: BadgeState;
  onClick?: () => void;
}

const LABEL: Record<BadgeState, string> = {
  pass: '✓',
  warn: '⚠',
  block: '⛔',
};

export default function StepReviewBadge({ state, onClick }: StepReviewBadgeProps) {
  const { t } = useLanguage();
  const title =
    state === 'pass'
      ? t('agentnodesPage.review.badgePassTitle')
      : state === 'warn'
        ? t('agentnodesPage.review.badgeWarnTitle')
        : t('agentnodesPage.review.badgeBlockTitle');

  return (
    <button
      type="button"
      className={`an-step-review-badge an-step-review-badge--${state}`}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      aria-label={title}
    >
      {LABEL[state]}
    </button>
  );
}

import type { ReviewRun } from '../../lib/reviewers/types';

export function getBadgeStateForStep(
  run: ReviewRun | null,
  isStale: boolean,
  stepNumber: string,
): BadgeState | null {
  if (!run || isStale) return null;

  let hasBlock = false;
  let hasWarn = false;

  for (const report of run.reports) {
    for (const comment of report.comments) {
      if (comment.stepNumber !== stepNumber) continue;
      if (comment.severity === 'block') hasBlock = true;
      else if (comment.severity === 'warn') hasWarn = true;
    }
  }

  if (hasBlock) return 'block';
  if (hasWarn) return 'warn';
  return 'pass';
}
