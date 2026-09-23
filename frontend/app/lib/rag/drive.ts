import { google } from 'googleapis';
import type { OAuth2Client } from 'googleapis-common';
import { DriveFile, DriveFolder } from './types';

export interface DriveSearchResult {
  folders: DriveFolder[];
  files: DriveFile[];
}

export async function searchDriveFolders(
  queryOrId: string,
  auth: OAuth2Client
): Promise<DriveFolder[]> {
  const drive = google.drive({ version: 'v3', auth });

  const isDriveId = /^[a-zA-Z0-9_-]{20,}$/.test(queryOrId);

  if (isDriveId) {
    try {
      const response = await drive.files.get({
        fileId: queryOrId,
        fields: 'id, name, owners, shared, parents',
        supportsAllDrives: true,
      });

      if (response.data.mimeType !== 'application/vnd.google-apps.folder') {
        throw new Error('ID is not a folder');
      }

      const parents = (response.data.parents || []) as string[];
      const parentNamesById = await resolveFolderNamesById(parents, drive);
      return [
        {
          id: response.data.id!,
          name: response.data.name!,
          owners: response.data.owners as Array<{ emailAddress?: string; displayName?: string }>,
          shared: response.data.shared || false,
          parents,
          parentNames: parents.map((pid) => parentNamesById[pid]).filter(Boolean),
        },
      ];
    } catch (error) {
      console.error('Failed to fetch folder by ID:', error);
      return [];
    }
  }

  const query = `mimeType='application/vnd.google-apps.folder' and name contains '${queryOrId.replace(/'/g, "\\'")}' and trashed=false`;
  
  try {
    const response = await drive.files.list({
      q: query,
      fields: 'files(id, name, owners, shared, parents)',
      pageSize: 100,
      spaces: 'drive',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      orderBy: 'modifiedTime desc',
    });

    const folders = (response.data.files || []).map((file) => ({
      id: file.id!,
      name: file.name!,
      owners: file.owners as Array<{ emailAddress?: string; displayName?: string }>,
      shared: file.shared || false,
      parents: (file.parents || []) as string[],
    }));

    const parentIds = folders.flatMap((folder) => (folder.parents || []).slice(0, 1));
    const parentNamesById = await resolveFolderNamesById(parentIds, drive);
    return folders.map((folder) => {
      const firstParentId = (folder.parents || [])[0];
      const parentName = firstParentId ? parentNamesById[firstParentId] : '';
      return {
        ...folder,
        parentNames: parentName ? [parentName] : [],
      };
    });
  } catch (error) {
    console.error('Failed to search Drive folders:', error);
    throw error;
  }
}

async function resolveFolderNamesById(
  ids: string[],
  drive: ReturnType<typeof google.drive>
): Promise<Record<string, string>> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  const entries = await Promise.all(
    unique.map(async (fileId) => {
      try {
        const res = await drive.files.get({
          fileId,
          fields: 'id,name',
          supportsAllDrives: true,
        });
        return [fileId, res.data.name || ''] as const;
      } catch {
        return [fileId, ''] as const;
      }
    })
  );
  return Object.fromEntries(entries);
}

