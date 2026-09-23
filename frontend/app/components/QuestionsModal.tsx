'use client';

import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles } from 'lucide-react';
import AlmaTeamContactCards from './AlmaTeamContactCards';
import { useLanguage } from '../contexts/LanguageContext';
import './questions-modal.css';

interface QuestionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenTraining?: () => void;
  variant?: 'default' | 'dailyHelp';
}

export default function QuestionsModal({
  isOpen,
  onClose,
  onOpenTraining,
  variant = 'default',
}: QuestionsModalProps) {
  const { t } = useLanguage();
  const titleId = useId();
  const subtitleId = useId();
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const isDailyHelp = variant === 'dailyHelp';

  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen) {
      closeBtnRef.current?.focus();
    }
  }, [isOpen]);

  if (!isOpen || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div className="questions-modal-overlay" onClick={onClose} role="presentation">
      <div
        className="questions-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={isDailyHelp ? subtitleId : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="questions-modal-header">
          <div className="questions-modal-header-text">
            <h2 id={titleId} className="questions-modal-title">
              {isDailyHelp ? t('dailyHelpModal.title') : t('questionsModal.title')}
            </h2>
            {isDailyHelp ? (
              <p id={subtitleId} className="questions-modal-subtitle">
                {t('dailyHelpModal.subtitle')}
              </p>
            ) : null}
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            className="questions-modal-close"
            onClick={onClose}
            aria-label={t('questionsModal.close')}
          >
            ×
          </button>
        </div>

        <AlmaTeamContactCards />

        <div className="questions-modal-footer">
          {onOpenTraining && (
            <button
              type="button"
              className="questions-modal-training-btn"
              onClick={() => {
                onClose();
                onOpenTraining();
              }}
            >
              <Sparkles className="w-4 h-4 text-indigo-600 inline mr-1" />
              Platform Training &amp; Quiz
            </button>
          )}
          {isDailyHelp && (
            <button type="button" className="questions-modal-not-now" onClick={onClose}>
              {t('dailyHelpModal.notNow')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
