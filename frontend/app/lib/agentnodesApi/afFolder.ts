import type { drive_v3 } from 'googleapis';

export const AF_FOLDER_NAME = 'AF';

export async function ensureAfFolder(drive: drive_v3.Drive, projectId: string): Promise<string> {
  const query = [
    `'${projectId}' in parents`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    `name = '${AF_FOLDER_NAME.replace(/'/g, "\\'")}'`,
    'trashed = false',
  ].join(' and ');
  const list = await drive.files.list({
    q: query,
    fields: 'files(id, name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const existing = list.data.files?.[0]?.id;
  if (existing) return existing;

  const created = await drive.files.create({
    requestBody: {
      name: AF_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [projectId],
    },
    fields: 'id',
    supportsAllDrives: true,
  });
  if (!created.data.id) throw new Error('Could not create AF folder');
  return created.data.id;
}

export async function listAfJsonFiles(drive: drive_v3.Drive, afFolderId: string) {
  const q = `'${afFolderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`;
  const res = await drive.files.list({
    q,
    fields: 'files(id, name, mimeType, createdTime, modifiedTime)',
    pageSize: 1000,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files ?? [];
}

export function isAgentSidecarFileName(name: string): boolean {
  return (
    /\.canvas272\.json$/i.test(name) ||
    /\.agentnodes-graph\.json$/i.test(name) ||
    /\.agentnodes-meta\.json$/i.test(name) ||
    /\.reviews\.json$/i.test(name)
  );
}
