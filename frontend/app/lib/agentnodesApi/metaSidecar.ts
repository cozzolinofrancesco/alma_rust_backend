import type { drive_v3 } from 'googleapis';
import { findFileIdByName, readJsonFileById, writeJsonNamedFile } from './jsonFile';
import { ensureAfFolder } from './afFolder';

export const META_VERSION = 1 as const;

export type AgentnodesMetaV1 = {
  version: typeof META_VERSION;
  agentId: string;
  updatedAt: string;
  graphPrefs?: Record<string, unknown>;
  runs: Array<{
    id: string;
    agentId: string;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    startedAt: string;
    finishedAt?: string;
    steps?: Record<string, { status: string; output?: string }>;
  }>;
  simulations: Array<{
    id: string;
    agentId: string;
    status: string;
    paused?: boolean;
    createdAt: string;
  }>;
  snapshots: Array<{
    id: string;
    label?: string;
    createdAt: string;
    graph: unknown;
  }>;
  webhooks: Array<{
    id: string;
    url: string;
    events: string[];
    secret?: string;
    createdAt: string;
  }>;
  /** Corpuses linked to this project (project-scoped meta only). Accumulated when a
   *  corpus is attached to any step, or added directly from the corpus manager. */
  corpusLinks?: Array<{
    corpusId: string;
    /** Gemini File Search store path (fileSearchStores/…) — lets collaborators resolve/use the corpus from this shared file alone. */
    storeName?: string;
    displayName: string;
    ownerEmail: string;
    addedBy: string;
    addedAt: string;
  }>;
};

function emptyMeta(agentId: string): AgentnodesMetaV1 {
  const now = new Date().toISOString();
  return {
    version: META_VERSION,
    agentId,
    updatedAt: now,
    runs: [],
    simulations: [],
    snapshots: [],
    webhooks: [],
    corpusLinks: [],
  };
}

export function metaSidecarFileName(agentId: string): string {
  return `${agentId}.agentnodes-meta.json`;
}

export async function readOrCreateMeta(
  drive: drive_v3.Drive,
  projectId: string,
  agentId: string
): Promise<{ meta: AgentnodesMetaV1; fileId: string }> {
  const af = await ensureAfFolder(drive, projectId);
  const name = metaSidecarFileName(agentId);
  const fileId = await findFileIdByName(drive, af, name);
  if (fileId) {
    const parsed = await readJsonFileById<AgentnodesMetaV1>(drive, fileId);
    if (parsed && parsed.version === META_VERSION && parsed.agentId === agentId) {
      return { meta: parsed, fileId };
    }
  }
  const meta = emptyMeta(agentId);
  const { fileId: fid } = await writeJsonNamedFile(drive, af, name, meta);
  return { meta, fileId: fid };
}

export async function writeMeta(
  drive: drive_v3.Drive,
  projectId: string,
  meta: AgentnodesMetaV1
): Promise<{ fileId: string }> {
  const af = await ensureAfFolder(drive, projectId);
  const name = metaSidecarFileName(meta.agentId);
  meta.updatedAt = new Date().toISOString();
  const { fileId } = await writeJsonNamedFile(drive, af, name, meta);
  return { fileId };
}
