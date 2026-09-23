import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { drive_v3 } from 'googleapis';
import {
  ProjectSkillsError, ProjectSkillsIndexSchema, SkillVersionSchema, SkillActorSchema,
  ProjectSkillCreateSchema, ProjectSkillPatchSchema, SkillOperationSchema,
  createSkillVersion, reviseSkillVersion, restoreSkillVersion, commitSkillRevision, archiveIndexedSkill,
  type SkillIndexEntry, type SkillVersion, type SkillOperation,
  type ProjectSkillCreate, type ProjectSkillPatch, type SkillSourceFile,
} from './projectSkills';
import { driveErrorStatus, readConditionalJson, readDriveFileMetadata, rethrowDriveError, setConditionalProperty, writeConditionalJson } from './gdriveConditionalWrite';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER_PROPERTY = 'almaSkillsFolder';
const INDEX_PROPERTY = 'almaSkillsIndex';
const HISTORY_PROPERTY = 'almaSkillsHistory';

export const skillFileHash = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex');

export interface ProjectSkillsLocation {
  folderId: string;
  indexId: string;
  historyId: string;
}

export interface SkillUpload {
  name: string;
  mimeType: string;
  content: Buffer;
}

export interface SaveProjectSkill {
  operationId: string;
  skillId?: string;
  expectedVersion?: number;
  input?: ProjectSkillCreate | ProjectSkillPatch;
  upload?: SkillUpload;
  restoreVersion?: number;
  provenance?: SkillIndexEntry['provenance'];
}

export class ProjectSkillsStore {
  constructor(readonly drive: drive_v3.Drive, readonly projectId: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new ProjectSkillsError('INVALID_PROJECT', 'Invalid project ID');
  }

  async fileMetadata(fileId: string) {
    try {
      const response = await this.drive.files.get({
        fileId, supportsAllDrives: true,
        fields: 'id,name,mimeType,parents,trashed,appProperties,capabilities(canEdit,canAddChildren,canDownload)',
      });
      if (response.data.trashed) throw new ProjectSkillsError('FILE_UNAVAILABLE', 'This project file is in the trash.', 404);
      return response.data;
    } catch (error) { return rethrowDriveError(error); }
  }

  async access() {
    const project = await this.fileMetadata(this.projectId);
    if (project.mimeType !== FOLDER_MIME) throw new ProjectSkillsError('INVALID_PROJECT', 'The project must be a Drive folder', 400);
    return { canRead: true as const, canWrite: Boolean(project.capabilities?.canEdit && project.capabilities?.canAddChildren) };
  }

  async actor() {
    const response = await this.drive.about.get({ fields: 'user(emailAddress,displayName,permissionId)' });
    const user = response.data.user;
    const actor = SkillActorSchema.safeParse({ email: user?.emailAddress, name: user?.displayName || undefined, accountId: user?.permissionId || undefined });
    if (!actor.success) throw new ProjectSkillsError('IDENTITY_REQUIRED', 'Your signed-in identity could not be verified.', 401);
    return actor.data;
  }

  async child(fileId: string, parentId: string, mimeType?: string) {
    const file = await this.fileMetadata(fileId);
    if (!file.parents?.includes(parentId) || (mimeType && file.mimeType !== mimeType)) {
      throw new ProjectSkillsError('WRONG_PROJECT_FILE', 'This file is not in the expected project folder.', 403);
    }
    return file;
  }

  async generatedIds(count: number): Promise<string[]> {
    const response = await this.drive.files.generateIds({ count, space: 'drive' });
    const ids = response.data.ids;
    if (!ids || ids.length !== count) throw new ProjectSkillsError('ID_ALLOCATION_FAILED', 'Could not allocate skill file IDs.', 503);
    return ids;
  }

  async createFile(fileId: string, name: string, parentId: string, mimeType: string, content?: string | Buffer, properties?: Record<string, string>): Promise<void> {
    try {
      await this.drive.files.create({
        requestBody: { id: fileId, name, parents: [parentId], mimeType, appProperties: properties },
        ...(content === undefined ? {} : { media: { mimeType, body: typeof content === 'string' ? content : Readable.from(content) } }),
        supportsAllDrives: true, fields: 'id',
      });
    } catch (error) {
      if (driveErrorStatus(error) !== 409) return rethrowDriveError(error);
      const existing = await this.child(fileId, parentId, mimeType);
      if (existing.appProperties?.almaOperation !== properties?.almaOperation || existing.appProperties?.almaHash !== properties?.almaHash) {
        throw new ProjectSkillsError('FILE_ID_CONFLICT', 'A reserved file contains different data.', 409);
      }
      if (content !== undefined) {
        const stored = await this.drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
        if (skillFileHash(Buffer.from(stored.data as unknown as ArrayBuffer)) !== skillFileHash(content)) {
          throw new ProjectSkillsError('FILE_CONTENT_CONFLICT', 'The saved source differs from this upload.', 409);
        }
      }
    }
  }

