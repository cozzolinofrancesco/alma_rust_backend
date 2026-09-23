'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TutorialAction, TutorialStep } from './ContentVariants';
import { TutorialStep as TutorialStepView } from './TutorialStep';
import './spotlight-tour.css';
import './tutorial.css';

const HOLE_PADDING = 8;

function queryTarget(target: string): Element | null {
  try {
    return document.querySelector(`[data-tour="${CSS.escape(target)}"]`);
  } catch {
    return document.querySelector(`[data-tour="${target}"]`);
  }
}

function getHoleRect(target: string | undefined): { top: number; left: number; width: number; height: number } | null {
  if (!target) return null;
  const el = queryTarget(target);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  return {
    top: r.top - HOLE_PADDING,
    left: r.left - HOLE_PADDING,
    width: r.width + HOLE_PADDING * 2,
    height: r.height + HOLE_PADDING * 2,
  };
}

export interface SpotlightTourLabels {
  previous: string;
  next: string;
  finish: string;
  progressOf: (args: { current: number; total: number }) => string;
  closeAria: string;
}

export interface SpotlightTourProps {
  open: boolean;
  onClose: () => void;
  steps: TutorialStep[];
  onBeforeStep?: (step: TutorialStep) => void;
  onAction?: (action: TutorialAction) => void;
  title: string;
  labels: SpotlightTourLabels;
  renderStepContent?: (step: TutorialStep) => ReactNode | null;
}

