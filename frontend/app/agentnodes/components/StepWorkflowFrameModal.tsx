'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';

interface StepWorkflowFrameModalProps {
  open: boolean;
  agentId: string | null;
  stepId: string | null;
  agentName?: string | null;
  stepTitle?: string | null;
  onClose: () => void;
}

export default function StepWorkflowFrameModal({
  open,
  agentId,
  stepId,
  agentName,
  stepTitle,
  onClose,
}: StepWorkflowFrameModalProps) {
  const { t } = useLanguage();
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    closeBtnRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const src = useMemo(() => {
    if (!agentId) return null;
    const params = new URLSearchParams({ embed: '1' });
    if (stepId) params.set('step', stepId);
    return `/ai-agents/edit/${encodeURIComponent(agentId)}?${params.toString()}`;
  }, [agentId, stepId]);

  if (!open || !src) return null;

  return (
    <div
      className="c272-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('agentnodesPage.frameModal.aria')}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="c272-modal an-popup an-frame-modal">
        <div className="c272-modal__header an-popup__header">
          <div className="c272-modal__title">
            <span>
              {stepTitle
                ? t('agentnodesPage.frameModal.titleWithStep', { name: stepTitle })
                : stepId
                  ? t('agentnodesPage.frameModal.titleEditor')
                  : t('agentnodesPage.frameModal.titleAgent')}
            </span>
            <span className="c272-modal__sub">
              {agentName
                ? `${t('agentnodesPage.frameModal.subPrefix')} • ${agentName}`
                : t('agentnodesPage.frameModal.subPrefix')}
            </span>
          </div>
          <div className="c272-modal__spacer" />
          <button
            ref={closeBtnRef}
            type="button"
            className="c272-modal__close"
            aria-label={t('agentnodesPage.common.close')}
            title={t('agentnodesPage.common.closeEsc')}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="an-frame-modal__body">
          <iframe
            key={src}
            src={src}
            title={t('agentnodesPage.frameModal.iframeTitle')}
            className="an-frame-modal__iframe"
          />
        </div>
      </div>
    </div>
  );
}
