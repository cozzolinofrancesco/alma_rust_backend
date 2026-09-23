'use client';

import React, { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';
import type { IntegrityRecord } from '../lib/integrity';
import type { ChainMetadata } from '../api/integrity/list/route';
import styles from './IntegrityChainModal.module.css';

interface IntegrityChainModalProps {
  chain: IntegrityRecord[];
  operationId: string;
  operationName: string;
  onClose: () => void;
  onSave?: (options?: { label?: string; operationType?: string }) => Promise<string>;
  onList?: () => Promise<ChainMetadata[]>;
  onLoad?: (filename: string) => Promise<IntegrityRecord[]>;
}

function ShaLine({ label, sha }: { label: string; sha: string }) {
  const { t } = useLanguage();
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(sha).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={styles.shaLine}>
      <span className={styles.shaLabel} title={label}>{label}</span>
      <code className={styles.shaValue} title={sha}>{sha}</code>
      <button type="button" onClick={copy} className={styles.shaCopyBtn}>
        {copied ? '✓' : t('integrityArchive.shaCopy')}
      </button>
    </div>
  );
}

function StepBlock({ record, index }: { record: IntegrityRecord; index: number }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);

  return (
    <div className={styles.stepBlock}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={styles.stepTrigger}
      >
        <span className={styles.stepIndex}>{index + 1}</span>
        <span className={styles.stepName}>{record.name}</span>
        <span className={styles.stepTime}>{new Date(record.timestamp).toLocaleString()}</span>
        <span className={styles.stepChevron}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className={styles.stepBody}>
          {record.components.map((c, i) => (
            <ShaLine key={i} label={c.label} sha={c.sha} />
          ))}
          <ShaLine label={t('integrityArchive.stepTier2')} sha={record.step_hash} />
          {record.previous_chain_hash && (
            <ShaLine label={t('integrityArchive.previousChain')} sha={record.previous_chain_hash} />
          )}
          <ShaLine label={t('integrityArchive.chainTier3')} sha={record.chain_hash} />
        </div>
      )}
    </div>
  );
}

export default function IntegrityChainModal({
  chain,
  operationId,
  operationName,
  onClose,
  onSave,
}: IntegrityChainModalProps) {
  const { t } = useLanguage();
  const [saving, setSaving] = useState(false);

  const exportJSON = useCallback(
    (records: IntegrityRecord[]) => {
      const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `integrity_chain_${operationId}_${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
    [operationId]
  );

  const handleSave = async () => {
    if (!onSave) return;
    setSaving(true);
    try {
      await onSave({ label: operationName, operationType: operationName });
    } catch (err) {
      console.error('Failed to save chain:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const content = (
    <div
      className={styles.overlay}
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="integrity-chain-modal-title"
    >
      <div className={styles.content} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3 id="integrity-chain-modal-title" className={styles.title}>
            {t('integrityArchive.modalTitle')}
            {operationName && <span className={styles.subtitle}> ({operationName})</span>}
          </h3>
          <button type="button" onClick={onClose} className={styles.closeBtn} aria-label={t('integrityArchive.modalClose')}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className={styles.section}>
          {chain.length === 0 ? (
            <p className={styles.emptyState}>{t('integrityArchive.modalEmpty')}</p>
          ) : (
            <div className="space-y-2">
              {chain.map((record, i) => (
                <StepBlock key={record.id} record={record} index={i} />
              ))}
            </div>
          )}
        </div>

        <div className={styles.footer}>
          <div className={styles.footerLeft}>
            {onSave && chain.length > 0 && (
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className={styles.btnPrimary}
              >
                {saving ? t('integrityArchive.modalSaving') : t('integrityArchive.modalSaveArchive')}
              </button>
            )}
          </div>
          <div className={styles.footerRight}>
            {chain.length > 0 && (
              <button type="button" onClick={() => exportJSON(chain)} className={styles.btnSecondary}>
                {t('integrityArchive.modalExportJson')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
