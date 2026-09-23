'use client';

import { useMemo } from 'react';
import { useLanguage } from '@/app/contexts/LanguageContext';
import type { Claim } from '../types';

interface Props {
  claims: Claim[];
  onChange: (claims: Claim[]) => void;
  onRunValidation: (selected: Claim[]) => void;
  running?: boolean;
  disabled?: boolean;
  cachedClaimIds?: Set<string>;
}

export default function ClaimsReviewTable({ claims, onChange, onRunValidation, running, disabled, cachedClaimIds }: Props) {
  const { t } = useLanguage();
  const selected     = useMemo(() => claims.filter((c) => c.review_status !== 'deleted' && c.selected), [claims]);
  const visible      = useMemo(() => claims.filter((c) => c.review_status !== 'deleted'), [claims]);
  const allSelected  = visible.length > 0 && visible.every((c) => c.selected);
  const someSelected = visible.some((c) => c.selected);

  const toggleAll = () => {
    const next = !allSelected;
    onChange(claims.map((c) => c.review_status === 'deleted' ? c : { ...c, selected: next }));
  };

  const toggleOne = (id: string) => {
    onChange(claims.map((c) => c.claim_id === id ? { ...c, selected: !c.selected } : c));
  };

  if (claims.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-gray-400">
        {t('claimValidation.claimsNoExtracted')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm text-gray-600">
          {t('claimValidation.selectedOfClaims', { selected: selected.length, visible: visible.length })}
          {claims.length !== visible.length && (
            <span className="ml-2 text-gray-400">{t('claimValidation.deletedCount', { n: claims.length - visible.length })}</span>
          )}
        </div>

        {(() => {
          const cachedCount  = cachedClaimIds
            ? selected.filter((c) => c.review_status !== 'edited' && cachedClaimIds.has(c.claim_id)).length
            : 0;
          const newCount     = selected.length - cachedCount;
          const allCached    = selected.length > 0 && newCount === 0;
          const buttonLabel  = running
            ? t('claimValidation.runningShort')
            : allCached
              ? t('claimValidation.showCachedResults', { n: cachedCount })
              : cachedCount > 0
                ? t('claimValidation.runValidationMixed', { newCount, cachedCount })
                : t('claimValidation.runValidationSelected', { n: selected.length });

          return (
            <button
              onClick={() => onRunValidation(selected)}
              disabled={selected.length === 0 || running || disabled}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {running && (
                <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
              )}
              {buttonLabel}
            </button>
          );
        })()}
      </div>

      {}
      <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
        <table className="w-full text-sm min-w-[32rem]">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-3 py-3 text-left w-10 align-middle">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = !allSelected && someSelected; }}
                  onChange={toggleAll}
                  className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                />
              </th>
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-12 whitespace-nowrap align-middle">{t('claimValidation.colNumber')}</th>
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide align-middle">{t('claimValidation.colClaimText')}</th>
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-28 whitespace-nowrap align-middle">{t('claimValidation.colReference')}</th>
              <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-20 whitespace-nowrap align-middle">{t('claimValidation.colPage')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {visible.map((c, idx) => (
              <tr key={c.claim_id} className={`transition-colors ${c.selected ? 'bg-indigo-50/40' : 'bg-white hover:bg-gray-50'}`}>

                {}
                <td className="px-3 py-3">
                  <input
                    type="checkbox"
                    checked={c.selected}
                    onChange={() => toggleOne(c.claim_id)}
                    className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                  />
                </td>

                {}
                <td className="px-3 py-3 text-xs font-medium text-gray-400 tabular-nums">
                  {idx + 1}
                  {c.review_status === 'edited' && (
                    <span className="block text-indigo-400 text-[10px] leading-none mt-0.5">{t('claimValidation.edited')}</span>
                  )}
                  {cachedClaimIds && c.review_status !== 'edited' && cachedClaimIds.has(c.claim_id) && (
                    <span
                      className="block text-emerald-600 text-[10px] leading-none mt-0.5"
                      title={t('claimValidation.cachedTitle')}
                    >
                      {t('claimValidation.cachedLabel')}
                    </span>
                  )}
                </td>

                {}
                <td className="px-3 py-3 text-gray-800 leading-relaxed min-w-0 overflow-hidden">
                  {c.claim_text}
                </td>

                {}
                <td className="px-3 py-3 text-xs text-gray-600 font-mono">
                  {c.claim_ref ?? '—'}
                </td>

                {}
                <td className="px-3 py-3 text-xs text-gray-600 tabular-nums">
                  {c.source_page !== null ? t('claimValidation.pageAbbrev', { n: c.source_page }) : '—'}
                </td>

              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
