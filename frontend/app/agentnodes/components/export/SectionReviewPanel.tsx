'use client';

import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from 'lucide-react';
import { CSSProperties, useEffect, useState } from 'react';
import type { StructuredDoc, StructuredDocSection } from '../../../canvas-272/lib/exportFormatter';
import { useLanguage } from '../../../contexts/LanguageContext';
import { REVIEWERS } from '../../lib/reviewers/registry';
import { detectPresetFromSelection, REVIEW_PRESETS, type ReviewPresetId } from '../../lib/reviewers/presets';
import { reviewPresetDescription, reviewPresetLabel, reviewerLocalizedAnchor, reviewerLocalizedDescription, reviewerLocalizedName } from '../../lib/reviewers/labels';
import type { ReviewRun, ReviewerId, Severity } from '../../lib/reviewers/types';

interface SectionReviewPanelProps {
  sections: StructuredDocSection[];
  activeSection: number | null;
  lastAnalysedSection?: number | null;
  doc: StructuredDoc;
  latestRun: ReviewRun | null;
  isStale: boolean;
  isRunning: boolean;
  runError: string | null;
  onRunSection: (reviewerIds: ReviewerId[], sectionIdx: number) => void;
  onAcknowledge: (reviewerId: ReviewerId, commentId: string, acked: boolean) => void;
  style?: CSSProperties;
}

function severityIcon(severity: Severity) {
  switch (severity) {
    case 'block': return <XCircle size={13} className="an-srev__icon an-srev__icon--block" />;
    case 'warn':  return <AlertTriangle size={13} className="an-srev__icon an-srev__icon--warn" />;
    case 'info':  return <Info size={13} className="an-srev__icon an-srev__icon--info" />;
  }
}