  async location(create = false, attempt = 0): Promise<ProjectSkillsLocation | null> {
    const access = await this.access();
    if (create && !access.canWrite) throw new ProjectSkillsError('READ_ONLY_PROJECT', 'You can view skills but cannot change this project.', 403);
    const metadata = await readDriveFileMetadata(this.drive, this.projectId);
    const folderId = metadata.properties.find((property) => property.key === FOLDER_PROPERTY && property.visibility === 'PRIVATE')?.value;
    if (folderId) {
      const folder = await this.child(folderId, this.projectId, FOLDER_MIME);
      const indexId = folder.appProperties?.[INDEX_PROPERTY];
      const historyId = folder.appProperties?.[HISTORY_PROPERTY];
      if (!indexId || !historyId) throw new ProjectSkillsError('INVALID_SKILLS_FOLDER', 'The skills folder is missing its index or history reference.', 422);
      await this.child(indexId, folderId, 'application/json');
      await this.child(historyId, folderId, FOLDER_MIME);
      return { folderId, indexId, historyId };
    }
    if (!create) return null;
    if (attempt >= 3) throw new ProjectSkillsError('SETUP_CONFLICT', 'The project changed during skills setup. Please retry.', 409);
    const [candidateFolder, indexId, historyId] = await this.generatedIds(3);
    const created: string[] = [];
    try {
      await this.createFile(candidateFolder, 'Skills', this.projectId, FOLDER_MIME, undefined, { [INDEX_PROPERTY]: indexId, [HISTORY_PROPERTY]: historyId });
      created.push(candidateFolder);
      const initial = ProjectSkillsIndexSchema.parse({ schemaVersion: 1, projectId: this.projectId, indexRevision: 0, skills: [], changes: [] });
      await this.createFile(indexId, 'skills-index.json', candidateFolder, 'application/json', JSON.stringify(initial, null, 2));
      created.push(indexId);
      await this.createFile(historyId, '.history', candidateFolder, FOLDER_MIME);
      created.push(historyId);
      await setConditionalProperty(this.drive, this.projectId, FOLDER_PROPERTY, candidateFolder, metadata);
      return { folderId: candidateFolder, indexId, historyId };
    } catch (error) {
      const latest = await readDriveFileMetadata(this.drive, this.projectId);
      const published = latest.properties.find((property) => property.key === FOLDER_PROPERTY && property.visibility === 'PRIVATE')?.value;
      if (published === candidateFolder) return { folderId: candidateFolder, indexId, historyId };
      for (const fileId of created.reverse()) {
        await this.drive.files.delete({ fileId, supportsAllDrives: true });
      }
      if (error instanceof ProjectSkillsError && error.status === 409) return this.location(true, attempt + 1);
      throw error;
    }
  }

  async readIndex(location: ProjectSkillsLocation) {
    await this.child(location.indexId, location.folderId, 'application/json');
    const result = await readConditionalJson(this.drive, location.indexId, ProjectSkillsIndexSchema);
    if (result.data.projectId !== this.projectId) throw new ProjectSkillsError('WRONG_PROJECT_INDEX', 'The skills index belongs to another project.', 403);
    return result;
  }

  async list() {
    const access = await this.access();
    const location = await this.location();
    const index = location ? (await this.readIndex(location)).data : null;
    return { ...access, folderId: location?.folderId ?? null, skills: index?.skills ?? [] };
  }

  async readRevision(location: ProjectSkillsLocation, entry: SkillIndexEntry, version: number): Promise<SkillVersion> {
    const pointer = entry.revisions.find((revision) => revision.version === version);
    if (!pointer) throw new ProjectSkillsError('REVISION_UNAVAILABLE', 'The selected skill revision is unavailable.', 404);
    await this.child(entry.historyFolderId, location.historyId, FOLDER_MIME);
    await this.child(pointer.fileId, entry.historyFolderId, 'application/json');
    const response = await this.drive.files.get({ fileId: pointer.fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'text' });
    const raw = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    if (skillFileHash(raw) !== pointer.sha256) throw new ProjectSkillsError('REVISION_CHANGED', 'The stored skill revision was changed outside the app.', 409);
    let revision: SkillVersion;
    try { revision = SkillVersionSchema.parse(JSON.parse(raw)); }
    catch { throw new ProjectSkillsError('INVALID_REVISION', 'The stored skill revision is invalid.', 422); }
    if (revision.projectId !== this.projectId || revision.skillId !== entry.skillId || revision.version !== version) {
      throw new ProjectSkillsError('WRONG_REVISION', 'The skill revision does not match its index entry.', 409);
    }
    return revision;
  }

