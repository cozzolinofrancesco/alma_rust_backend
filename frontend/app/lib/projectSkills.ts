import { z } from 'zod';
import { SKILL_SOURCES } from './agentSkills';
import { SkillAppearanceSchema } from './skillAppearance';

const identifier = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const timestamp = z.string().datetime({ offset: true });
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export class ProjectSkillsError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = 'ProjectSkillsError';
  }
}

export const SkillActorSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
}).strict();
export type SkillActor = z.infer<typeof SkillActorSchema>;

export const SkillSourceFileSchema = z.object({
  fileId: identifier,
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: digest,
  uploadedBy: SkillActorSchema,
  uploadedAt: timestamp,
}).strict();
export type SkillSourceFile = z.infer<typeof SkillSourceFileSchema>;

const contentFields = {
  label: z.string().trim().min(1).max(120),
  text: z.string().trim().min(1),
  appearance: SkillAppearanceSchema,
  source: z.enum(SKILL_SOURCES),
};

export const ProjectSkillCreateSchema = z.object(contentFields).strict();
export const ProjectSkillPatchSchema = z.object(contentFields).partial().strict().refine(
  (value) => Object.values(value).some((field) => field !== undefined),
  'At least one editable field is required',
);
export type ProjectSkillCreate = z.infer<typeof ProjectSkillCreateSchema>;
export type ProjectSkillPatch = z.infer<typeof ProjectSkillPatchSchema>;

export const SkillRefSchema = z.object({
  projectId: identifier,
  skillId: identifier,
  version: z.number().int().positive(),
}).strict();
export type SkillRef = z.infer<typeof SkillRefSchema>;
export const SkillRefsSchema = z.array(SkillRefSchema).refine(
  (refs) => new Set(refs.map((ref) => `${ref.projectId}:${ref.skillId}`)).size === refs.length,
  'An agent cannot attach the same skill more than once',
);

export const SkillVersionSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: identifier,
  skillId: identifier,
  version: z.number().int().positive(),
  ...contentFields,
  actor: SkillActorSchema,
  timestamp,
  sourceFile: SkillSourceFileSchema.optional(),
  restoredFrom: z.number().int().positive().optional(),
}).strict().refine(
  (value) => value.restoredFrom === undefined || value.restoredFrom < value.version,
  'Restored revision must precede the new revision',
);
export type SkillVersion = z.infer<typeof SkillVersionSchema>;

export const SkillRevisionPointerSchema = z.object({
  version: z.number().int().positive(),
  fileId: identifier,
  sha256: digest,
  timestamp,
  actor: SkillActorSchema,
  operationId: z.string().uuid(),
}).strict();
export type SkillRevisionPointer = z.infer<typeof SkillRevisionPointerSchema>;

export const SkillIndexEntrySchema = z.object({
  skillId: identifier,
  historyFolderId: identifier,
  fileId: identifier,
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1),
  label: contentFields.label,
  appearance: SkillAppearanceSchema,
  source: z.enum(SKILL_SOURCES),
  currentVersion: z.number().int().positive(),
  currentRevisionFileId: identifier,
  revisions: z.array(SkillRevisionPointerSchema).min(1),
  createdBy: SkillActorSchema,
  createdAt: timestamp,
  updatedBy: SkillActorSchema,
  updatedAt: timestamp,
  archivedAt: timestamp.optional(),
  archivedBy: SkillActorSchema.optional(),
  sourceFile: SkillSourceFileSchema.optional(),
  provenance: z.object({
    libraryFileId: identifier,
    legacySkillId: identifier,
    importedBy: SkillActorSchema,
    importedAt: timestamp,
    originalCreatedAt: timestamp.optional(),
    originalCreatedBy: SkillActorSchema.nullable(),
  }).strict().optional(),
}).strict().superRefine((entry, context) => {
  if (entry.revisions.some((revision, index) => revision.version !== index + 1)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Revision sequence is invalid', path: ['revisions'] });
  }
  const current = entry.revisions.at(-1);
  if (current?.version !== entry.currentVersion || current?.fileId !== entry.currentRevisionFileId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Current revision pointer is invalid', path: ['currentVersion'] });
  }
  if (new Set(entry.revisions.map((revision) => revision.fileId)).size !== entry.revisions.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Revision files must be distinct', path: ['revisions'] });
  }
  if (Boolean(entry.archivedAt) !== Boolean(entry.archivedBy)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Archive attribution is incomplete' });
  }
});
export type SkillIndexEntry = z.infer<typeof SkillIndexEntrySchema>;

