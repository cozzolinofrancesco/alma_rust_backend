'use client';

import React, { useState } from 'react';
import { useLanguage } from '@/app/contexts/LanguageContext';
import type { Claim, ValidationResult } from '../types';
import type { ResultSummary } from '../lib/resultProcessingService';

interface Props {
  results:         ValidationResult[];
  summary:         ResultSummary;
  claims?:         Claim[];
  onRetryFailed?:  () => void;
  hasFailures:     boolean;
  isRetrying?:     boolean;
}

type StatusKind =
  | 'matching'
  | 'partiallyMatching'
  | 'contradicted'
  | 'insufficientEvidence'
  | 'needsReview'
  | 'failed'
  | 'noEvidence';

const STATUS_KIND_CLASSES: Record<StatusKind, string> = {
  matching: 'bg-green-100  text-green-800  border-green-200',
  partiallyMatching: 'bg-blue-100   text-blue-800   border-blue-200',
  contradicted: 'bg-red-100    text-red-800    border-red-200',
  insufficientEvidence: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  needsReview: 'bg-gray-100 text-gray-700 border-gray-200',
  failed: 'bg-red-100    text-red-700    border-red-200',
  noEvidence: 'bg-orange-100 text-orange-700 border-orange-200',
};

function getStatusKind(r: ValidationResult): StatusKind {
  if (r.run_status === 'failed') return 'failed';
  if (r.run_status === 'skipped') return 'noEvidence';
  switch (r.verdict) {
    case 'supported':
      return 'matching';
    case 'partially_supported':
      return 'partiallyMatching';
    case 'contradicted':
      return 'contradicted';
    case 'insufficient_evidence':
      return 'insufficientEvidence';
    case 'unclear':
    default:
      return 'needsReview';
  }
}

interface ResultsTableProps extends Props {
  selectedForExportIds?: Set<string>;
  onToggleExportSelection?: (resultId: string) => void;
}

function formatExplanationForDisplay(explanation: string, thresholdRewrite: string): string {
  if (!explanation?.trim()) return explanation;
  let text = explanation.trim();
  text = text.replace(
    /MATCH_SCORE\s*=\s*\d+\s+is\s+below\s+the\s+minimum\s+threshold\s*\(\s*\d+\s*\)\s*\.?\s*/gi,
    thresholdRewrite
  );
  text = text.replace(/\bMATCH_SCORE\s*=\s*\d+\b\.?\s*/gi, '').trim();
  text = text.replace(/\s{2,}/g, ' ').trim();
  return text || explanation;
}