  async detail(skillId: string, version?: number) {
    const location = await this.location();
    if (!location) throw new ProjectSkillsError('SKILL_UNAVAILABLE', 'No project skills have been saved.', 404);
    const { data } = await this.readIndex(location);
    const entry = data.skills.find((skill) => skill.skillId === skillId);
    if (!entry) throw new ProjectSkillsError('SKILL_UNAVAILABLE', 'The skill is unavailable.', 404);
    return { entry, revision: await this.readRevision(location, entry, version ?? entry.currentVersion) };
  }

  async save(request: SaveProjectSkill): Promise<{ entry: SkillIndexEntry; revision: SkillVersion }> {
    z.string().uuid().parse(request.operationId);
    const actor = await this.actor();
    const access = await this.access();
    if (!access.canWrite) throw new ProjectSkillsError('READ_ONLY_PROJECT', 'You cannot change this project.', 403);
    const location = await this.location(!request.skillId);
    if (!location) throw new ProjectSkillsError('SKILL_UNAVAILABLE', 'The project has no skills library.', 404);
    const input = request.restoreVersion ? undefined : request.skillId
      ? ProjectSkillPatchSchema.parse(request.input) : ProjectSkillCreateSchema.parse(request.input);
    if (request.skillId) z.number().int().positive().parse(request.expectedVersion);
    if (request.upload && (request.upload.content.byteLength > 20 * 1024 * 1024 || !/\.(txt|md|markdown|csv|json|html?|xml|rtf|pdf|docx?)$/i.test(request.upload.name))) {
      throw new ProjectSkillsError('INVALID_UPLOAD', 'Choose a supported document up to 20 MB.', 400);
    }
    const requestHash = skillFileHash(JSON.stringify({
      skillId: request.skillId ?? null, expectedVersion: request.expectedVersion ?? 0,
      restoreVersion: request.restoreVersion ?? null, input,
      upload: request.upload ? { name: request.upload.name, mimeType: request.upload.mimeType, sha256: skillFileHash(request.upload.content) } : null,
      provenance: request.provenance ?? null,
    }));
    let operation: SkillOperation | undefined;
    let existing: SkillIndexEntry | undefined;
    let current: SkillVersion | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const loaded = await this.readIndex(location);
      const completed = loaded.data.changes.find((change) => change.operationId === request.operationId);
      if (completed) {
        if (completed.requestHash !== requestHash || completed.actor.email !== actor.email) throw new ProjectSkillsError('OPERATION_REUSED', 'This operation belongs to a different save.', 409);
        const entry = loaded.data.skills.find((skill) => skill.skillId === completed.skillId)!;
        return { entry, revision: await this.readRevision(location, entry, completed.version) };
      }
      existing = request.skillId ? loaded.data.skills.find((entry) => entry.skillId === request.skillId) : undefined;
      if (request.skillId && !existing) throw new ProjectSkillsError('SKILL_UNAVAILABLE', 'The skill is unavailable.', 404);
      if (existing && existing.currentVersion !== request.expectedVersion) throw new ProjectSkillsError('STALE_REVISION', 'The skill changed. Review the latest version before saving.', 409);
      if (existing?.archivedAt && !request.restoreVersion) throw new ProjectSkillsError('SKILL_ARCHIVED', 'This skill is archived.', 409);
      current = existing ? await this.readRevision(location, existing, existing.currentVersion) : undefined;
      if (current && !request.restoreVersion && !request.upload && !reviseSkillVersion(current, input!, { actor, timestamp: new Date().toISOString() })) {
        return { entry: existing!, revision: current };
      }
      operation = loaded.data.pendingOperations.find((pending) => pending.operationId === request.operationId);
      if (operation) {
        if (operation.requestHash !== requestHash || operation.actor.email !== actor.email) throw new ProjectSkillsError('OPERATION_REUSED', 'This operation belongs to a different save.', 409);
        break;
      }
      const [sourceFileId, revisionFileId, allocatedHistory] = await this.generatedIds(3);
      operation = SkillOperationSchema.parse({
        operationId: request.operationId, requestHash,
        skillId: existing?.skillId ?? `skill-${randomUUID()}`,
        baseVersion: existing?.currentVersion ?? 0,
        action: request.restoreVersion ? 'restored' : existing ? 'modified' : request.provenance ? 'migrated' : 'added',
        actor, timestamp: new Date().toISOString(), sourceFileId, revisionFileId,
        historyFolderId: existing?.historyFolderId ?? allocatedHistory,
      });
      try {
        await writeConditionalJson(this.drive, location.indexId, { ...loaded.data, pendingOperations: [...loaded.data.pendingOperations, operation] }, loaded.etag);
        break;
      } catch (error) {
        operation = undefined;
        if (!(error instanceof ProjectSkillsError && error.status === 409) || attempt === 3) throw error;
      }
    }
    if (!operation) throw new ProjectSkillsError('RESERVATION_FAILED', 'Could not reserve this save. Please retry.', 409);
    if (!existing) {
      await this.createFile(operation.historyFolderId, operation.skillId, location.historyId, FOLDER_MIME, undefined, { almaOperation: operation.operationId });
    }
    const previous = request.restoreVersion && existing ? await this.readRevision(location, existing, request.restoreVersion) : current;
    const content = request.restoreVersion ? ProjectSkillCreateSchema.parse({
      label: previous!.label, text: previous!.text, source: previous!.source, appearance: previous!.appearance,
    }) : ProjectSkillCreateSchema.parse({
      label: input?.label ?? current?.label, text: input?.text ?? current?.text,
      source: input?.source ?? current?.source, appearance: input?.appearance ?? current?.appearance,
    });
    let sourceFile: SkillSourceFile | undefined = previous?.sourceFile;
    if (request.upload || content.source !== 'file') {
      const upload = request.upload ?? {
        name: `${content.label.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60) || 'skill'}-${operation.skillId}-v${operation.baseVersion + 1}.md`,
        mimeType: 'text/markdown', content: Buffer.from(content.text, 'utf8'),
      };
      sourceFile = {
        fileId: operation.sourceFileId, name: upload.name, mimeType: upload.mimeType || 'application/octet-stream',
        size: upload.content.byteLength, sha256: skillFileHash(upload.content), uploadedBy: operation.actor, uploadedAt: operation.timestamp,
      };
      await this.createFile(sourceFile.fileId, sourceFile.name, location.folderId, sourceFile.mimeType, upload.content, { almaOperation: operation.operationId, almaHash: sourceFile.sha256 });
    }
    if (!sourceFile) throw new ProjectSkillsError('SOURCE_REQUIRED', 'The original uploaded file is required.', 400);
    const context = { actor: operation.actor, timestamp: operation.timestamp, sourceFile };
    const revision = request.restoreVersion
      ? SkillVersionSchema.parse({ ...restoreSkillVersion(current!, previous!, context), sourceFile })
      : current ? reviseSkillVersion(current, content, context)!
        : createSkillVersion(this.projectId, operation.skillId, content, context);
    const raw = JSON.stringify(revision, null, 2);
    const sha256 = skillFileHash(raw);
    await this.createFile(operation.revisionFileId, `v${revision.version}.json`, operation.historyFolderId, 'application/json', raw, { almaOperation: operation.operationId, almaHash: sha256 });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const loaded = await this.readIndex(location);
      const next = commitSkillRevision(loaded.data, operation, revision, { fileId: sourceFile.fileId, name: sourceFile.name, mimeType: sourceFile.mimeType }, sha256, request.provenance);
      try {
        if (next !== loaded.data) await writeConditionalJson(this.drive, location.indexId, next, loaded.etag);
        const entry = next.skills.find((skill) => skill.skillId === operation!.skillId)!;
        return { entry, revision };
      } catch (error) {
        if (!(error instanceof ProjectSkillsError && error.status === 409) || attempt === 3) throw error;
      }
    }
    throw new ProjectSkillsError('SAVE_CONFLICT', 'The library changed while saving. Your draft has been retained.', 409);
  }

  async archive(skillId: string, expectedVersion: number, operationId: string) {
    z.string().uuid().parse(operationId);
    const actor = await this.actor();
    if (!(await this.access()).canWrite) throw new ProjectSkillsError('READ_ONLY_PROJECT', 'You cannot change this project.', 403);
    const location = await this.location();
    if (!location) throw new ProjectSkillsError('SKILL_UNAVAILABLE', 'The skill is unavailable.', 404);
    const event = { operationId, actor, timestamp: new Date().toISOString(), requestHash: skillFileHash(JSON.stringify({ skillId, expectedVersion, action: 'archived' })) };
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const loaded = await this.readIndex(location);
      const next = archiveIndexedSkill(loaded.data, skillId, expectedVersion, event);
      try {
        if (next !== loaded.data) await writeConditionalJson(this.drive, location.indexId, next, loaded.etag);
        return next.skills.find((skill) => skill.skillId === skillId)!;
      } catch (error) {
        if (!(error instanceof ProjectSkillsError && error.status === 409) || attempt === 3) throw error;
      }
    }
    throw new ProjectSkillsError('SAVE_CONFLICT', 'The library changed while archiving. Please retry.', 409);
  }

  async listFolderFiles(folderId: string) {
    const files: drive_v3.Schema$File[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.drive.files.list({
        q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed=false`,
        fields: 'nextPageToken,files(id,name,mimeType,parents,appProperties)',
        pageSize: 1000, pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      files.push(...(response.data.files ?? []));
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    return files;
  }
}