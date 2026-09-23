'use client';

import { RefreshCw } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';
import type { GalileoCatalog } from '../lib/stepModels';

export default function GalileoCatalogStatus({ catalog, refreshing, onRefresh }: {
  catalog: GalileoCatalog | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { t, locale } = useLanguage();
  const state = catalog?.state ?? 'loading';
  const skipped = (catalog?.rejectedRows ?? 0) + (catalog?.duplicateRows ?? 0);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-600" data-catalog-state={state}>
      {catalog?.fetchedAt ? <time dateTime={catalog.fetchedAt}>{new Date(catalog.fetchedAt).toLocaleString(locale)}</time> : null}
      <button type="button" onClick={onRefresh} disabled={refreshing}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-gray-300 hover:bg-gray-100 disabled:opacity-50"
        title={t('galileoModels.refresh')} aria-label={t('galileoModels.refresh')}>
        <RefreshCw size={14} className={refreshing ? 'animate-spin' : undefined} />
      </button>
      {skipped > 0 ? <span>{t('galileoModels.discarded', { count: skipped })}</span> : null}
      {catalog?.source === 'configured-file' ? <span>{t('galileoModels.configuredSnapshot')}</span> : null}
    </div>
  );
}