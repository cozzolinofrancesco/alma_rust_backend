'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { useModels } from './useModels';
import { GALILEO_CATALOG_FRESH_MS, GALILEO_CATALOG_MAX_AGE_MS, type GalileoCatalog, type StepModelOption } from '../lib/stepModels';
import { GALILEO_REFERENCE_MODELS } from '../lib/galileo/catalogReference';

interface CatalogSnapshot {
  catalog: GalileoCatalog | null;
  refreshing: boolean;
}

const initialSnapshot: CatalogSnapshot = { catalog: null, refreshing: false };
let snapshot = initialSnapshot;
let pending: Promise<void> | null = null;
const subscribers = new Set<() => void>();
const getSnapshot = () => snapshot;
const getServerSnapshot = () => initialSnapshot;
const subscribe = (listener: () => void) => {
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
};

function publish(next: CatalogSnapshot) {
  snapshot = next;
  subscribers.forEach(listener => listener());
}

async function loadCatalog(refresh = false): Promise<void> {
  if (pending) return pending;
  if (!refresh && snapshot.catalog?.state === 'fresh' && snapshot.catalog.fetchedAt &&
      Date.now() - Date.parse(snapshot.catalog.fetchedAt) < GALILEO_CATALOG_FRESH_MS) return;

  publish({ ...snapshot, refreshing: true });
  pending = (async () => {
    try {
      const response = await fetch(`/api/models/galileo${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' });
      const catalog = await response.json() as GalileoCatalog;
      if (!Array.isArray(catalog.models) || !['fresh', 'stale', 'unavailable'].includes(catalog.state) ||
          (!response.ok && catalog.state !== 'unavailable')) throw new Error('Catalog request failed');
      publish({ catalog, refreshing: false });
    } catch {
      const previous = snapshot.catalog;
      const reusable = previous?.fetchedAt && Date.now() - Date.parse(previous.fetchedAt) < GALILEO_CATALOG_MAX_AGE_MS;
      publish({
        refreshing: false,
        catalog: {
          models: reusable ? previous.models : [],
          state: reusable ? 'stale' : 'unavailable',
          fetchedAt: previous?.fetchedAt ?? null,
          rejectedRows: previous?.rejectedRows ?? 0,
          duplicateRows: previous?.duplicateRows ?? 0,
          error: 'Galileo catalog is unavailable.',
        },
      });
    }
  })().finally(() => { pending = null; });
  return pending;
}

export function useStepModels() {
  const geminiModels = useModels();
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => { void loadCatalog(); }, []);
  useEffect(() => {
    const catalog = current.catalog;
    if (!catalog?.fetchedAt || catalog.state === 'unavailable') return;
    const age = Date.now() - Date.parse(catalog.fetchedAt);
    const limit = catalog.state === 'fresh' ? GALILEO_CATALOG_FRESH_MS : GALILEO_CATALOG_MAX_AGE_MS;
    const timer = setTimeout(() => {
      if (snapshot.catalog !== catalog) return;
      const expired = Date.now() - Date.parse(catalog.fetchedAt!) >= GALILEO_CATALOG_MAX_AGE_MS;
      publish({ ...snapshot, catalog: { ...catalog, state: expired ? 'unavailable' : 'stale', models: expired ? [] : catalog.models } });
    }, Math.max(0, limit - age));
    return () => clearTimeout(timer);
  }, [current.catalog]);
  const showingReferenceModels = !current.catalog?.models.length || current.catalog.state === 'unavailable';
  const galileoModels = showingReferenceModels ? GALILEO_REFERENCE_MODELS : current.catalog!.models;
  const models: StepModelOption[] = [
    ...geminiModels,
    ...galileoModels.map(model => ({
      ...model,
      disabled: showingReferenceModels || current.catalog?.gateway?.state !== 'ready' || model.disabled !== false,
    })),
  ];
  return {
    models,
    showingReferenceModels,
    catalog: current.catalog,
    refreshing: current.refreshing,
    refreshCatalog: () => { void loadCatalog(true); },
  };
}