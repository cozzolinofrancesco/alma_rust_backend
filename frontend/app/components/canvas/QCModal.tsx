'use client';

import diff_match_patch from 'diff-match-patch';
import { CheckSquare, X } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../../contexts/ThemeContext';
import styles from '../../styles/canvas/MainEditor.module.css';

interface DataPoint {
  parameter: string;
  value: string;
  unit?: string;
  source?: string;
}

interface ExtractionResult {
  pdfName: string;
  dataPoints: DataPoint[];
  raw?: string;
}

interface ParameterDiff {
  parameter: string;
  valuesByPdf: Record<string, string>;
  pdfs: string[];
}

interface ComparisonRow {
  parameter: string;
  corpusValue: string;
  corpusSourcePdf: string;
  generatedValue: string;
  match: boolean;
}

const DIFF_EQUAL = 0;
const DIFF_DELETE = -1;
const DIFF_INSERT = 1;

function InlineValueDiff({ oldVal, newVal }: { oldVal: string; newVal: string }) {
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(oldVal, newVal);
  dmp.diff_cleanupSemantic(diffs);

  return (
    <span className="font-mono text-sm">
      {diffs.map(([op, text]: [number, string], idx: number) => {
        if (op === DIFF_EQUAL) return <span key={idx}>{text}</span>;
        if (op === DIFF_INSERT) return <span key={idx} className="bg-green-600 text-white rounded px-0.5">{text}</span>;
        if (op === DIFF_DELETE) return <span key={idx} className="bg-red-600 text-white line-through rounded px-0.5">{text}</span>;
        return null;
      })}
    </span>
  );
}

interface QCModalProps {
  isOpen: boolean;
  onClose: () => void;
  corpusId: string | null;
  stepName?: string;
  generatedText?: string;
}

