'use client';

import { useState } from 'react';
import type { ValidationResult } from '../types';
import type { IntegrityRecord } from '../../lib/integrity';

interface Props {
  results: ValidationResult[];
  disabled?: boolean;
  extractionPrompt?: string;
  validationPrompt?: string;
  corpusScopeSha?: string | null;
  extractionIntegrityRecord?: IntegrityRecord;
}

export default function ExportButton({ results, disabled, extractionPrompt, validationPrompt, corpusScopeSha, extractionIntegrityRecord }: Props) {
  const [exporting, setExporting] = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  const handleExport = async (format: 'json') => {
    if (!results.length || exporting) return;
    setExporting(true);
    setError(null);

    try {
      const body: Record<string, unknown> = { results, format };
      if (format === 'json') {
        if (extractionPrompt !== undefined) body.extractionPrompt = extractionPrompt;
        if (validationPrompt !== undefined) body.validationPrompt = validationPrompt;
        if (corpusScopeSha !== undefined && corpusScopeSha !== null) body.corpus_scope_sha = corpusScopeSha;
        if (extractionIntegrityRecord !== undefined) body.extraction_integrity_record = extractionIntegrityRecord;
      }
      const res = await fetch('/api/claim-validation/export', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Export failed' })) as { error?: string };
        throw new Error(data.error ?? 'Export failed');
      }

      const blob     = await res.blob();
      const url      = URL.createObjectURL(blob);
      const filename = res.headers.get('content-disposition')?.match(/filename="(.+?)"/)?.[1]
        ?? `claim-validation.${format}`;

      const a  = document.createElement('a');
      a.href   = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <button
          onClick={() => handleExport('json')}
          disabled={disabled || exporting || results.length === 0}
          className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 hover:border-gray-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <svg className="w-4 h-4 text-indigo-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
          Download JSON
        </button>
      </div>
      {exporting && (
        <p className="text-xs text-gray-500 flex items-center gap-1.5">
          <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
          </svg>
          Downloading…
        </p>
      )}
      {error && (
        <p className="text-xs text-red-600 bg-red-50 rounded-lg px-2 py-1.5">{error}</p>
      )}
    </div>
  );
}
