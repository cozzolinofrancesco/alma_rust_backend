import { agentnodesV1BasePath } from './agentnodesApi/agentnodesV1Flags';

// Persist an agent's attached skill ids onto its top-level metadata. Uses the
// agentnodes PATCH route (handlePatchAgent merges metadata into the top-level
// VersionedAgentData), so the value survives subsequent layer/version saves
// which spread the existing top-level metadata. The PATCH route exists
// independently of the v1 client feature flag, so this works in both modes.
export async function persistAgentSkillIds(
  projectId: string,
  agentId: string,
  skillIds: string[],
): Promise<void> {
  const res = await fetch(
    `${agentnodesV1BasePath(projectId)}/agents/${encodeURIComponent(agentId)}`,
    {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: { skillIds } }),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Failed to save skills (HTTP ${res.status})`);
  }
}