export const SkillChangeSchema = z.object({
  operationId: z.string().uuid(),
  skillId: identifier,
  version: z.number().int().positive(),
  action: z.enum(['added', 'modified', 'archived', 'restored', 'migrated']),
  actor: SkillActorSchema,
  timestamp,
  requestHash: digest,
}).strict();

export const SkillOperationSchema = z.object({
  operationId: z.string().uuid(),
  requestHash: digest,
  skillId: identifier,
  baseVersion: z.number().int().nonnegative(),
  action: z.enum(['added', 'modified', 'restored', 'migrated']),
  actor: SkillActorSchema,
  timestamp,
  historyFolderId: identifier,
  sourceFileId: identifier,
  revisionFileId: identifier,
}).strict();
export type SkillOperation = z.infer<typeof SkillOperationSchema>;

export const ProjectSkillsIndexSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: identifier,
  indexRevision: z.number().int().nonnegative(),
  skills: z.array(SkillIndexEntrySchema),
  changes: z.array(SkillChangeSchema),
  pendingOperations: z.array(SkillOperationSchema).default([]),
}).strict().superRefine((index, context) => {
  const skillIds = new Set(index.skills.map((skill) => skill.skillId));
  if (skillIds.size !== index.skills.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate skill IDs' });
  }
  if (new Set(index.changes.map((change) => change.operationId)).size !== index.changes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate operation IDs' });
  }
  if (index.indexRevision !== index.changes.length || index.changes.some((change) => !skillIds.has(change.skillId))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid index change log' });
  }
  if (new Set(index.pendingOperations.map((operation) => operation.operationId)).size !== index.pendingOperations.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate pending operations' });
  }
});
export type ProjectSkillsIndex = z.infer<typeof ProjectSkillsIndexSchema>;

export interface SkillRevisionContext {
  actor: SkillActor;
  timestamp: string;
  sourceFile?: SkillSourceFile;
}

export function createSkillVersion(
  projectId: string,
  skillId: string,
  input: ProjectSkillCreate,
  context: SkillRevisionContext,
): SkillVersion {
  return SkillVersionSchema.parse({
    ...ProjectSkillCreateSchema.parse(input),
    schemaVersion: 1,
    projectId,
    skillId,
    version: 1,
    actor: context.actor,
    timestamp: context.timestamp,
    sourceFile: context.sourceFile,
  });
}

export function reviseSkillVersion(
  current: SkillVersion,
  patch: ProjectSkillPatch,
  context: SkillRevisionContext,
): SkillVersion | null {
  const changes = ProjectSkillPatchSchema.parse(patch);
  const content = ProjectSkillCreateSchema.parse({
    label: changes.label ?? current.label,
    text: changes.text ?? current.text,
    appearance: changes.appearance ?? current.appearance,
    source: changes.source ?? current.source,
  });
  const sourceFile = context.sourceFile ?? current.sourceFile;
  if (content.label === current.label && content.text === current.text && content.source === current.source &&
      JSON.stringify(content.appearance) === JSON.stringify(current.appearance) &&
      JSON.stringify(sourceFile) === JSON.stringify(current.sourceFile)) return null;
  return SkillVersionSchema.parse({
    ...content,
    schemaVersion: 1,
    projectId: current.projectId,
    skillId: current.skillId,
    version: current.version + 1,
    actor: context.actor,
    timestamp: context.timestamp,
    sourceFile,
  });
}

export function restoreSkillVersion(
  current: SkillVersion,
  previous: SkillVersion,
  context: Pick<SkillRevisionContext, 'actor' | 'timestamp'>,
): SkillVersion {
  if (current.skillId !== previous.skillId || current.projectId !== previous.projectId || previous.version > current.version) {
    throw new ProjectSkillsError('INVALID_REVISION', 'The selected revision does not belong to this skill');
  }
  return SkillVersionSchema.parse({
    ...previous,
    version: current.version + 1,
    actor: context.actor,
    timestamp: context.timestamp,
    restoredFrom: previous.version,
  });
}

export function resolvePinnedSkillVersions(
  projectId: string,
  refs: readonly SkillRef[],
  revisions: readonly SkillVersion[],
): SkillVersion[] {
  const parsedRefs = SkillRefsSchema.parse(refs);
  return parsedRefs.map((ref) => {
    if (ref.projectId !== projectId) throw new ProjectSkillsError('WRONG_PROJECT', 'A skill belongs to another project', 403);
    const revision = revisions.find((candidate) => candidate.projectId === ref.projectId &&
      candidate.skillId === ref.skillId && candidate.version === ref.version);
    if (!revision) throw new ProjectSkillsError('REVISION_UNAVAILABLE', `Skill revision v${ref.version} is unavailable`, 409);
    return SkillVersionSchema.parse(revision);
  });
}

