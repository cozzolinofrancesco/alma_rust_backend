import { google } from 'googleapis';
import type { OAuth2Client } from 'googleapis-common';
import { getCorpusById } from './registry';
import { listAllFileSearchStores } from './fileSearchStore';
import { findFileIdByName, readJsonFileById } from '../agentnodesApi/jsonFile';
import { metaSidecarFileName, type AgentnodesMetaV1 } from '../agentnodesApi/metaSidecar';

export class CorpusAccessError extends Error {
  readonly status = 403;
  readonly code = 'SOURCE_ACCESS_DENIED';
  constructor() { super('A selected corpus is not available to this caller or linked to this project.'); }
}

export async function resolveCallerCorpora(ids: string[], auth: OAuth2Client, projectId?: string, signal?: AbortSignal): Promise<string[]> {
  if (!ids.length || ids.some(id => typeof id !== 'string' || !id.trim())) throw new CorpusAccessError();
  try {
    signal?.throwIfAborted();
    const selected = [...new Set(ids)];
    const registryEntries = await Promise.all(selected.map(id => getCorpusById(id, auth)));
    let links: AgentnodesMetaV1['corpusLinks'] = [];
    if (registryEntries.some(entry => !entry?.corpusId)) {
      if (!projectId || !/^[a-zA-Z0-9_-]{1,256}$/.test(projectId)) throw new CorpusAccessError();
      const drive = google.drive({ version: 'v3', auth });
      await drive.files.get({ fileId: projectId, fields: 'id', supportsAllDrives: true }, { signal });
      const folder = await findFileIdByName(drive, projectId, 'AF');
      const sidecar = folder ? await findFileIdByName(drive, folder, metaSidecarFileName('_project')) : null;
      links = sidecar ? (await readJsonFileById<AgentnodesMetaV1>(drive, sidecar))?.corpusLinks ?? [] : [];
    }
    const stores: string[] = [];
    for (const [index, id] of selected.entries()) {
      signal?.throwIfAborted();
      let name = registryEntries[index]?.corpusId;
      if (!name) {
        const link = links.find(entry => entry.corpusId === id || entry.storeName === id);
        if (!link) throw new CorpusAccessError();
        name = link.storeName || (link.corpusId.startsWith('fileSearchStores/') ? link.corpusId : undefined);
        if (!name) {
          const matches = (await listAllFileSearchStores()).filter(store => store.displayName === link.displayName);
          if (matches.length === 1) name = matches[0].name;
        }
      }
      if (!name || !/^fileSearchStores\/[a-zA-Z0-9_-]+$/.test(name)) throw new CorpusAccessError();
      stores.push(name);
    }
    return [...new Set(stores)];
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof CorpusAccessError) throw error;
    throw new CorpusAccessError();
  }
}