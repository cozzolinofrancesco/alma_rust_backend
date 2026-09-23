import { google, type drive_v3 } from 'googleapis';
import type { z } from 'zod';
import { ProjectSkillsError } from './projectSkills';

const conditionalDrive = (drive: drive_v3.Drive) => google.drive({ version: 'v2', auth: drive.context._options.auth });

export function driveErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { code?: number | string; response?: { status?: number } };
  return value.response?.status ?? (typeof value.code === 'number' ? value.code : undefined);
}

export function rethrowDriveError(error: unknown): never {
  const status = driveErrorStatus(error);
  if (status === 412) throw new ProjectSkillsError('STALE_WRITE', 'Another person saved changes. Reload before saving again.', 409);
  if (status === 403) throw new ProjectSkillsError('FORBIDDEN', 'You do not have permission to access this project file.', 403);
  if (status === 404) throw new ProjectSkillsError('FILE_UNAVAILABLE', 'The project file is unavailable.', 404);
  throw error;
}

export async function readDriveFileMetadata(drive: drive_v3.Drive, fileId: string) {
  try {
    const response = await conditionalDrive(drive).files.get({
      fileId, supportsAllDrives: true, fields: 'id,etag,properties',
    });
    if (!response.data.etag) throw new ProjectSkillsError('PRECONDITION_UNAVAILABLE', 'Drive did not provide a write precondition.', 503);
    return { etag: response.data.etag, properties: response.data.properties ?? [] };
  } catch (error) { return rethrowDriveError(error); }
}

export async function readConditionalJson<Output, Input = Output>(drive: drive_v3.Drive, fileId: string, schema: z.ZodType<Output, z.ZodTypeDef, Input>): Promise<{ data: Output; etag: string }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await readDriveFileMetadata(drive, fileId);
    let raw: unknown;
    try {
      const response = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'text' });
      raw = response.data;
    } catch (error) { return rethrowDriveError(error); }
    const after = await readDriveFileMetadata(drive, fileId);
    if (before.etag !== after.etag) continue;
    try {
      return { data: schema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw), etag: after.etag };
    } catch {
      throw new ProjectSkillsError('INVALID_STORED_DATA', 'The saved skills data is invalid. It has not been overwritten.', 422);
    }
  }
  throw new ProjectSkillsError('STALE_READ', 'The skills library changed while loading. Please reload.', 409);
}

export async function writeConditionalJson(drive: drive_v3.Drive, fileId: string, data: unknown, etag: string): Promise<void> {
  if (!etag) throw new ProjectSkillsError('PRECONDITION_REQUIRED', 'A write precondition is required.', 428);
  try {
    await conditionalDrive(drive).files.update({
      fileId,
      supportsAllDrives: true,
      media: { mimeType: 'application/json', body: JSON.stringify(data, null, 2) },
      fields: 'id',
    }, { headers: { 'If-Match': etag } });
  } catch (error) { rethrowDriveError(error); }
}

export async function setConditionalProperty(drive: drive_v3.Drive, fileId: string, key: string, value: string, metadata: Awaited<ReturnType<typeof readDriveFileMetadata>>): Promise<void> {
  try {
    await conditionalDrive(drive).files.patch({
      fileId,
      supportsAllDrives: true,
      requestBody: { properties: [
        ...metadata.properties.filter((property) => property.key !== key || property.visibility !== 'PRIVATE'),
        { key, value, visibility: 'PRIVATE' },
      ] },
      fields: 'id',
    }, { headers: { 'If-Match': metadata.etag } });
  } catch (error) { rethrowDriveError(error); }
}