export default function QCModal({ isOpen, onClose, corpusId, stepName, generatedText }: QCModalProps) {
  const { theme } = useTheme();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [_extractions, setExtractions] = useState<ExtractionResult[]>([]);
  const [diffs, setDiffs] = useState<ParameterDiff[]>([]);
  const [comparisonTable, setComparisonTable] = useState<ComparisonRow[]>([]);

  const runQC = useCallback(async () => {
    if (!corpusId) return;
    setLoading(true);
    setError(null);
    setExtractions([]);
    setDiffs([]);
    setComparisonTable([]);
    try {
      const res = await fetch('/api/rag/qc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ corpusId, generatedText: generatedText ?? '' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'QC failed');
      setExtractions(data.extractions ?? []);
      setDiffs(data.diffs ?? []);
      setComparisonTable(data.comparisonTable ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'QC extraction failed');
    } finally {
      setLoading(false);
    }
  }, [corpusId, generatedText]);

  useEffect(() => {
    if (isOpen && corpusId) {
      runQC();
    }
  }, [isOpen, corpusId, runQC]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  if (!isOpen) return null;

  const content = (
    <div
      className={styles.dialogOverlayExport}
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="qc-modal-title"
    >
      <div
        className={`${styles.dialogContentExport} ${theme.cardBg} ${theme.borderColor}`}
        style={{ maxWidth: '90vw', width: 720, maxHeight: '85vh' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 id="qc-modal-title" className={`${styles.dialogTitle} ${theme.textPrimary} flex items-center gap-2`}>
            <CheckSquare className="w-5 h-5" />
            QC - Quality Control
            {stepName && <span className={`text-sm font-normal ${theme.textSecondary}`}>({stepName})</span>}
          </h3>
          <button
            onClick={onClose}
            className={`p-1 rounded ${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover}`}
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {!corpusId ? (
          <p className={`${theme.textSecondary} py-4`}>
            No RAG Knowledge Source selected for this step. Select a corpus in the Agents panel for this step, then try again.
          </p>
        ) : loading ? (
          <div className="flex flex-col items-center justify-center py-12 gap-4">
            <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <p className={`${theme.textSecondary}`}>
              {generatedText?.trim() ? 'Extracting from corpus & generated text…' : 'Extracting data from corpus PDFs…'}
            </p>
          </div>
        ) : error ? (
          <p className={`text-red-600 dark:text-red-400 py-4`}>{error}</p>
        ) : (
          <div className={`${styles.dialogSection} ${theme.bg} ${theme.borderColor} overflow-y-auto`} style={{ maxHeight: '60vh' }}>
            {}
            {comparisonTable.length > 0 && (
              <div className="mb-4">
                <p className={`${styles.dialogSectionTitle} ${theme.textSecondary} mb-2`}>
                  Corpus vs Text Generated ({comparisonTable.length} parameters)
                </p>
                <div className="overflow-x-auto rounded border border-inherit">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className={`${theme.bg} border-b ${theme.borderColor}`}>
                        <th className={`text-left py-2 px-3 font-medium ${theme.textPrimary}`}>Parameter</th>
                        <th className={`text-left py-2 px-3 font-medium ${theme.textPrimary}`}>Source PDF</th>
                        <th className={`text-left py-2 px-3 font-medium ${theme.textPrimary}`} title="Value extracted from the source PDF">In source document</th>
                        <th className={`text-left py-2 px-3 font-medium ${theme.textPrimary}`} title="Value from the AI-generated step output">In generated text</th>
                        <th className={`text-left py-2 px-3 font-medium ${theme.textPrimary} w-20`}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparisonTable.map((row, i) => (
                        <tr key={i} className={`border-b ${theme.borderColor} ${row.match ? '' : 'bg-amber-500/10'}`}>
                          <td className={`py-2 px-3 font-medium ${theme.textPrimary}`}>{row.parameter}</td>
                          <td className={`py-2 px-3 ${theme.textSecondary} text-xs`} title="File name from corpus metadata (files[].name)">
                            {row.corpusSourcePdf || '—'}
                          </td>
                          <td className={`py-2 px-3 ${theme.textSecondary} font-mono text-xs`}>{row.corpusValue}</td>
                          <td className={`py-2 px-3 ${theme.textSecondary} font-mono text-xs`}>
                            {row.match ? row.generatedValue : (
                              <InlineValueDiff oldVal={row.corpusValue} newVal={row.generatedValue} />
                            )}
                          </td>
                          <td className="py-2 px-3">
                            {row.match ? (
                              <span className="text-green-600 dark:text-green-400">✓</span>
                            ) : (
                              <span className="text-amber-600 dark:text-amber-400">diff</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {}
            {diffs.length > 0 && (
              <div className="mb-4">
                <p className={`${styles.dialogSectionTitle} ${theme.textSecondary} mb-2`}>
                  Parameter differences across PDFs ({diffs.length})
                </p>
                <ul className="space-y-3">
                  {diffs.map((d, i) => {
                    const pdfNames = d.pdfs;
                    const vals = pdfNames.map(p => d.valuesByPdf[p]);
                    return (
                      <li key={i} className={`p-3 rounded border ${theme.borderColor} ${theme.bg}`}>
                        <div className={`font-medium ${theme.textPrimary} mb-2`}>{d.parameter}</div>
                        <div className="space-y-1.5 text-sm">
                          {pdfNames.map((pdf, j) => (
                            <div key={pdf} className="flex items-baseline gap-2">
                              <span className={`${theme.textSecondary} shrink-0`}>{pdf}:</span>
                              {j > 0 && vals[j] !== vals[0] ? (
                                <InlineValueDiff oldVal={vals[0]} newVal={vals[j]} />
                              ) : (
                                <span className={theme.textPrimary}>{vals[j]}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {comparisonTable.length === 0 && diffs.length === 0 && (
              <p className={`${theme.textSecondary} py-2`}>
                {generatedText?.trim()
                  ? 'No parameters extracted for comparison.'
                  : 'No parameter differences across PDFs. Add generated text to compare with corpus.'}
              </p>
            )}
          </div>
        )}

        <div className={`${styles.dialogButtons} mt-4`}>
          <button
            onClick={onClose}
            className={`${styles.dialogButton} ${styles.dialogButtonSecondary} ${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover}`}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
