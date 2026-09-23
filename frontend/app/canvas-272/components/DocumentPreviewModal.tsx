'use client';

import 'katex/dist/katex.min.css';
import { useEffect, useMemo } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import type { StructuredDoc } from '../lib/exportFormatter';
import { structuredDocToMarkdown } from '../lib/exportFormatter';
import { markdownToCleanHtmlSync } from '../lib/markdownToHtml';

interface DocumentPreviewModalProps {
  open: boolean;
  doc: StructuredDoc | null;
  onClose: () => void;
  onExportGoogleDoc: () => void;
  onExportPdf: () => void;
  onExportDocx: () => void;
  exporting: boolean;
}

export default function DocumentPreviewModal({
  open,
  doc,
  onClose,
  onExportGoogleDoc,
  onExportPdf,
  onExportDocx,
  exporting,
}: DocumentPreviewModalProps) {
  const { t } = useLanguage();
  const html = useMemo(() => {
    if (!doc) return '';
    return markdownToCleanHtmlSync(structuredDocToMarkdown(doc));
  }, [doc]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open || !doc) return null;

  const exportedAtLabel = (() => {
    try {
      return new Date(doc.exportedAt).toLocaleString();
    } catch {
      return doc.exportedAt;
    }
  })();

  return (
    <div
      className="c272-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('canvas272Page.documentPreview')}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="c272-modal c272-modal--preview-only">
        <div className="c272-modal__header">
          <div className="c272-modal__title">
            <span>{t('canvas272Page.documentPreview')}</span>
            <span className="c272-modal__sub">
              {doc.agentName} • {t('canvas272Page.builtAt', { date: exportedAtLabel })}
            </span>
          </div>
          <div className="c272-modal__spacer" />
          <button
            type="button"
            className="c272-icon-btn"
            onClick={onClose}
            aria-label={t('canvas272Page.closePreview')}
            title={t('canvas272Page.closeModal')}
          >
            ✕
          </button>
        </div>

        <div className="c272-modal__body">
          <div className="c272-modal__pane">
            <div
              className="c272-modal__preview markdown-body"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        </div>

        <div className="c272-modal__footer">
          <div className="c272-modal__stats">
            <strong>{doc.sections.length}</strong>
            <span>{doc.sections.length === 1 ? t('canvas272Page.sectionSingle') : t('canvas272Page.sectionPlural')}</span>
            <strong>
              {doc.sections.reduce((acc, s) => acc + s.steps.length, 0)}
            </strong>
            <span>{t('canvas272Page.stepsLabel')}</span>
          </div>
          <div className="c272-modal__spacer" />
          <button
            type="button"
            className="c272-btn"
            onClick={onExportPdf}
            disabled={exporting}
          >
            {t('canvas272Page.downloadPdf')}
          </button>
          <button
            type="button"
            className="c272-btn"
            onClick={onExportDocx}
            disabled={exporting}
          >
            {t('canvas272Page.downloadDocx')}
          </button>
          <button
            type="button"
            className="c272-btn c272-btn--primary"
            onClick={onExportGoogleDoc}
            disabled={exporting}
          >
            {exporting ? t('canvas272Page.exporting') : t('canvas272Page.createGoogleDoc')}
          </button>
        </div>
      </div>
    </div>
  );
}