export default function ResultsTable({
  results,
  summary,
  claims = [],
  onRetryFailed: _onRetryFailed,
  hasFailures: _hasFailures,
  isRetrying: _isRetrying,
  selectedForExportIds,
  onToggleExportSelection,
}: ResultsTableProps) {
  const { t } = useLanguage();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const toggle = (id: string) => setExpandedId((prev) => prev === id ? null : id);

  const statusLabel = (kind: StatusKind) => t(`verificationArchive.rtStatus.${kind}`);

  const summaryItems: { labelKey: string; value: number; color: string }[] = [
    { labelKey: 'verificationArchive.rtSummaryTotal', value: summary.total, color: 'bg-gray-50   text-gray-700' },
    { labelKey: 'verificationArchive.rtSummarySupported', value: summary.supported, color: 'bg-green-50 text-green-700' },
    { labelKey: 'verificationArchive.rtSummaryPartial', value: summary.partially_supported, color: 'bg-blue-50   text-blue-700' },
    { labelKey: 'verificationArchive.rtSummaryContradicted', value: summary.contradicted, color: 'bg-red-50    text-red-700' },
    { labelKey: 'verificationArchive.rtSummaryInsufficient', value: summary.insufficient, color: 'bg-yellow-50 text-yellow-700' },
    { labelKey: 'verificationArchive.rtSummaryNoEvidence', value: summary.skipped, color: 'bg-orange-50 text-orange-700' },
    { labelKey: 'verificationArchive.rtSummaryFailed', value: summary.failed, color: 'bg-red-50    text-red-600' },
  ];

  const claimRefByClaimId = React.useMemo(() => {
    const map: Record<string, string | null> = {};
    claims.forEach((c) => { map[c.claim_id] = c.claim_ref ?? null; });
    return map;
  }, [claims]);

  const showExportCheckbox = selectedForExportIds != null && onToggleExportSelection != null;
  const allSelected = showExportCheckbox && results.length > 0 && results.every((r) => selectedForExportIds!.has(r.result_id));
  const someSelected = showExportCheckbox && results.some((r) => selectedForExportIds!.has(r.result_id));

  const toggleAllExport = () => {
    if (!onToggleExportSelection) return;
    results.forEach((r) => onToggleExportSelection(r.result_id));
  };

  return (
    <div className="space-y-4">
      {}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        {summaryItems.map(({ labelKey, value, color }) => (
          <div key={labelKey} className={`rounded-xl p-3 text-center ${color} border border-gray-100`}>
            <div className="text-2xl font-bold">{value}</div>
            <div className="text-xs mt-0.5 font-medium">{t(labelKey)}</div>
          </div>
        ))}
      </div>

      {}
      <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-3 py-3 w-8" />
              {showExportCheckbox && (
                <th className="px-3 py-3 text-left w-10">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = !allSelected && someSelected; }}
                    onChange={toggleAllExport}
                    className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                  />
                </th>
              )}
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-10">{t('verificationArchive.rtColNumber')}</th>
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide min-w-[10rem]">{t('verificationArchive.rtColClaimText')}</th>
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-32">{t('verificationArchive.rtColStatus')}</th>
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide min-w-[8rem]">{t('verificationArchive.rtColReference')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {results.map((r, idx) => {
              const kind = getStatusKind(r);
              return (
              <React.Fragment key={r.result_id}>
                <tr
                  className="cursor-pointer hover:bg-gray-50 transition-colors"
                  onClick={() => toggle(r.result_id)}
                >
                  {}
                  <td className="px-3 py-3 text-gray-400">
                    <svg
                      className={`w-4 h-4 transition-transform ${expandedId === r.result_id ? 'rotate-90' : ''}`}
                      fill="none" stroke="currentColor" viewBox="0 0 24 24"
                      aria-hidden
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </td>

                  {showExportCheckbox && (
                    <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedForExportIds!.has(r.result_id)}
                        onChange={() => onToggleExportSelection!(r.result_id)}
                        className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                      />
                    </td>
                  )}

                  {}
                  <td className="px-3 py-3 text-xs font-medium text-gray-400 tabular-nums">
                    {idx + 1}
                  </td>

                  {}
                  <td className="px-3 py-3 text-gray-800 max-w-sm">
                    <span className="line-clamp-2">{r.claim_text}</span>
                  </td>

                  {}
                  <td className="px-3 py-3">
                    <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${STATUS_KIND_CLASSES[kind]}`}>
                      {statusLabel(kind)}
                    </span>
                  </td>

                  {}
                  <td className="px-3 py-3 text-gray-600 text-xs">
                    {claimRefByClaimId[r.claim_id] ?? '—'}
                  </td>
                </tr>

                {}
                {expandedId === r.result_id && (
                  <tr>
                    <td colSpan={showExportCheckbox ? 7 : 6} className="px-4 py-4 bg-gray-50 border-b border-gray-200">
                      <div className="space-y-4 max-w-4xl">

                        {}
                        {r.run_status === 'failed' && r.error_message && (
                          <div className="rounded-lg bg-red-50 border border-red-200 p-3">
                            <p className="text-xs font-semibold text-red-700 mb-1">{t('verificationArchive.rtError')}</p>
                            <p className="text-xs text-red-600 font-mono">{r.error_message}</p>
                          </div>
                        )}

                        {}
                        {r.explanation && (
                          <div>
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">{t('verificationArchive.rtExplanation')}</p>
                            <p className="text-sm text-gray-700 leading-relaxed">{formatExplanationForDisplay(r.explanation, t('verificationArchive.thresholdRewrite'))}</p>
                          </div>
                        )}

                        {}
                        {r.evidence_snippets.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                              {t('verificationArchive.rtRetrievedEvidence', { n: r.evidence_snippets.length })}
                            </p>
                            <div className="space-y-2">
                              {r.evidence_snippets.map((snip, i) => (
                                <div key={i} className="rounded-lg border border-gray-200 bg-white p-3">
                                  <p className="text-xs text-gray-600 leading-relaxed">{snip}</p>
                                  {r.evidence_sources[i] && (
                                    <p className="mt-1 text-xs text-indigo-600 font-medium">{r.evidence_sources[i]}</p>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {}
                        {r.retrieval_result && r.retrieval_result.retrieved_chunks.length > 0 && (
                          <div className="text-xs">
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                              {t('verificationArchive.rtRawChunks', { n: r.retrieval_result.retrieved_chunks.length })}
                            </p>
                            <div className="space-y-2">
                              {r.retrieval_result.retrieved_chunks.map((chunk, i) => (
                                <div key={i} className="rounded border border-gray-100 bg-white p-2">
                                  <div className="flex justify-between mb-1">
                                    <span className="text-indigo-600">{chunk.source_ref || t('verificationArchive.rtNoSource')}</span>
                                    {chunk.score != null && (
                                      <span className="text-gray-400">{t('verificationArchive.rtScore', { score: chunk.score.toFixed(3) })}</span>
                                    )}
                                  </div>
                                  <p className="text-gray-600 font-mono whitespace-pre-wrap">{chunk.content}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {}
                        {r.prompt_used && (
                          <details className="text-xs border-t border-gray-200 pt-4 mt-2">
                            <summary className="cursor-pointer text-gray-400 hover:text-gray-600 font-medium">
                              {t('verificationArchive.rtPromptsUsed')}
                            </summary>
                            <pre className="mt-2 rounded bg-gray-100 p-3 text-gray-600 overflow-x-auto whitespace-pre-wrap text-xs font-mono">
                              {r.prompt_used}
                            </pre>
                          </details>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
