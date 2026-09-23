'use client';

import { useState } from 'react';
import { useLanguage } from '../../../contexts/LanguageContext';
import type { ReviewRun, ReviewReport, Severity, ReviewerId } from '../../lib/reviewers/types';
import { reviewerLocalizedAnchor, reviewerLocalizedName } from '../../lib/reviewers/labels';

interface ReviewPanelProps {
  run: ReviewRun;
  isStale: boolean;
  onAcknowledge: (reviewerId: ReviewerId, commentId: string, acked: boolean) => void;
  onJumpToStep?: (stepNumber: string) => void;
}

const SEVERITY_CLASS: Record<Severity, string> = {
  info: 'an-review-comment--info',
  warn: 'an-review-comment--warn',
  block: 'an-review-comment--block',
};

const SEVERITY_ICON: Record<Severity, string> = {
  info: 'ℹ',
  warn: '⚠',
  block: '⛔',
};

function severityCodeLabel(t: (k: string) => string, sev: Severity): string {
  if (sev === 'block') return t('agentnodesPage.review.severityCodeBlock');
  if (sev === 'warn') return t('agentnodesPage.review.severityCodeWarn');
  return t('agentnodesPage.review.severityCodeInfo');
}

function ReviewReportSection({
  report,
  onAcknowledge,
  onJumpToStep,
  t,
}: {
  report: ReviewReport;
  onAcknowledge: (reviewerId: ReviewerId, commentId: string, acked: boolean) => void;
  onJumpToStep?: (stepNumber: string) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [open, setOpen] = useState(true);
  const displayName = reviewerLocalizedName(t, report.reviewerId);

  const blockCount = report.comments.filter((c) => c.severity === 'block').length;
  const warnCount = report.comments.filter((c) => c.severity === 'warn').length;
  const infoCount = report.comments.filter((c) => c.severity === 'info').length;

  return (
    <div className={`an-review-section ${open ? 'an-review-section--open' : ''}`}>
      <button
        type="button"
        className="an-review-section__header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="an-review-section__name">{displayName}</span>
        <span className="an-review-section__anchor">{reviewerLocalizedAnchor(t, report.reviewerId)}</span>
        <span className="an-review-section__counts">
          {report.comments.length === 0 ? (
            <span className="an-review-count an-review-count--muted">{t('agentnodesPage.review.noObservations')}</span>
          ) : (
            <>
              {blockCount > 0 && (
                <span className="an-review-count an-review-count--block">⛔ {blockCount}</span>
              )}
              {warnCount > 0 && (
                <span className="an-review-count an-review-count--warn">⚠ {warnCount}</span>
              )}
              {infoCount > 0 && (
                <span className="an-review-count an-review-count--info">ℹ {infoCount}</span>
              )}
            </>
          )}
        </span>
        <span className="an-review-section__caret" aria-hidden>{open ? '▲' : '▾'}</span>
      </button>

      {open && (
        <div className="an-review-section__body">
          {report.comments.length === 0 ? (
            <div className="an-review-empty">{t('agentnodesPage.review.noObservationsReviewer')}</div>
          ) : (
            report.comments.map((comment) => (
              <div
                key={comment.id}
                className={`an-review-comment ${SEVERITY_CLASS[comment.severity]}${comment.acknowledged ? ' an-review-comment--acked' : ''}`}
              >
                <div className="an-review-comment__header">
                  <span className="an-review-comment__icon" aria-hidden>{SEVERITY_ICON[comment.severity]}</span>
                  <span className="an-review-comment__step">
                    {t('agentnodesPage.review.stepPrefix', { step: comment.stepNumber })}
                  </span>
                  <span className="an-review-comment__severity">{severityCodeLabel(t, comment.severity)}</span>
                  {comment.acknowledged && (
                    <span className="an-review-comment__acked-badge">{t('agentnodesPage.review.acknowledgedBadge')}</span>
                  )}
                </div>
                <div className="an-review-comment__text">{comment.text}</div>
                <div className="an-review-comment__actions">
                  <button
                    type="button"
                    className="an-review-comment__action"
                    onClick={() => onAcknowledge(report.reviewerId, comment.id, !comment.acknowledged)}
                  >
                    {comment.acknowledged ? t('agentnodesPage.review.unacknowledge') : t('agentnodesPage.review.acknowledge')}
                  </button>
                  {onJumpToStep && (
                    <button
                      type="button"
                      className="an-review-comment__action an-review-comment__action--jump"
                      title={t('agentnodesPage.review.jumpToStepTitle')}
                      onClick={() => onJumpToStep(comment.stepNumber)}
                    >
                      {t('agentnodesPage.review.jumpToStep')}
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default function ReviewPanel({
  run,
  isStale,
  onAcknowledge,
  onJumpToStep,
}: ReviewPanelProps) {
  const { t } = useLanguage();

  const ranAt = (() => {
    try {
      const ms = Date.now() - new Date(run.finishedAt).getTime();
      const secs = Math.floor(ms / 1000);
      if (secs < 60) return t('agentnodesPage.review.relativeSeconds', { secs });
      const mins = Math.floor(secs / 60);
      if (mins < 60) return t('agentnodesPage.review.relativeMinutes', { mins });
      return t('agentnodesPage.review.relativeHours', { hours: Math.floor(mins / 60) });
    } catch {
      return run.finishedAt;
    }
  })();

  const totalBlock = run.reports.reduce(
    (n, r) => n + r.comments.filter((c) => c.severity === 'block').length,
    0,
  );
  const totalWarn = run.reports.reduce(
    (n, r) => n + r.comments.filter((c) => c.severity === 'warn').length,
    0,
  );
  const totalInfo = run.reports.reduce(
    (n, r) => n + r.comments.filter((c) => c.severity === 'info').length,
    0,
  );

  return (
    <div className="an-review-panel">
      <div className={`an-review-panel__meta ${isStale ? 'an-review-panel__meta--stale' : ''}`}>
        <span className="an-review-panel__readonly-badge">{t('agentnodesPage.review.readonlyPanelBadge')}</span>
        <span className="an-review-panel__timestamp">
          {t('agentnodesPage.review.lastRunPrefix', { time: ranAt })}
        </span>
        {isStale && (
          <span className="an-review-panel__stale-badge">
            {t('agentnodesPage.review.staleBanner')}
          </span>
        )}
        <span className="an-review-panel__summary">
          {totalBlock > 0 && (
            <span className="an-review-count an-review-count--block">
              ⛔ {totalBlock} {t('agentnodesPage.review.summaryBlockingWord')}
            </span>
          )}
          {totalWarn > 0 && (
            <span className="an-review-count an-review-count--warn">
              ⚠ {totalWarn} {t('agentnodesPage.review.summaryAdvisoryWord')}
            </span>
          )}
          {totalInfo > 0 && (
            <span className="an-review-count an-review-count--info">
              ℹ {totalInfo} {t('agentnodesPage.review.summaryInformationalWord')}
            </span>
          )}
          {totalBlock === 0 && totalWarn === 0 && totalInfo === 0 && (
            <span className="an-review-count an-review-count--muted">{t('agentnodesPage.review.noObservationsLastRun')}</span>
          )}
        </span>
      </div>

      <div className="an-review-panel__sections">
        {run.reports.map((report) => (
          <ReviewReportSection
            key={report.reviewerId}
            report={report}
            onAcknowledge={onAcknowledge}
            onJumpToStep={onJumpToStep}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}