function FindingsSummary({
  comments,
  t,
}: {
  comments: { severity: Severity }[];
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  let block = 0;
  let warn = 0;
  let info = 0;
  for (const c of comments) {
    if (c.severity === 'block') block++;
    else if (c.severity === 'warn') warn++;
    else info++;
  }
  const parts: string[] = [];
  if (block > 0) parts.push(t('agentnodesPage.review.findingsBlock', { count: block }));
  if (warn > 0) parts.push(t('agentnodesPage.review.findingsWarn', { count: warn }));
  if (info > 0) parts.push(t('agentnodesPage.review.findingsInfo', { count: info }));
  const label = parts.length > 0 ? parts.join(' · ') : t('agentnodesPage.review.findingsObservations');
  return <span className="an-srev__findings-summary">{label}</span>;
}

export default function SectionReviewPanel({
  sections,
  activeSection,
  lastAnalysedSection = null,
  doc: _doc,
  latestRun,
  isStale: _isStale,
  isRunning,
  runError,
  onRunSection,
  onAcknowledge,
  style,
}: SectionReviewPanelProps) {
  const { t } = useLanguage();
  const [selected, setSelected] = useState<Set<ReviewerId>>(
    new Set<ReviewerId>(['document-quality']),
  );
  const [showAllReviewers, setShowAllReviewers] = useState(false);

  useEffect(() => {
    setShowAllReviewers(false);
  }, [activeSection]);

  if (activeSection === null) {
    return (
      <aside className="an-section-review" style={style}>
        <div className="an-section-review__empty">
          <Info size={22} className="an-section-review__empty-icon" />
          <p>{t('agentnodesPage.review.selectSectionEmpty')}</p>
        </div>
      </aside>
    );
  }

  const currentSection = sections[activeSection];
  if (!currentSection) return null;

  const activeSectionStepNumbers = new Set(currentSection.steps.map((s) => s.number));

  const useFallback =
    !!latestRun &&
    lastAnalysedSection === activeSection &&
    latestRun.reports.every((r) =>
      r.comments.every((c) => !activeSectionStepNumbers.has(c.stepNumber)),
    ) &&
    latestRun.reports.some((r) => r.comments.length > 0);

  const threadsForSection = latestRun
    ? latestRun.reports
        .map((report) => {
          const sectionComments = useFallback
            ? report.comments
            : report.comments.filter((c) => activeSectionStepNumbers.has(c.stepNumber));
          return { report, sectionComments };
        })
        .filter(({ sectionComments }) => sectionComments.length > 0)
    : [];

  const hasCommentsForSection = threadsForSection.length > 0;

  const lastRunForThisSectionNoObservations =
    !!latestRun &&
    lastAnalysedSection === activeSection &&
    !hasCommentsForSection &&
    !runError &&
    !isRunning;

  const activePreset = detectPresetFromSelection(selected);
  const presetMeta =
    activePreset === 'custom' ? null : REVIEW_PRESETS.find((p) => p.id === activePreset);

  const toggle = (id: ReviewerId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const applyPreset = (presetId: ReviewPresetId) => {
    if (presetId === 'custom') return;
    const preset = REVIEW_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setSelected(new Set(preset.reviewerIds));
    setShowAllReviewers(false);
  };

  const handleAnalyse = () => {
    if (selected.size === 0 || isRunning || activeSection === null) return;
    onRunSection(Array.from(selected), activeSection);
  };

  const mustShowAllReviewers = selected.size === 0 || showAllReviewers;
  const visibleReviewers = mustShowAllReviewers
    ? REVIEWERS
    : REVIEWERS.filter((r) => selected.has(r.id));

  const selectedCountLabel =
    selected.size === 0
      ? t('agentnodesPage.review.noReviewersSelected')
      : selected.size === 1
        ? t('agentnodesPage.review.reviewersSelectedOne')
        : t('agentnodesPage.review.reviewersSelectedMany', { count: selected.size });

  const presetHintTitle =
    presetMeta && activePreset !== 'custom'
      ? reviewPresetDescription(t, activePreset)
      : undefined;

  const presetHintBody =
    presetMeta && activePreset !== 'custom'
      ? reviewPresetDescription(t, activePreset)
      : t('agentnodesPage.review.presetHintDefault');

  return (
    <aside className="an-section-review" style={style}>
      <div className="an-section-review__header">
        <span className="an-section-review__section-name">
          {currentSection.heading ?? t('agentnodesPage.common.prelude')}
        </span>
        {!hasCommentsForSection && (
          <span className="an-srev__readonly-badge">{t('agentnodesPage.review.readonlyBadgeShort')}</span>
        )}
      </div>

      {runError && (
        <div className="an-srev__run-error">{runError}</div>
      )}

      <div className="an-srev__preset-row">
        <label htmlFor="an-srev-preset-select" className="an-srev__preset-label">
          {t('agentnodesPage.review.presetBundleLabel')}
        </label>
        <select
          id="an-srev-preset-select"
          className="an-srev__preset-select"
          value={activePreset === 'custom' ? '' : activePreset}
          disabled={isRunning}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            applyPreset(v as ReviewPresetId);
          }}
        >
          {activePreset === 'custom' && (
            <option value="">{t('agentnodesPage.review.mixedPresetOption')}</option>
          )}
          {REVIEW_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {reviewPresetLabel(t, p.id)}
            </option>
          ))}
        </select>
        <p className="an-srev__preset-hint" title={presetHintTitle}>
          {presetHintBody}
        </p>
      </div>

      <div className="an-section-review__footer an-section-review__footer--sticky-run">
        <span className="an-srev__count">{selectedCountLabel}</span>
        <button
          type="button"
          className="c272-btn c272-btn--primary"
          disabled={selected.size === 0 || isRunning}
          onClick={handleAnalyse}
        >
          {isRunning
            ? <><Loader2 size={13} className="c272-spin" /> {t('agentnodesPage.review.running')}</>
            : hasCommentsForSection ? t('agentnodesPage.review.reanalyseSection') : t('agentnodesPage.review.analyseSection')}
        </button>
      </div>

      <div className="an-section-review__reviewer-list">
        {visibleReviewers.map((r) => (
          <label key={r.id} className="an-srev__reviewer-card">
            <input
              type="checkbox"
              className="an-srev__reviewer-checkbox"
              checked={selected.has(r.id)}
              onChange={() => toggle(r.id)}
              disabled={isRunning}
            />
            <span className="an-srev__reviewer-body">
              <span className="an-srev__reviewer-name">{reviewerLocalizedName(t, r.id)}</span>
              <span className="an-srev__reviewer-anchor">{reviewerLocalizedAnchor(t, r.id)}</span>
              <span className="an-srev__reviewer-desc">{reviewerLocalizedDescription(t, r.id)}</span>
            </span>
          </label>
        ))}
      </div>
      {selected.size > 0 && (
        <div className="an-srev__reviewer-list-toggle">
          <button
            type="button"
            className="an-srev__expand-link"
            disabled={isRunning}
            onClick={() => setShowAllReviewers((v) => !v)}
          >
            {showAllReviewers ? t('agentnodesPage.review.showOnlySelected') : t('agentnodesPage.review.showAllReviewers')}
          </button>
        </div>
      )}

      {lastRunForThisSectionNoObservations && (
        <p className="an-srev__last-run-note">
          {t('agentnodesPage.review.lastRunNoObservations')}
        </p>
      )}

      {hasCommentsForSection && (
        <div className="an-section-review__threads">
          {threadsForSection.map(({ report, sectionComments }) => (
            <div key={report.reviewerId} className="an-section-comment-thread">
              <div className="an-section-comment__header">
                <span className="an-srev__reviewer-pill">
                  {reviewerLocalizedName(t, report.reviewerId)}
                </span>
                <FindingsSummary comments={sectionComments} t={t} />
              </div>
              <div className="an-section-comment__items">
                {sectionComments.map((comment) => (
                  <div
                    key={comment.id}
                    className={`an-section-comment__item${comment.acknowledged ? ' an-section-comment__item--acked' : ''} an-section-comment__item--${comment.severity}`}
                  >
                    <div className="an-section-comment__item-header">
                      {severityIcon(comment.severity)}
                      <span className="an-section-comment__step-number">
                        {t('agentnodesPage.review.stepPrefix', { step: comment.stepNumber })}
                      </span>
                      {comment.acknowledged && (
                        <CheckCircle2 size={12} className="an-srev__acked-icon" />
                      )}
                    </div>
                    <p className="an-section-comment__text">{comment.text}</p>
                    <button
                      type="button"
                      className="c272-btn c272-btn--sm an-section-comment__ack-btn"
                      onClick={() => onAcknowledge(report.reviewerId, comment.id, !comment.acknowledged)}
                    >
                      {comment.acknowledged ? t('agentnodesPage.review.unacknowledge') : t('agentnodesPage.review.acknowledge')}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
