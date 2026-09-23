// Drive-backed read/modify/write helpers for a project's shared corpus link list
// (`corpusLinks` in the `_project` meta sidecar). Kept lean — only depends on metaSidecar —
// so API routes can import it without pulling in the heavy handlers module graph.

import type { drive_v3 } from 'googleapis';
import { readOrCreateMeta, writeMeta } from './metaSidecar';

// Same scope value the webhooks/meta use ('_project'); the per-project sidecar file.
export const PROJECT_META_SCOPE = '_project';

// Idempotent upsert by corpusId; backfills a better displayName and the Gemini storeName.
export async function upsertProjectCorpusLink(
  drive: drive_v3.Drive,
  projectId: string,
  record: { corpusId: string; storeName?: string; displayName?: string; ownerEmail?: string; addedBy: string },
): Promise<void> {
  const corpusId = record.corpusId.trim();
  if (!corpusId) return;
  const { meta } = await readOrCreateMeta(drive, projectId, PROJECT_META_SCOPE);
  const links = meta.corpusLinks ?? [];
  const displayName = (record.displayName || '').trim() || corpusId;
  const ownerEmail = (record.ownerEmail || '').trim() || record.addedBy;
  const storeName = (record.storeName || '').trim();

  const existing = links.find((l) => l.corpusId === corpusId);
  let changed = false;
  if (existing) {
    if (displayName !== corpusId && existing.displayName !== displayName) {
      existing.displayName = displayName;
      changed = true;
    }
    if (storeName && !existing.storeName) {
      existing.storeName = storeName;
      changed = true;
    }
  } else {
    links.push({
      corpusId,
      storeName: storeName || undefined,
      displayName,
      ownerEmail,
      addedBy: record.addedBy,
      addedAt: new Date().toISOString(),
    });
    changed = true;
  }
  if (changed) {
    meta.corpusLinks = links;
    await writeMeta(drive, projectId, meta);
  }
}

// Update the displayName of any link matching one of `matchIds` (by corpusId or storeName).
export async function updateProjectCorpusLinkNameIfPresent(
  drive: drive_v3.Drive,
  projectId: string,
  matchIds: string[],
  displayName: string,
): Promise<boolean> {
  const ids = new Set(matchIds.filter(Boolean));
  if (ids.size === 0 || !displayName) return false;
  const { meta } = await readOrCreateMeta(drive, projectId, PROJECT_META_SCOPE);
  const links = meta.corpusLinks ?? [];
  let changed = false;
  for (const l of links) {
    const matches = ids.has(l.corpusId) || (l.storeName ? ids.has(l.storeName) : false);
    if (matches && l.displayName !== displayName) {
      l.displayName = displayName;
      changed = true;
    }
  }
  if (changed) {
    meta.corpusLinks = links;
    await writeMeta(drive, projectId, meta);
  }
  return changed;
}

// Remove any link matching one of `matchIds` (by corpusId or storeName). Returns true if removed.
export async function removeProjectCorpusLinkIfPresent(
  drive: drive_v3.Drive,
  projectId: string,
  matchIds: string[],
): Promise<boolean> {
  const ids = new Set(matchIds.filter(Boolean));
  if (ids.size === 0) return false;
  const { meta } = await readOrCreateMeta(drive, projectId, PROJECT_META_SCOPE);
  const links = meta.corpusLinks ?? [];
  const next = links.filter((l) => !(ids.has(l.corpusId) || (l.storeName ? ids.has(l.storeName) : false)));
  if (next.length === links.length) return false;
  meta.corpusLinks = next;
  await writeMeta(drive, projectId, meta);
  return true;
}