export async function searchDriveItems(
  queryOrId: string,
  auth: OAuth2Client
): Promise<DriveSearchResult> {
  const drive = google.drive({ version: 'v3', auth });

  const isDriveId = /^[a-zA-Z0-9_-]{20,}$/.test(queryOrId);

  if (isDriveId) {
    try {
      const response = await drive.files.get({
        fileId: queryOrId,
        fields: 'id, name, mimeType, size, owners, shared, parents',
        supportsAllDrives: true,
      });

      const mimeType = response.data.mimeType || 'application/octet-stream';
      const owners = response.data.owners as Array<{ emailAddress?: string; displayName?: string }> | undefined;
      const parents = (response.data.parents || []) as string[];

      if (mimeType === 'application/vnd.google-apps.folder') {
        const parentNamesById = await resolveFolderNamesById(parents, drive);
        return {
          folders: [
            {
              id: response.data.id!,
              name: response.data.name!,
              owners,
              shared: response.data.shared || false,
              parents,
              parentNames: parents.map((pid) => parentNamesById[pid]).filter(Boolean),
            },
          ],
          files: [],
        };
      }

      return {
        folders: [],
        files: [
          {
            id: response.data.id!,
            name: response.data.name!,
            mimeType,
            size: response.data.size ? parseInt(String(response.data.size), 10) : undefined,
            owners,
            parents,
          },
        ],
      };
    } catch (error) {
      console.error('Failed to fetch Drive item by ID:', error);
      return { folders: [], files: [] };
    }
  }

  const safe = queryOrId.replace(/'/g, "\\'");
  const query = `name contains '${safe}' and trashed=false`;

  try {
    const response = await drive.files.list({
      q: query,
      fields: 'files(id, name, mimeType, size, owners, shared, parents)',
      pageSize: 20,
      spaces: 'drive',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      orderBy: 'modifiedTime desc',
    });

    const all = response.data.files || [];

    const folders: DriveFolder[] = [];
    const files: DriveFile[] = [];

    for (const f of all) {
      const mimeType = f.mimeType || 'application/octet-stream';
      const owners = f.owners as Array<{ emailAddress?: string; displayName?: string }> | undefined;
      const parents = (f.parents || []) as string[];

      if (mimeType === 'application/vnd.google-apps.folder') {
        folders.push({
          id: f.id!,
          name: f.name!,
          owners,
          shared: f.shared || false,
          parents,
        });
      } else {
        files.push({
          id: f.id!,
          name: f.name!,
          mimeType,
          size: f.size ? parseInt(String(f.size), 10) : undefined,
          owners,
          parents,
        });
      }
    }

    const parentIds = folders.flatMap((folder) => (folder.parents || []).slice(0, 1));
    const parentNamesById = await resolveFolderNamesById(parentIds, drive);
    const foldersWithParentNames: DriveFolder[] = folders.map((folder) => {
      const firstParentId = (folder.parents || [])[0];
      const parentName = firstParentId ? parentNamesById[firstParentId] : '';
      return {
        ...folder,
        parentNames: parentName ? [parentName] : [],
      };
    });

    return { folders: foldersWithParentNames, files };
  } catch (error) {
    console.error('Failed to search Drive items:', error);
    throw error;
  }
}

export async function listFolderFiles(
  folderId: string,
  auth: OAuth2Client
): Promise<DriveFile[]> {
  const drive = google.drive({ version: 'v3', auth });

  try {
    const query = `'${folderId}' in parents and trashed=false`;
    const response = await drive.files.list({
      q: query,
      fields: 'files(id, name, mimeType, size, createdTime, modifiedTime, owners, parents)',
      pageSize: 100,
      orderBy: 'name',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    return (response.data.files || []).map((file) => ({
      id: file.id!,
      name: file.name!,
      mimeType: file.mimeType!,
      size: file.size ? parseInt(file.size, 10) : undefined,
      parents: (file.parents || []) as string[],
      createdTime: file.createdTime || undefined,
      modifiedTime: file.modifiedTime || undefined,
      owners: file.owners as Array<{ emailAddress?: string; displayName?: string }>,
    }));
  } catch (error) {
    console.error('Failed to list folder files:', error);
    throw error;
  }
}

export async function getFilesMetadataByIds(
  fileIds: string[],
  auth: OAuth2Client
): Promise<DriveFile[]> {
  const drive = google.drive({ version: 'v3', auth });
  const uniqueIds = Array.from(new Set(fileIds.filter(Boolean)));

  // Fetch metadata in parallel (was a serial per-id loop). Mirrors the
  // Promise.all pattern in resolveFolderNamesById; each item still falls back
  // to a placeholder on failure so one bad id can't fail the whole batch.
  return Promise.all(
    uniqueIds.map(async (fileId): Promise<DriveFile> => {
      try {
        const res = await drive.files.get({
          fileId,
          fields: 'id,name,mimeType,size,parents',
          supportsAllDrives: true,
        });
        return {
          id: res.data.id!,
          name: res.data.name || fileId,
          mimeType: res.data.mimeType || 'application/octet-stream',
          size: res.data.size ? parseInt(String(res.data.size), 10) : undefined,
          parents: (res.data.parents || []) as string[],
        };
      } catch (error) {
        console.warn(`[Drive] Failed to fetch metadata for file ${fileId}:`, error);
        return {
          id: fileId,
          name: fileId,
          mimeType: 'application/octet-stream',
          size: undefined,
        };
      }
    }),
  );
}

export async function getFolderMetadata(
  folderId: string,
  auth: OAuth2Client
): Promise<DriveFolder> {
  const drive = google.drive({ version: 'v3', auth });

  try {
    const response = await drive.files.get({
      fileId: folderId,
      fields: 'id, name, owners, shared',
      supportsAllDrives: true,
    });

    return {
      id: response.data.id!,
      name: response.data.name!,
      owners: response.data.owners as Array<{ emailAddress?: string; displayName?: string }>,
      shared: response.data.shared || false,
    };
  } catch (error) {
    console.error('Failed to get folder metadata:', error);
    throw error;
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function downloadFileStream(
  fileId: string,
  auth: OAuth2Client,
  driveMimeType?: string
): Promise<{ stream: unknown; mimeType: string }> {
  const drive = google.drive({ version: 'v3', auth });
  let currentFileId = fileId;

  try {
    let mimeType = driveMimeType;
    
    if (!mimeType || mimeType === 'application/vnd.google-apps.shortcut') {
      const meta = await drive.files.get({
        fileId: currentFileId,
        fields: 'id, mimeType, shortcutDetails',
        supportsAllDrives: true,
      });
      
      mimeType = meta.data.mimeType || 'application/octet-stream';

      if (mimeType === 'application/vnd.google-apps.shortcut' && meta.data.shortcutDetails?.targetId) {
        console.log(`🔗 [Drive] Resolving shortcut ${currentFileId} -> ${meta.data.shortcutDetails.targetId}`);
        currentFileId = meta.data.shortcutDetails.targetId;
        
        const targetMeta = await drive.files.get({
          fileId: currentFileId,
          fields: 'id, mimeType',
          supportsAllDrives: true,
        });
        mimeType = targetMeta.data.mimeType || 'application/octet-stream';
      }
    }

    console.log(`⬇️ [Drive] Downloading ${currentFileId} (${mimeType})`);

    if (mimeType.startsWith('application/vnd.google-apps.')) {
      let exportMimeType = 'application/pdf';
      if (mimeType === 'application/vnd.google-apps.spreadsheet') {
        exportMimeType = 'text/csv';
      }

      return await retryOperation(async () => {
        const exportRes = await drive.files.export(
          { fileId: currentFileId, mimeType: exportMimeType },
          { responseType: 'stream' }
        );
        return { stream: exportRes.data, mimeType: exportMimeType };
      }, 'Drive Export');
    }

    return await retryOperation(async () => {
      try {
        const response = await drive.files.get(
          { fileId: currentFileId, alt: 'media', supportsAllDrives: true },
          { responseType: 'stream' }
        );
        return { stream: response.data, mimeType: mimeType! };
      } catch (err: unknown) {
        const driveErr = err as { status?: number; response?: { status?: number } };
        if (driveErr.status === 400 || (driveErr.response && driveErr.response.status === 400)) {
          console.warn(`⚠️ [Drive] Standard download failed (400), trying export fallback for ${currentFileId}`);
          const exportRes = await drive.files.export(
            { fileId: currentFileId, mimeType: 'application/pdf' },
            { responseType: 'stream' }
          );
          return { stream: exportRes.data, mimeType: 'application/pdf' };
        }
        throw err;
      }
    }, 'Drive Download');

  } catch (error) {
    console.error(`❌ [Drive] Failed to download file ${fileId}:`, error);
    throw error;
  }
}

async function retryOperation<T>(operation: () => Promise<T>, context: string, maxRetries = 3): Promise<T> {
  let lastError: unknown;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error;
      const driveErr = error as { status?: number; response?: { status?: number } };
      const status = driveErr.status || driveErr.response?.status;
      
      if (status === 429 || status === 403 || (status != null && status >= 500 && status < 600)) {
        const delayMs = attempt * 2000;
        console.warn(`⚠️ [${context}] Retry ${attempt}/${maxRetries} after error ${status}. Waiting ${delayMs}ms...`);
        await sleep(delayMs);
        continue;
      }
      
      throw error;
    }
  }
  
  throw lastError;
}
