import type { Skill, SkillCreateInput, SkillUpdateInput } from './agentSkills';

// Client-side wrappers over the global skills library API. All calls send the
// auth cookie via credentials:'include' (mirrors the prompts/docs clients).

const jsonError = async (response: Response, fallback: string): Promise<never> => {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error || `${fallback} (HTTP ${response.status})`);
};

export async function fetchSkills(signal?: AbortSignal): Promise<Skill[]> {
  const response = await fetch('/api/skills', { credentials: 'include', cache: 'no-store', signal });
  if (!response.ok) return jsonError(response, 'Failed to load skills');
  const data = (await response.json()) as { skills: Skill[] };
  return data.skills ?? [];
}

export async function createSkillApi(input: SkillCreateInput): Promise<Skill> {
  const response = await fetch('/api/skills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  if (!response.ok) return jsonError(response, 'Failed to create skill');
  const data = (await response.json()) as { skill: Skill };
  return data.skill;
}

export async function updateSkillApi(skillId: string, patch: SkillUpdateInput): Promise<Skill> {
  const response = await fetch(`/api/skills/${encodeURIComponent(skillId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(patch),
  });
  if (!response.ok) return jsonError(response, 'Failed to update skill');
  const data = (await response.json()) as { skill: Skill };
  return data.skill;
}

export async function deleteSkillApi(skillId: string): Promise<void> {
  const response = await fetch(`/api/skills/${encodeURIComponent(skillId)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!response.ok && response.status !== 204) {
    return jsonError(response, 'Failed to delete skill');
  }
}