export function commitSkillRevision(
  current: ProjectSkillsIndex,
  operation: SkillOperation,
  revision: SkillVersion,
  file: { fileId: string; name: string; mimeType: string },
  sha256: string,
  provenance?: SkillIndexEntry['provenance'],
): ProjectSkillsIndex {
  const completed = current.changes.find((change) => change.operationId === operation.operationId);
  if (completed) {
    if (completed.requestHash !== operation.requestHash) throw new ProjectSkillsError('OPERATION_REUSED', 'This save operation has different contents.', 409);
    return current;
  }
  const reservation = current.pendingOperations.find((pending) => pending.operationId === operation.operationId);
  if (!reservation || JSON.stringify(reservation) !== JSON.stringify(operation)) {
    throw new ProjectSkillsError('OPERATION_UNAVAILABLE', 'The save reservation is unavailable.', 409);
  }
  const existing = current.skills.find((skill) => skill.skillId === operation.skillId);
  if ((existing?.currentVersion ?? 0) !== operation.baseVersion ||
      revision.version !== operation.baseVersion + 1 || revision.projectId !== current.projectId || revision.skillId !== operation.skillId) {
    throw new ProjectSkillsError('STALE_REVISION', 'The skill changed. Review the latest version before saving.', 409);
  }
  if (existing?.archivedAt && operation.action !== 'restored') {
    throw new ProjectSkillsError('SKILL_ARCHIVED', 'This skill has been archived.', 409);
  }
  const pointer: SkillRevisionPointer = {
    version: revision.version, fileId: operation.revisionFileId, sha256,
    timestamp: operation.timestamp, actor: operation.actor, operationId: operation.operationId,
  };
  const entry = SkillIndexEntrySchema.parse({
    skillId: operation.skillId,
    historyFolderId: operation.historyFolderId,
    fileId: file.fileId, fileName: file.name, mimeType: file.mimeType,
    label: revision.label, appearance: revision.appearance, source: revision.source,
    currentVersion: revision.version, currentRevisionFileId: pointer.fileId,
    revisions: [...(existing?.revisions ?? []), pointer],
    createdBy: existing?.createdBy ?? operation.actor, createdAt: existing?.createdAt ?? operation.timestamp,
    updatedBy: operation.actor, updatedAt: operation.timestamp,
    sourceFile: revision.sourceFile,
    provenance: existing?.provenance ?? provenance,
  });
  return ProjectSkillsIndexSchema.parse({
    ...current,
    indexRevision: current.indexRevision + 1,
    skills: [...current.skills.filter((skill) => skill.skillId !== entry.skillId), entry],
    changes: [...current.changes, {
      operationId: operation.operationId, skillId: entry.skillId, version: revision.version,
      requestHash: operation.requestHash, action: operation.action, actor: operation.actor, timestamp: operation.timestamp,
    }],
    pendingOperations: current.pendingOperations.filter((pending) => pending.operationId !== operation.operationId),
  });
}

export function archiveIndexedSkill(index: ProjectSkillsIndex, skillId: string, expectedVersion: number, event: {
  operationId: string; requestHash: string; actor: SkillActor; timestamp: string;
}): ProjectSkillsIndex {
  const completed = index.changes.find((change) => change.operationId === event.operationId);
  if (completed) {
    if (completed.requestHash !== event.requestHash) throw new ProjectSkillsError('OPERATION_REUSED', 'This save operation has different contents.', 409);
    return index;
  }
  const skill = index.skills.find((entry) => entry.skillId === skillId);
  if (!skill) throw new ProjectSkillsError('SKILL_UNAVAILABLE', 'The skill is unavailable.', 404);
  if (skill.currentVersion !== expectedVersion) throw new ProjectSkillsError('STALE_REVISION', 'The skill changed before it could be archived.', 409);
  if (skill.archivedAt) return index;
  return ProjectSkillsIndexSchema.parse({
    ...index,
    indexRevision: index.indexRevision + 1,
    skills: index.skills.map((entry) => entry.skillId === skillId ? {
      ...entry, archivedAt: event.timestamp, archivedBy: event.actor, updatedAt: event.timestamp, updatedBy: event.actor,
    } : entry),
    changes: [...index.changes, { ...event, skillId, version: skill.currentVersion, action: 'archived' }],
  });
}