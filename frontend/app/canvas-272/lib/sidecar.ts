
import type { Canvas272SidecarV1 } from './types';

export function sidecarStorageKey(projectId: string, agentId: string): string {
  return `canvas272:${projectId}:${agentId}`;
}

export interface Canvas272DraftSummary {
  agentId: string;
  agentName: string;
  updatedAt: string;
  editedStepCount: number;
}

export function listLocalDraftsForProject(projectId: string): Canvas272DraftSummary[] {
  if (typeof window === 'undefined') return [];
  const prefix = `canvas272:${projectId}:`;
  const out: Canvas272DraftSummary[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      let parsed: Canvas272SidecarV1;
      try {
        parsed = JSON.parse(raw) as Canvas272SidecarV1;
      } catch {
        continue;
      }
      if (parsed?.version !== 1 || typeof parsed.outputs !== 'object') continue;
      const editedStepCount = Object.values(parsed.outputs).filter(
        (v) => typeof v === 'string' && v.trim().length > 0
      ).length;
      if (editedStepCount === 0) continue;
      out.push({
        agentId: parsed.agentId,
        agentName:
          typeof parsed.agentName === 'string' && parsed.agentName.trim().length > 0
            ? parsed.agentName
            : parsed.agentId,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
        editedStepCount,
      });
    }
  } catch {
    return [];
  }
  out.sort((a, b) => {
    const ta = Date.parse(a.updatedAt) || 0;
    const tb = Date.parse(b.updatedAt) || 0;
    return tb - ta;
  });
  return out;
}

export function readLocalSidecar(
  projectId: string,
  agentId: string
): Canvas272SidecarV1 | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(sidecarStorageKey(projectId, agentId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Canvas272SidecarV1;
    if (parsed?.version !== 1 || typeof parsed.outputs !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeLocalSidecar(
  projectId: string,
  sidecar: Canvas272SidecarV1
): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(
    sidecarStorageKey(projectId, sidecar.agentId),
    JSON.stringify(sidecar)
  );
}

export function updateLocalOutput(
  projectId: string,
  agentId: string,
  agentName: string,
  layerId: string,
  value: string
): Canvas272SidecarV1 {
  const existing = readLocalSidecar(projectId, agentId);
  const next: Canvas272SidecarV1 = {
    version: 1,
    agentId,
    agentName,
    updatedAt: new Date().toISOString(),
    outputs: { ...(existing?.outputs ?? {}), [layerId]: value },
  };
  writeLocalSidecar(projectId, next);
  return next;
}

export async function fetchDriveSidecar(
  projectId: string,
  agentId: string
): Promise<Canvas272SidecarV1 | null> {
  try {
    const res = await fetch(
      `/api/rust/canvas-272/sidecar/${encodeURIComponent(agentId)}?projectId=${encodeURIComponent(projectId)}`,
      { credentials: 'include' }
    );
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const data = (await res.json()) as { sidecar?: Canvas272SidecarV1 };
    return data.sidecar ?? null;
  } catch {
    return null;
  }
}

export async function saveDriveSidecar(
  projectId: string,
  sidecar: Canvas272SidecarV1
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(
      `/api/rust/canvas-272/sidecar/${encodeURIComponent(sidecar.agentId)}?projectId=${encodeURIComponent(projectId)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ sidecar }),
      }
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body?.error ?? `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'network error' };
  }
}
