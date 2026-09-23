import type { drive_v3 } from 'googleapis';
import { z } from 'zod';
import { SkillRefsSchema, ProjectSkillsError } from './projectSkills';
import { readConditionalJson, writeConditionalJson } from './gdriveConditionalWrite';

export const AgentDocumentSchema = z.record(z.unknown());

function metadataRefs(document: unknown) {
  if (!document || typeof document !== 'object') return undefined;
  const metadata = (document as { metadata?: { skillRefs?: unknown } }).metadata;
  return metadata?.skillRefs === undefined ? undefined : SkillRefsSchema.parse(metadata.skillRefs);
}

function documentVersions(document: unknown): Array<{ version?: string; metadata?: { skillRefs?: unknown } }> {
  if (!document || typeof document !== 'object') return [];
  const versions = (document as { versions?: unknown }).versions;
  return Array.isArray(versions) ? versions : [];
}

export function hasPinnedSkills(document: unknown): boolean {
  return metadataRefs(document) !== undefined || documentVersions(document).some((version) => metadataRefs(version) !== undefined);
}

export function assertSkillPinsPreserved(previous: unknown, next: unknown) {
  const previousRefs = metadataRefs(previous);
  const nextRefs = metadataRefs(next);
  if (previousRefs !== undefined && nextRefs === undefined) throw new ProjectSkillsError('PINS_REQUIRED', 'This save would remove versioned skill references. Reload the agent.', 409);
  for (const version of documentVersions(previous)) {
    const refs = metadataRefs(version);
    if (refs === undefined) continue;
    const replacement = documentVersions(next).find((entry) => entry.version === version.version);
    if (!replacement || JSON.stringify(metadataRefs(replacement)) !== JSON.stringify(refs)) {
      throw new ProjectSkillsError('PIN_HISTORY_CHANGED', 'This save would change historical skill versions. Reload the agent.', 409);
    }
  }
  if (previousRefs !== undefined && JSON.stringify(previousRefs) !== JSON.stringify(nextRefs) &&
      (previous as { currentVersion?: string }).currentVersion === (next as { currentVersion?: string }).currentVersion) {
    throw new ProjectSkillsError('NEW_PIN_VERSION_REQUIRED', 'Changing pinned skills requires a new agent version.', 409);
  }
}

export async function writeGuardedAgentDocument(
  drive: drive_v3.Drive, fileId: string, next: unknown,
  options: { etag?: string | null; requireClientPrecondition?: boolean } = {},
) {
  const previous = await readConditionalJson(drive, fileId, AgentDocumentSchema);
  if (options.requireClientPrecondition && hasPinnedSkills(previous.data) && !options.etag) {
    throw new ProjectSkillsError('AGENT_PRECONDITION_REQUIRED', 'Reload the agent before saving its pinned skills.', 428);
  }
  if (options.etag && options.etag !== previous.etag) throw new ProjectSkillsError('STALE_AGENT', 'Another person saved this agent. Reload before saving.', 409);
  assertSkillPinsPreserved(previous.data, next);
  await writeConditionalJson(drive, fileId, next, options.etag ?? previous.etag);
}