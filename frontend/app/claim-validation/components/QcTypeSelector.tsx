'use client';

import { useEffect, useState } from 'react';
import { useLanguage } from '@/app/contexts/LanguageContext';
import type { QcType } from '../types';
import { HIDDEN_QC_RULE_LABEL } from '../lib/constants';

interface Props {
  selectedId: string | null;
  onChange: (qcType: QcType) => void;
  disabled?: boolean;
}

export default function QcTypeSelector({ selectedId, onChange, disabled }: Props) {
  const { t } = useLanguage();
  const [qcTypes, setQcTypes]   = useState<QcType[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error,   setError]     = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/claim-validation/qc-types')
      .then((r) => {
        if (!r.ok) throw new Error(`${t('claimValidation.errLoadQcTypes')}: ${r.status}`);
        return r.json() as Promise<{ qcTypes: QcType[] }>;
      })
      .then(({ qcTypes: data }) =>
        setQcTypes(data.filter((qc) => qc.label !== HIDDEN_QC_RULE_LABEL))
      )
      .catch((e: unknown) => setError(e instanceof Error ? e.message : t('claimValidation.errLoadQcTypes')))
      .finally(() => setLoading(false));
  }, [t]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
        </svg>
        {t('claimValidation.loadingQcTypes')}
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>;
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {qcTypes.map((qc) => {
          const active = qc.qc_type_id === selectedId;
          return (
            <button
              key={qc.qc_type_id}
              type="button"
              disabled={disabled}
              onClick={() => onChange(qc)}
              className={`text-left rounded-lg border px-3 py-2 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                active
                  ? 'border-indigo-500 bg-indigo-50 text-indigo-900'
                  : 'border-gray-200 bg-white text-gray-700 hover:border-indigo-300 hover:bg-indigo-50/50'
              } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <div className="font-medium text-sm">{qc.label}</div>
              <div className="text-xs text-gray-500 mt-0.5 line-clamp-2">{qc.description}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
