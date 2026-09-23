'use client';

import { useEffect, useRef, useState } from 'react';
import nextDynamic from 'next/dynamic';
import { useLanguage } from '../../contexts/LanguageContext';
import type { StructuredDoc } from '../lib/exportFormatter';

const DocumentPreviewModal = nextDynamic(() => import('./DocumentPreviewModal'), { ssr: false });

interface ExportMenuProps {
  disabled: boolean;
  buildDoc: () => StructuredDoc;
  onToast: (message: string) => void;
}

type Status = 'idle' | 'working';

export default function ExportMenu({ disabled, buildDoc, onToast }: ExportMenuProps) {
  const { t } = useLanguage();
  const [open, setOpen] = useState<boolean>(false);
  const [status, setStatus] = useState<Status>('idle');
  const [previewDoc, setPreviewDoc] = useState<StructuredDoc | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const handleClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handleClick);
    return () => window.removeEventListener('mousedown', handleClick);
  }, [open]);

  const fileNameBase = (doc: StructuredDoc): string =>
    `${(doc.title || doc.agentName).replace(/[^a-z0-9-_]+/gi, '_').slice(0, 60) || 'canvas272'}-${Date.now()}`;

  const handlePreview = () => {
    setOpen(false);
    try {
      const doc = buildDoc();
      setPreviewDoc(doc);
    } catch (err) {
      onToast(t('canvas272Page.previewFailed', { error: err instanceof Error ? err.message : 'unknown error' }));
    }
  };

  const handleGoogleDoc = async (doc?: StructuredDoc) => {
    setStatus('working');
    setOpen(false);
    try {
      const target = doc ?? buildDoc();
      const { exportStructuredDocToGoogleDoc } = await import('../lib/exportGoogleDoc');
      const result = await exportStructuredDocToGoogleDoc(target);
      if (result.webViewLink) {
        window.open(result.webViewLink, '_blank', 'noopener,noreferrer');
      }
      onToast(t('canvas272Page.googleDocCreated'));
    } catch (err) {
      onToast(t('canvas272Page.googleDocFailed', { error: err instanceof Error ? err.message : 'unknown error' }));
    } finally {
      setStatus('idle');
    }
  };

  const handlePdf = async (doc?: StructuredDoc) => {
    setStatus('working');
    setOpen(false);
    try {
      const target = doc ?? buildDoc();
      const { exportStructuredDocToPdf } = await import('../lib/exportPdf');
      await exportStructuredDocToPdf(target, `${fileNameBase(target)}.pdf`);
      onToast(t('canvas272Page.pdfSaved'));
    } catch (err) {
      onToast(t('canvas272Page.pdfFailed', { error: err instanceof Error ? err.message : 'unknown error' }));
    } finally {
      setStatus('idle');
    }
  };

  const handleDocx = async (doc?: StructuredDoc) => {
    setStatus('working');
    setOpen(false);
    try {
      const target = doc ?? buildDoc();
      const { exportStructuredDocToDocx } = await import('../lib/exportDocx');
      await exportStructuredDocToDocx(target, `${fileNameBase(target)}.docx`);
      onToast(t('canvas272Page.docxSaved'));
    } catch (err) {
      onToast(t('canvas272Page.docxFailed', { error: err instanceof Error ? err.message : 'unknown error' }));
    } finally {
      setStatus('idle');
    }
  };

  return (
    <>
      <div ref={rootRef} style={{ position: 'relative' }}>
        <button
          type="button"
          className="c272-btn c272-btn--primary"
          disabled={disabled || status === 'working'}
          onClick={() => setOpen((v) => !v)}
        >
          {status === 'working' ? t('canvas272Page.exporting') : t('canvas272Page.exportBtn')}
        </button>
        {open ? (
          <div className="c272-menu" role="menu">
            <button
              type="button"
              className="c272-menu__item"
              onClick={handlePreview}
              disabled={disabled}
            >
              {t('canvas272Page.previewDocument')}
            </button>
            <button
              type="button"
              className="c272-menu__item"
              onClick={() => void handleGoogleDoc()}
              disabled={disabled}
            >
              {t('canvas272Page.createGoogleDoc')}
            </button>
            <button
              type="button"
              className="c272-menu__item"
              onClick={() => void handlePdf()}
              disabled={disabled}
            >
              {t('canvas272Page.downloadPdf')}
            </button>
            <button
              type="button"
              className="c272-menu__item"
              onClick={() => void handleDocx()}
              disabled={disabled}
            >
              {t('canvas272Page.downloadDocx')}
            </button>
          </div>
        ) : null}
      </div>

      <DocumentPreviewModal
        open={previewDoc !== null}
        doc={previewDoc}
        exporting={status === 'working'}
        onClose={() => setPreviewDoc(null)}
        onExportGoogleDoc={() => void handleGoogleDoc(previewDoc ?? undefined)}
        onExportPdf={() => void handlePdf(previewDoc ?? undefined)}
        onExportDocx={() => void handleDocx(previewDoc ?? undefined)}
      />
    </>
  );
}
