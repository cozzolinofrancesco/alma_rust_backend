import { Readable } from 'stream';
import type { drive_v3 } from 'googleapis';
import { agentFileSchema, driveFileIdSchema, isAgentFileSupported, type AgentFile } from './agentFiles';
import { getExportMimeType, MAX_FILE_SIZE_BYTES } from './fileValidation';

const entryProperty = 'almaAgentFile';
const sourceFields = 'id,name,mimeType,size,version,modifiedTime,trashed,capabilities(canDownload)';

export class AgentFileError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

async function readBounded(stream: Readable, limit: number, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) throw new AgentFileError('INPUT_TOO_LARGE', 'File exceeds the 30MB limit.', 413);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  } finally {
    stream.destroy();
  }
}

async function sourceMetadata(drive: drive_v3.Drive, sourceId: string, signal?: AbortSignal) {
  if (!driveFileIdSchema.safeParse(sourceId).success) throw new AgentFileError('INVALID_FILE', 'Invalid file ID.');
  const { data } = await drive.files.get({ fileId: sourceId, fields: sourceFields, supportsAllDrives: true }, { signal });
  if (data.trashed || data.capabilities?.canDownload === false) {
    throw new AgentFileError('SOURCE_ACCESS_DENIED', 'The original file is unavailable or cannot be downloaded.', 403);
  }
  if (!data.name || !data.mimeType || !isAgentFileSupported(data.mimeType, data.name)) {
    throw new AgentFileError('UNSUPPORTED_INPUT', 'Use a PDF, a supported text file, or a Google document that exports to PDF.');
  }
  const size = Number(data.size ?? 0);
  if (!Number.isFinite(size) || size > MAX_FILE_SIZE_BYTES) throw new AgentFileError('INPUT_TOO_LARGE', 'File exceeds the 30MB limit.', 413);
  return { sourceId, name: data.name, mimeType: data.mimeType, size, revision: data.version ?? data.modifiedTime ?? undefined };
}

async function assertOwnedEntry(drive: drive_v3.Drive, id: string, signal?: AbortSignal): Promise<void> {
  if (!driveFileIdSchema.safeParse(id).success) throw new AgentFileError('INVALID_FILE', 'Invalid library file ID.');
  const { data } = await drive.files.get({ fileId: id, fields: 'id,ownedByMe,appProperties,trashed,mimeType', supportsAllDrives: true }, { signal });
  if (!data.ownedByMe || data.trashed || data.appProperties?.[entryProperty] !== '1' || data.mimeType !== 'application/json') {
    throw new AgentFileError('SOURCE_ACCESS_DENIED', 'This saved file is not in your personal library.', 403);
  }
}

export async function getAgentFile(drive: drive_v3.Drive, id: string, signal?: AbortSignal): Promise<AgentFile> {
  await assertOwnedEntry(drive, id, signal);
  const result = await drive.files.get({ fileId: id, alt: 'media', supportsAllDrives: true }, { responseType: 'stream', signal });
  const raw = await readBounded(result.data, 64 * 1024, signal);
  let value: unknown;
  try { value = JSON.parse(raw.toString('utf8')); } catch { throw new AgentFileError('INVALID_STORED_DATA', 'The saved file entry is unreadable.', 422); }
  const parsed = agentFileSchema.safeParse({ ...(value && typeof value === 'object' ? value : {}), id });
  if (!parsed.success) throw new AgentFileError('INVALID_STORED_DATA', 'The saved file entry is invalid.', 422);
  return parsed.data;
}

export async function listAgentFiles(drive: drive_v3.Drive, signal?: AbortSignal): Promise<AgentFile[]> {
  const entries: AgentFile[] = [];
  let pageToken: string | undefined;
  do {
    const result = await drive.files.list({
      q: `'me' in owners and trashed=false and appProperties has { key='${entryProperty}' and value='1' }`,
      fields: 'nextPageToken,files(id)', pageSize: 100, pageToken, spaces: 'drive', orderBy: 'createdTime',
    }, { signal });
    for (const entry of result.data.files ?? []) {
      if (entry.id) entries.push(await getAgentFile(drive, entry.id, signal));
    }
    pageToken = result.data.nextPageToken ?? undefined;
  } while (pageToken);
  return entries;
}

