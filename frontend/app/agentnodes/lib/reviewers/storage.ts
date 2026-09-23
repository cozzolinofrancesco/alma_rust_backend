
import type { ReviewRun } from './types';

export function reviewStorageKey(projectId: string, agentId: string): string {
  return `canvas272-reviews:${projectId}:${agentId}`;
}

export function readLocalReviewRun(
  projectId: string,
  agentId: string,
): ReviewRun | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(reviewStorageKey(projectId, agentId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ReviewRun;
    if (!parsed?.runId || !parsed?.docHash || !Array.isArray(parsed?.reports)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeLocalReviewRun(
  projectId: string,
  agentId: string,
  run: ReviewRun,
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(reviewStorageKey(projectId, agentId), JSON.stringify(run));
  } catch {
  }
}

export async function fetchDriveReviewRun(
  agentId: string,
): Promise<ReviewRun | null> {
  try {
    const res = await fetch(
      `/api/agentnodes/reviews-sidecar/${encodeURIComponent(agentId)}`,
      { credentials: 'include' },
    );
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const data = (await res.json()) as { reviewRun?: ReviewRun };
    return data.reviewRun ?? null;
  } catch {
    return null;
  }
}

export async function saveDriveReviewRun(
  agentId: string,
  run: ReviewRun,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(
      `/api/agentnodes/reviews-sidecar/${encodeURIComponent(agentId)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ reviewRun: run }),
      },
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
