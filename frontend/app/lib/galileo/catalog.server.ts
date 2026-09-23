import { readFile, stat } from 'node:fs/promises';
import { GALILEO_CATALOG_FRESH_MS, GALILEO_CATALOG_MAX_AGE_MS, parseGalileoCatalog, type GalileoCatalog } from '../stepModels';

export const GALILEO_CATALOG_URL = 'https://galileo-genai.pages.roche.com/galileo-models-list/api.json';
export const CATALOG_FRESH_MS = GALILEO_CATALOG_FRESH_MS;
export const CATALOG_MAX_AGE_MS = GALILEO_CATALOG_MAX_AGE_MS;
const REFRESH_INTERVAL_MS = 10_000;

export function createGalileoCatalogLoader(
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  now: () => number = Date.now,
  catalogFile = process.env.GALILEO_CATALOG_FILE,
) {
  let lastGood: GalileoCatalog | null = null;
  let lastResult: GalileoCatalog | null = null;
  let lastAttemptAt = -Infinity;
  let pending: Promise<GalileoCatalog> | null = null;

  function unavailable(): GalileoCatalog {
    const age = lastGood?.fetchedAt ? now() - Date.parse(lastGood.fetchedAt) : Infinity;
    if (lastGood && age < CATALOG_MAX_AGE_MS) {
      return { ...lastGood, state: 'stale', error: 'Galileo catalog refresh failed.' };
    }
    return {
      models: [], state: 'unavailable', fetchedAt: lastGood?.fetchedAt ?? null,
      rejectedRows: 0, duplicateRows: 0, error: 'Galileo catalog is unavailable.',
    };
  }

  return function loadCatalog(refresh = false): Promise<GalileoCatalog> {
    if (pending) return pending;
    if (lastResult && now() - lastAttemptAt < REFRESH_INTERVAL_MS) {
      return Promise.resolve(lastResult.state === 'fresh' ? lastResult : unavailable());
    }
    if (!refresh && lastGood?.fetchedAt && lastResult?.state === 'fresh' &&
        now() - Date.parse(lastGood.fetchedAt) < CATALOG_FRESH_MS) {
      return Promise.resolve(lastGood);
    }

    lastAttemptAt = now();
    pending = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        let raw: unknown;
        if (catalogFile) {
          const metadata = await stat(catalogFile);
          if (!metadata.isFile() || metadata.size > 10 * 1024 * 1024) throw new Error('Invalid configured catalog');
          raw = JSON.parse(await readFile(catalogFile, { encoding: 'utf8', signal: controller.signal }));
        } else {
          const response = await fetcher(GALILEO_CATALOG_URL, {
            headers: { Accept: 'application/json' },
            cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
          });
          if (!response.ok) throw new Error('Catalog request failed');
          raw = await response.json();
        }
        const parsed = parseGalileoCatalog(raw);
        if (parsed.models.length === 0 && (parsed.rejectedRows > 0 || parsed.duplicateRows > 0)) {
          throw new Error('Catalog validation failed');
        }
        lastGood = { ...parsed, state: 'fresh', source: catalogFile ? 'configured-file' : 'remote', fetchedAt: new Date(now()).toISOString() };
        lastResult = lastGood;
      } catch {
        lastResult = unavailable();
      } finally {
        clearTimeout(timer);
      }
      return lastResult;
    })().finally(() => { pending = null; });
    return pending;
  };
}

export const getGalileoCatalog = createGalileoCatalogLoader();