// Client helpers for the per-agent activity log sidecar
// (see app/api/ai-agents/activity/[agentId]/route.ts). The log lives in its own
// Drive file, so reads/writes are independent of the agent document.

export interface ActivityEntry {
  username: string;
  action: 'add_step' | 'remove_step' | 'edit_step' | 'link_corpus' | 'unlink_corpus';
  target: string;
  targetId?: string;
  detail?: string;
  timestamp: string;
}

function endpoint(projectId: string, agentId: string): string {
  return `/api/ai-agents/activity/${encodeURIComponent(agentId)}?projectId=${encodeURIComponent(projectId)}`;
}

export async function fetchAgentActivity(
  projectId: string,
  agentId: string,
): Promise<ActivityEntry[]> {
  const res = await fetch(endpoint(projectId, agentId), { credentials: 'include' });
  // The route returns 200 with an empty list when no log file exists yet, so a
  // non-ok response is a real error (auth, missing route, Drive failure) — throw
  // so the caller can surface it instead of silently showing "no activity".
  if (!res.ok) {
    throw new Error(`Activity log GET failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { entries?: ActivityEntry[] };
  return Array.isArray(data.entries) ? data.entries : [];
}

export async function appendAgentActivity(
  projectId: string,
  agentId: string,
  entries: ActivityEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  // keepalive lets the POST complete even if the page is unloading/reloading.
  const res = await fetch(endpoint(projectId, agentId), {
    method: 'POST',
    credentials: 'include',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries }),
  });
  if (!res.ok) {
    throw new Error(`Activity log POST failed: ${res.status} ${res.statusText}`);
  }
}