export function SpotlightTour({
  open,
  onClose,
  steps,
  onBeforeStep,
  onAction,
  title,
  labels,
  renderStepContent,
}: SpotlightTourProps) {
  const reactId = useId();
  const titleId = `${reactId}-spotlight-title`;
  const [activeIndex, setActiveIndex] = useState(0);
  const [hole, setHole] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);

  const prevOpenRef = useRef(false);
  const stepsRef = useRef(steps);
  const onBeforeStepRef = useRef(onBeforeStep);
  const onCloseRef = useRef(onClose);
  stepsRef.current = steps;
  onBeforeStepRef.current = onBeforeStep;
  onCloseRef.current = onClose;

  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return undefined;
    const apply = () => setPrefersReducedMotion(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  const totalSteps = steps.length;
  const currentStep = steps[activeIndex] ?? null;

  const syncHoleFromDom = useCallback(() => {
    if (!open || !currentStep) return;
    const h = getHoleRect(currentStep.target);
    setHole(h);
  }, [open, currentStep]);

  useEffect(() => {
    if (!open || !currentStep) return;
    syncHoleFromDom();
  }, [open, currentStep, syncHoleFromDom]);

  useEffect(() => {
    if (!open) return undefined;
    const onScrollOrResize = () => {
      syncHoleFromDom();
    };
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open, syncHoleFromDom]);

  useEffect(() => {
    if (!open) {
      prevOpenRef.current = false;
      setActiveIndex(0);
      setHole(null);
      return;
    }
    if (prevOpenRef.current) {
      return;
    }
    prevOpenRef.current = true;
    setActiveIndex(0);
    setHole(null);
    if (stepsRef.current[0]) {
      onBeforeStepRef.current?.(stepsRef.current[0]);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const canGoPrevious = activeIndex > 0;
  const canGoNext = activeIndex < totalSteps - 1;

  const goPrevious = useCallback(() => {
    if (!canGoPrevious) return;
    const prevIdx = activeIndex - 1;
    if (stepsRef.current[prevIdx]) {
      onBeforeStepRef.current?.(stepsRef.current[prevIdx]);
    }
    setActiveIndex(prevIdx);
  }, [activeIndex, canGoPrevious]);

  const goNext = useCallback(() => {
    if (!canGoNext) {
      onCloseRef.current();
      return;
    }
    const nextIdx = activeIndex + 1;
    if (stepsRef.current[nextIdx]) {
      onBeforeStepRef.current?.(stepsRef.current[nextIdx]);
    }
    setActiveIndex(nextIdx);
  }, [activeIndex, canGoNext]);

  const goToStep = useCallback(
    (index: number) => {
      if (index < 0 || index >= totalSteps) return;
      if (stepsRef.current[index]) {
        onBeforeStepRef.current?.(stepsRef.current[index]);
      }
      setActiveIndex(index);
    },
    [totalSteps],
  );

  const progress = totalSteps === 0 ? 0 : ((activeIndex + 1) / totalSteps) * 100;

  const dimRects = useMemo(() => {
    if (!hole) return null;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    const { top, left, width, height } = hole;
    return {
      top: { top: 0, left: 0, width: vw, height: Math.max(0, top) },
      bottom: {
        top: top + height,
        left: 0,
        width: vw,
        height: Math.max(0, vh - top - height),
      },
      left: { top, left: 0, width: Math.max(0, left), height },
      right: { top, left: left + width, width: Math.max(0, vw - left - width), height },
    };
  }, [hole]);

  const handleAction = useCallback(
    (action: TutorialAction) => {
      onAction?.(action);
    },
    [onAction],
  );

  if (!open || typeof document === 'undefined' || !currentStep || totalSteps === 0) {
    return null;
  }

  const motionClass = prefersReducedMotion ? '' : ' spotlight-tour--motion';

  const portal = (
    <div
      className={`spotlight-tour${motionClass}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      {dimRects ? (
        <>
          <div className="spotlight-tour__dim" style={{ position: 'fixed', ...dimRects.top }} aria-hidden />
          <div className="spotlight-tour__dim" style={{ position: 'fixed', ...dimRects.bottom }} aria-hidden />
          <div className="spotlight-tour__dim" style={{ position: 'fixed', ...dimRects.left }} aria-hidden />
          <div className="spotlight-tour__dim" style={{ position: 'fixed', ...dimRects.right }} aria-hidden />
          <div
            className="spotlight-tour__ring"
            style={{
              top: hole!.top,
              left: hole!.left,
              width: hole!.width,
              height: hole!.height,
            }}
            aria-hidden
          />
        </>
      ) : (
        <div
          className="spotlight-tour__dim"
          style={{ position: 'fixed', inset: 0 }}
          aria-hidden
        />
      )}

      <div
        className="spotlight-tour__tooltip"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="spotlight-tour__tooltip-header">
          <p className="spotlight-tour__tooltip-brand" id={titleId}>
            {title}
          </p>
          <button
            type="button"
            className="spotlight-tour__tooltip-close"
            onClick={() => onCloseRef.current()}
            aria-label={labels.closeAria}
          >
            ×
          </button>
        </div>

        <div className="spotlight-tour__progress-row">
          <div className="spotlight-tour__progress-bar">
            <div className="spotlight-tour__progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <span className="spotlight-tour__progress-text">
            {labels.progressOf({ current: activeIndex + 1, total: totalSteps })}
          </span>
        </div>

        <div className="spotlight-tour__tooltip-body">
          {renderStepContent?.(currentStep) ?? (
            <TutorialStepView step={currentStep} onAction={handleAction} />
          )}
        </div>

        <div className="spotlight-tour__nav">
          <button
            type="button"
            className="spotlight-tour__btn spotlight-tour__btn--secondary"
            onClick={() => goPrevious()}
            disabled={!canGoPrevious}
          >
            {labels.previous}
          </button>

          <div className="spotlight-tour__nav-center">
            <div className="spotlight-tour__dots">
              {steps.map((s, index) => (
                <button
                  key={s.id}
                  type="button"
                  className={`spotlight-tour__dot${index === activeIndex ? ' spotlight-tour__dot--active' : ''}${
                    index < activeIndex ? ' spotlight-tour__dot--done' : ''
                  }`}
                  onClick={() => goToStep(index)}
                  aria-label={labels.progressOf({ current: index + 1, total: totalSteps })}
                />
              ))}
            </div>
          </div>

          <button type="button" className="spotlight-tour__btn spotlight-tour__btn--primary" onClick={() => goNext()}>
            {canGoNext ? labels.next : labels.finish}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(portal, document.body);
}
