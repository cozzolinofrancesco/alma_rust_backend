'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useLanguage } from '../../contexts/LanguageContext';

interface SimulateRecordModalProps {
  open: boolean;
  onSimulate: () => void;
  onSimulateAndRecord: () => void;
  onClose: () => void;
}

export default function SimulateRecordModal({
  open,
  onSimulate,
  onSimulateAndRecord,
  onClose,
}: SimulateRecordModalProps) {
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

  return createPortal(
    <div
      className="c272-modal-backdrop an-sim-record-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="an-sim-record-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="c272-modal an-sim-record-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="c272-modal__header">
          <span className="an-sim-record-modal__icon" aria-hidden>⏵</span>
          <h2 className="c272-modal__title" id="an-sim-record-title">
            {t('agentnodesPage.simulate.title')}
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

        <div className="an-sim-record-modal__body">
          <button type="button" className="an-sim-record-option" onClick={onSimulate}>
            <span className="an-sim-record-option__icon" aria-hidden>⏵</span>
            <span className="an-sim-record-option__text">
              <span className="an-sim-record-option__title">{t('agentnodesPage.simulate.justTitle')}</span>
              <span className="an-sim-record-option__desc">{t('agentnodesPage.simulate.justDesc')}</span>
            </span>
          </button>

          <button
            type="button"
            className="an-sim-record-option an-sim-record-option--record"
            onClick={onSimulateAndRecord}
          >
            <span className="an-sim-record-option__icon" aria-hidden>⏺</span>
            <span className="an-sim-record-option__text">
              <span className="an-sim-record-option__title">{t('agentnodesPage.simulate.recordTitle')}</span>
              <span className="an-sim-record-option__desc">{t('agentnodesPage.simulate.recordDesc')}</span>
            </span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
