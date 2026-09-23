'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useLanguage } from '../../contexts/LanguageContext';

interface RunAllConfirmModalProps {
  open: boolean;
  stepCount: number;
  onClose: () => void;
  onConfirm: () => void;
}

export default function RunAllConfirmModal({
  open,
  stepCount,
  onClose,
  onConfirm,
}: RunAllConfirmModalProps) {
  const { t } = useLanguage();

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  const stepLabel =
    stepCount === 1
      ? t('agentnodesPage.runAll.stepOne')
      : t('agentnodesPage.runAll.stepMany', { count: stepCount });

  return createPortal(
    <div
      className="c272-modal-backdrop an-run-all-confirm-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="an-run-all-confirm-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="c272-modal an-run-all-confirm-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="c272-modal__header">
          <span className="an-run-all-confirm-modal__icon" aria-hidden>▶</span>
          <h2 className="c272-modal__title" id="an-run-all-confirm-title">
            {t('agentnodesPage.runAll.title')}
          </h2>
          <button
            type="button"
            className="c272-modal__close"
            onClick={onClose}
            aria-label={t('agentnodesPage.common.close')}
          >
            ✕
          </button>
        </div>

        <div className="c272-modal__body an-run-all-confirm-modal__body">
          <p className="an-run-all-confirm-modal__text">
            {t('agentnodesPage.runAll.body', { stepCount: stepLabel })}
          </p>
          <p className="an-run-all-confirm-modal__sub">{t('agentnodesPage.runAll.sub')}</p>
        </div>

        <div className="c272-modal__footer an-run-all-confirm-modal__footer">
          <button type="button" className="c272-btn" onClick={onClose}>
            {t('agentnodesPage.common.cancel')}
          </button>
          <div className="c272-modal__spacer" />
          <button type="button" className="c272-btn c272-btn--primary" onClick={onConfirm}>
            {t('agentnodesPage.runAll.confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