export async function importAgentFile(drive: drive_v3.Drive, sourceId: string, source: AgentFile['source'] = 'drive', signal?: AbortSignal): Promise<AgentFile> {
  const metadata = await sourceMetadata(drive, sourceId, signal);
  const existing = await drive.files.list({
    q: `'me' in owners and trashed=false and appProperties has { key='${entryProperty}' and value='1' } and appProperties has { key='sourceId' and value='${sourceId}' }`,
    fields: 'files(id)', pageSize: 1, orderBy: 'createdTime', spaces: 'drive',
  }, { signal });
  const existingId = existing.data.files?.[0]?.id;
  if (existingId) return getAgentFile(drive, existingId, signal);
  const entry = { ...metadata, source, createdAt: new Date().toISOString() };
  const created = await drive.files.create({
    requestBody: {
      name: `${metadata.name}.alma-file.json`, mimeType: 'application/json',
      appProperties: { [entryProperty]: '1', sourceId },
    },
    media: { mimeType: 'application/json', body: Readable.from([JSON.stringify(entry)]) }, fields: 'id',
  }, { signal });
  return agentFileSchema.parse({ ...entry, id: created.data.id });
}

export async function uploadAgentFile(drive: drive_v3.Drive, file: File, signal?: AbortSignal): Promise<AgentFile> {
  if (!file.size) throw new AgentFileError('UNREADABLE_DOCUMENT', 'The file is empty.');
  if (file.size > MAX_FILE_SIZE_BYTES) throw new AgentFileError('INPUT_TOO_LARGE', 'File exceeds the 30MB limit.', 413);
  if (!isAgentFileSupported(file.type, file.name) || file.type.startsWith('application/vnd.google-apps.')) {
    throw new AgentFileError('UNSUPPORTED_INPUT', 'Use a PDF or supported UTF-8 text file.');
  }
  const mimeType = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/plain');
  const created = await drive.files.create({
    requestBody: { name: file.name, mimeType },
    media: { mimeType, body: Readable.from(Buffer.from(await file.arrayBuffer())) }, fields: 'id',
  }, { signal });
  const sourceId = created.data.id;
  if (!sourceId) throw new AgentFileError('UPLOAD_FAILED', 'Upload did not return a file ID.', 502);
  try {
    return await importAgentFile(drive, sourceId, 'upload', signal);
  } catch (error) {
    await drive.files.update({ fileId: sourceId, requestBody: { trashed: true } }).catch(() => undefined);
    throw error;
  }
}

export async function updateAgentFileLabel(drive: drive_v3.Drive, id: string, name: string, signal?: AbortSignal): Promise<AgentFile> {
  const entry = await getAgentFile(drive, id, signal);
  const next = agentFileSchema.parse({ ...entry, name });
  await drive.files.update({ fileId: id, media: { mimeType: 'application/json', body: Readable.from([JSON.stringify(next)]) } }, { signal });
  return next;
}

export async function removeAgentFile(drive: drive_v3.Drive, id: string, signal?: AbortSignal): Promise<void> {
  await assertOwnedEntry(drive, id, signal);
  await drive.files.update({ fileId: id, requestBody: { trashed: true } }, { signal });
}

export async function downloadAgentFile(drive: drive_v3.Drive, id: string, signal?: AbortSignal) {
  const entry = await getAgentFile(drive, id, signal);
  const before = await sourceMetadata(drive, entry.sourceId, signal);
  const exportMime = getExportMimeType(before.mimeType);
  const result = exportMime
    ? await drive.files.export({ fileId: entry.sourceId, mimeType: exportMime }, { responseType: 'stream', signal })
    : await drive.files.get({ fileId: entry.sourceId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream', signal });
  const bytes = await readBounded(result.data, MAX_FILE_SIZE_BYTES, signal);
  if (!bytes.length) throw new AgentFileError('UNREADABLE_DOCUMENT', 'The original file is empty.', 422);
  const after = await sourceMetadata(drive, entry.sourceId, signal);
  if (before.revision !== after.revision) throw new AgentFileError('SOURCE_CHANGED', 'The original file changed during download. Retry the run.', 409);
  const name = exportMime ? `${before.name}.pdf` : before.name;
  return { bytes, name, mimeType: exportMime ?? before.mimeType, sourceId: entry.sourceId, revision: before.revision };
}