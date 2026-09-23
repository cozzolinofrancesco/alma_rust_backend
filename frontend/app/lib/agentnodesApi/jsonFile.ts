import type { drive_v3 } from 'googleapis';

export async function findFileIdByName(
  drive: drive_v3.Drive,
  parentId: string,
  fileName: string
): Promise<string | null> {
  const escaped = fileName.replace(/'/g, "\\'");
  const q = [`'${parentId}' in parents`, `name = '${escaped}'`, 'trashed = false'].join(' and ');
  const list = await drive.files.list({
    q,
    fields: 'files(id, name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return list.data.files?.[0]?.id ?? null;
}

export async function readJsonFileById<T>(drive: drive_v3.Drive, fileId: string): Promise<T | null> {
  try {
    const res = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'text' }
    );
    const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? {});
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJsonNamedFile(
  drive: drive_v3.Drive,
  parentId: string,
  fileName: string,
  payload: unknown
): Promise<{ fileId: string; created: boolean }> {
  const json = JSON.stringify(payload, null, 2);
  const existingId = await findFileIdByName(drive, parentId, fileName);
  if (existingId) {
    await drive.files.update({
      fileId: existingId,
      media: { mimeType: 'application/json', body: json },
      supportsAllDrives: true,
    });
    return { fileId: existingId, created: false };
  }
  const created = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [parentId],
      mimeType: 'application/json',
    },
    media: { mimeType: 'application/json', body: json },
    fields: 'id',
    supportsAllDrives: true,
  });
  return { fileId: created.data.id ?? '', created: true };
}

export async function deleteFileById(drive: drive_v3.Drive, fileId: string): Promise<void> {
  await drive.files.delete({ fileId, supportsAllDrives: true });
}
