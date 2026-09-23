import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import type { Session } from '@/app/lib/authOptions';
import { google } from 'googleapis';
import { createRefreshableAuth } from '@/app/lib/rag/auth';

const PDFS_FOLDER_NAME = 'PDFs';

export async function GET(request: Request) {
  const session = (await getApiSession(request)) as Session | null;
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const q         = searchParams.get('q') ?? '';
  const pageToken = searchParams.get('pageToken') ?? undefined;
  const projectId = searchParams.get('projectId') ?? undefined;

  const auth = createRefreshableAuth(
    session.accessToken,
    session.refreshToken ?? undefined,
  );
  const drive = google.drive({ version: 'v3', auth });

  let parentsFilter = '';
  if (projectId?.trim()) {
    try {
      const folderRes = await drive.files.list({
        q: `name='${PDFS_FOLDER_NAME}' and '${projectId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id)',
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      const pdfsFolderId = folderRes.data.files?.[0]?.id;
      if (pdfsFolderId) {
        parentsFilter = ` and '${pdfsFolderId}' in parents`;
      }
      else {
        return NextResponse.json({ files: [], nextPageToken: null });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to resolve project PDFs folder';
      console.error('[drive-files]', msg);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  let driveQuery = `mimeType='application/pdf' and trashed=false${parentsFilter}`;
  if (q.trim()) {
    const safe = q.trim().replace(/'/g, "\\'");
    driveQuery += ` and name contains '${safe}'`;
  }

  try {
    const res = await drive.files.list({
      q:      driveQuery,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime)',
      pageSize: 50,
      orderBy: 'modifiedTime desc',
      spaces: 'drive',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      ...(pageToken ? { pageToken } : {}),
    });

    const files = (res.data.files ?? []).map((f) => ({
      id:           f.id!,
      name:         f.name!,
      mimeType:     f.mimeType!,
      size:         f.size ? parseInt(String(f.size), 10) : null,
      modifiedTime: f.modifiedTime ?? null,
    }));

    return NextResponse.json({
      files,
      nextPageToken: res.data.nextPageToken ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to list Drive files';
    console.error('[drive-files]', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
