// Pure helpers for the project ↔ corpus link list. Free of `next/server` and Drive
// I/O so they can be unit-tested; the handlers do the reads/writes around them.

import type { Canvas272Layer } from '../../canvas-272/lib/types';
import { resolveLayerCorpusId, collectCorpusIdCandidatesFromLayer } from '../../agentnodes/lib/corpus';

export interface ProjectCorpusLinkRecord {
  corpusId: string;
  storeName?: string;
  displayName: string;
  ownerEmail: string;
  addedBy: string;
  addedAt: string;
}

export interface DiscoveredCorpus {
  corpusId: string;
  storeName?: string;
  displayName?: string;
  ownerEmail?: string;
}

function readStr(layer: Canvas272Layer, key: string): string {
  const v = (layer as unknown as Record<string, unknown>)[key];
  return typeof v === 'string' ? v.trim() : '';
}

// Collect the canonical corpus (plus any name/owner captured on the layer) for each
// step. Synthesis/report layers resolve to '' and are skipped.
export function discoverCorpusesFromLayers(layers: Canvas272Layer[]): DiscoveredCorpus[] {
  const byId = new Map<string, DiscoveredCorpus>();
  for (const layer of layers) {
    const corpusId = resolveLayerCorpusId(layer);
    if (!corpusId) continue;
    const displayName = readStr(layer, 'corpusDisplayName');
    const ownerEmail = readStr(layer, 'corpusOwnerEmail');
    const existing = byId.get(corpusId);
    if (!existing) {
      byId.set(corpusId, {
        corpusId,
        displayName: displayName || undefined,
        ownerEmail: ownerEmail || undefined,
      });
    } else {
      if (!existing.displayName && displayName) existing.displayName = displayName;
      if (!existing.ownerEmail && ownerEmail) existing.ownerEmail = ownerEmail;
    }
  }
  return Array.from(byId.values());
}

// Merge freshly-discovered corpuses into the stored link list. Idempotent by corpusId;
// backfills a better displayName/ownerEmail when the stored one is missing or equals the id.
export function mergeDiscoveredCorpusLinks(
  existing: ProjectCorpusLinkRecord[],
  discovered: DiscoveredCorpus[],
  addedBy: string,
  now: string,
): { links: ProjectCorpusLinkRecord[]; changed: boolean } {
  const links = existing.map((l) => ({ ...l }));
  const byId = new Map(links.map((l) => [l.corpusId, l]));
  let changed = false;
  for (const d of discovered) {
    const cur = byId.get(d.corpusId);
    if (!cur) {
      const rec: ProjectCorpusLinkRecord = {
        corpusId: d.corpusId,
        storeName: d.storeName,
        displayName: d.displayName || d.corpusId,
        ownerEmail: d.ownerEmail || '',
        addedBy,
        addedAt: now,
      };
      links.push(rec);
      byId.set(d.corpusId, rec);
      changed = true;
      continue;
    }
    if ((!cur.displayName || cur.displayName === cur.corpusId) && d.displayName && d.displayName !== d.corpusId) {
      cur.displayName = d.displayName;
      changed = true;
    }
    if (!cur.ownerEmail && d.ownerEmail) {
      cur.ownerEmail = d.ownerEmail;
      changed = true;
    }
    if (!cur.storeName && d.storeName) {
      cur.storeName = d.storeName;
      changed = true;
    }
  }
  return { links, changed };
}

// The exact Gemini store name for a corpus id, when the project link list knows it and it
// differs from the id itself. A corpus owned by another user isn't in the caller's own
// registry, so the run call must forward this store name for the server to resolve it
// exactly (instead of relying on fuzzy display-name matching).
export function resolveStoreNameFromLinks(
  links: Array<{ corpusId: string; storeName?: string }>,
  corpusId: string,
): string | undefined {
  const id = typeof corpusId === 'string' ? corpusId.trim() : '';
  if (!id) return undefined;
  const link = links.find((l) => l.corpusId === id || l.storeName === id);
  const store = typeof link?.storeName === 'string' ? link.storeName.trim() : '';
  return store && store !== id ? store : undefined;
}

// True when the step references any of the given corpus ids (explicit corpusId, resolved
// id, or a filesearch-prefixed ragKnowledge id). Accepts a single id or a set (a corpus can
// be referenced by its registry id or its Gemini store name).
export function layerReferencesCorpus(layer: Canvas272Layer, corpusId: string | string[]): boolean {
  const ids = (Array.isArray(corpusId) ? corpusId : [corpusId]).filter(Boolean);
  if (ids.length === 0) return false;
  const candidates = collectCorpusIdCandidatesFromLayer(layer);
  return ids.some((id) => candidates.includes(id));
}

// Clear the corpus binding from a layer that references the corpus (used by detach). Also
// strips matching ragKnowledge entries so the corpus can't re-resolve after removal.
export function clearCorpusFromLayer<T extends Canvas272Layer>(layer: T, corpusId: string | string[]): T {
  const ids = new Set((Array.isArray(corpusId) ? corpusId : [corpusId]).filter(Boolean));
  const ragRaw = (layer as unknown as Record<string, unknown>).ragKnowledge;
  const ragKnowledge = Array.isArray(ragRaw)
    ? ragRaw.filter((e) => {
        const id = e && typeof e === 'object' ? (e as { id?: unknown }).id : undefined;
        return !(typeof id === 'string' && ids.has(id));
      })
    : ragRaw;
  return {
    ...layer,
    corpusId: undefined,
    corpusDisplayName: undefined,
    corpusOwnerEmail: undefined,
    documentSelections: [],
    ragKnowledge,
  };
}
