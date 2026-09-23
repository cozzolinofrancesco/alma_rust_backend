import type { AgentFile } from '../types';
import type { Canvas272Agent, Canvas272Layer } from '../../canvas-272/lib/types';
import { agentnodesV1BasePath } from './agentnodesV1Flags';
import { mergeSameVersionAgentPayload } from './mergeSameVersionPayload';
import { queueAgentFileSave } from '../agentSaveQueue';

export { agentnodesV1ApiEnabled, agentnodesGraphServerSyncEnabled, agentnodesV1BasePath } from './agentnodesV1Flags';

async function parseJsonOrThrow(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Invalid JSON (HTTP ${res.status})`);
  }
}

function mapDriveRowToAgentFile(f: {
  id?: string | null;
  name?: string | null;
  createdTime?: string | null;
  modifiedTime?: string | null;
}): AgentFile | null {
  if (!f.id || !f.name) return null;
  return {
    id: f.id,
    name: f.name,
    createdAt: f.createdTime ?? '',
    updatedAt: f.modifiedTime ?? '',
  };
}

export async function v1ListAgents(projectId: string): Promise<AgentFile[]> {
  const res = await fetch(`${agentnodesV1BasePath(projectId)}/agents`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Failed to list agents (HTTP ${res.status})`);
  }
  const body = (await parseJsonOrThrow(res)) as { agents?: unknown[] };
  const rows = Array.isArray(body.agents) ? body.agents : [];
  return rows.map((x) => mapDriveRowToAgentFile(x as Record<string, unknown>)).filter(Boolean) as AgentFile[];
}

export async function v1GetAgentRaw(projectId: string, agentId: string): Promise<unknown> {
  const res = await fetch(`${agentnodesV1BasePath(projectId)}/agents/${encodeURIComponent(agentId)}`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Failed to load agent (HTTP ${res.status})`);
  }
  const body = (await parseJsonOrThrow(res)) as { content?: unknown };
  const raw = body.content;
  if (raw == null) throw new Error('Missing agent content');
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

export async function v1CreateBlankAgent(
  projectId: string,
  name: string
): Promise<{ fileId: string }> {
  const res = await fetch(`${agentnodesV1BasePath(projectId)}/agents`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = (await parseJsonOrThrow(res)) as { error?: string };
    throw new Error(typeof err?.error === 'string' ? err.error : `Create failed (HTTP ${res.status})`);
  }
  const body = (await parseJsonOrThrow(res)) as { fileId?: string };
  if (!body.fileId) throw new Error('Create response missing fileId');
  return { fileId: body.fileId };
}

export async function v1RenameAgent(projectId: string, fileId: string, newName: string): Promise<void> {
  const res = await fetch(`${agentnodesV1BasePath(projectId)}/agents/${encodeURIComponent(fileId)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentName: newName, name: newName }),
  });
  if (!res.ok) {
    const err = (await parseJsonOrThrow(res)) as { error?: string };
    throw new Error(typeof err?.error === 'string' ? err.error : `Rename failed (HTTP ${res.status})`);
  }
}

export async function v1PostNewVersion(
  projectId: string,
  agentId: string,
  payload: { name: string; layers: Canvas272Layer[]; metadata?: Canvas272Agent['metadata'] }
): Promise<{ currentVersion?: string }> {
  const payloadJson = JSON.stringify({ name: payload.name, layers: payload.layers, metadata: payload.metadata });
  return queueAgentFileSave(projectId, agentId, async () => {
    const res = await fetch(
      `${agentnodesV1BasePath(projectId)}/agents/${encodeURIComponent(agentId)}/versions`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: payloadJson,
      }
    );
    if (!res.ok) {
      const err = (await parseJsonOrThrow(res)) as { error?: string };
      throw new Error(typeof err?.error === 'string' ? err.error : `Save version failed (HTTP ${res.status})`);
    }
    const body = (await parseJsonOrThrow(res)) as { currentVersion?: string };
    return { currentVersion: body.currentVersion };
  });
}

export async function v1PutAgentDocument(projectId: string, agentId: string, document: unknown): Promise<void> {
  const res = await fetch(`${agentnodesV1BasePath(projectId)}/agents/${encodeURIComponent(agentId)}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(document),
  });
  if (!res.ok) {
    const err = (await parseJsonOrThrow(res)) as { error?: string };
    throw new Error(typeof err?.error === 'string' ? err.error : `PUT agent failed (HTTP ${res.status})`);
  }
}

export async function v1AutoSaveAgent(projectId: string, agent: Canvas272Agent): Promise<void> {
  const snapshot = JSON.parse(JSON.stringify(agent)) as Canvas272Agent;
  await queueAgentFileSave(projectId, snapshot.id, async () => {
    const existing = await v1GetAgentRaw(projectId, snapshot.id);
    const merged = await mergeSameVersionAgentPayload(existing, { name: snapshot.name, layers: snapshot.layers, metadata: snapshot.metadata });
    await v1PutAgentDocument(projectId, snapshot.id, merged);
  });
}

export interface ProjectCorpusLink {
  corpusId: string;
  storeName?: string;
  displayName: string;
  ownerEmail: string;
  addedBy: string;
  addedAt: string;
}

export async function v1AddProjectCorpusLink(
  projectId: string,
  link: { corpusId: string; storeName?: string; displayName?: string; ownerEmail?: string },
): Promise<ProjectCorpusLink[]> {
  const res = await fetch(`${agentnodesV1BasePath(projectId)}/corpus-links`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(link),
  });
  if (!res.ok) throw new Error(`Failed to add project corpus link (HTTP ${res.status})`);
  const data = (await parseJsonOrThrow(res)) as { corpusLinks?: ProjectCorpusLink[] };
  return Array.isArray(data?.corpusLinks) ? data.corpusLinks : [];
}

export async function v1ScanProjectCorpusLinks(projectId: string): Promise<ProjectCorpusLink[]> {
  const res = await fetch(`${agentnodesV1BasePath(projectId)}/corpus-links/scan`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Failed to scan project corpus links (HTTP ${res.status})`);
  const data = (await parseJsonOrThrow(res)) as { corpusLinks?: ProjectCorpusLink[] };
  return Array.isArray(data?.corpusLinks) ? data.corpusLinks : [];
}

export async function v1RemoveProjectCorpusLink(
  projectId: string,
  corpusId: string,
): Promise<ProjectCorpusLink[]> {
  const res = await fetch(
    `${agentnodesV1BasePath(projectId)}/corpus-links/${encodeURIComponent(corpusId)}`,
    { method: 'DELETE', credentials: 'include' },
  );
  if (!res.ok) throw new Error(`Failed to remove project corpus link (HTTP ${res.status})`);
  const data = (await parseJsonOrThrow(res)) as { corpusLinks?: ProjectCorpusLink[] };
  return Array.isArray(data?.corpusLinks) ? data.corpusLinks : [];
}
