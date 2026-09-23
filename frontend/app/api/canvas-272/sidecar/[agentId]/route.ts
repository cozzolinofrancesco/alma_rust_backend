
import { NextRequest, NextResponse } from 'next/server';
import { google, drive_v3 } from 'googleapis';
import { getApiSession } from '@/app/lib/apiCaller.server';

export const runtime = 'nodejs';

interface Canvas272SidecarV1 {
  version: 1;
  agentId: string;
  agentName: string;
  updatedAt: string;
  outputs: Record<string, string>;
}

interface SidecarPutBody {
  sidecar: Canvas272SidecarV1;
}

function sidecarFileName(agentId: string): string {
  return `${agentId}.canvas272.json`;
}

async function resolveAccessToken(request: NextRequest): Promise<string | null> {
  return (await getApiSession(request))?.accessToken ?? null;
}

function getDriveClient(accessToken: string): drive_v3.Drive {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.drive({ version: 'v3', auth });
}

async function ensureAfFolder(drive: drive_v3.Drive, projectId: string): Promise<string> {
  const query = [
    `'${projectId}' in parents`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    `name = 'AF'`,
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
      name: 'AF',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [projectId],
    },
    fields: 'id',
    supportsAllDrives: true,
  });
  if (!created.data.id) throw new Error('Could not create AF folder');
  return created.data.id;
}

async function findSidecarFile(
  drive: drive_v3.Drive,
  parentFolderId: string,
  fileName: string
): Promise<string | null> {
  const escapedName = fileName.replace(/'/g, "\\'");
  const query = [
    `'${parentFolderId}' in parents`,
    `name = '${escapedName}'`,
    'trashed = false',
  ].join(' and ');
  const list = await drive.files.list({
    q: query,
    fields: 'files(id, name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return list.data.files?.[0]?.id ?? null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  try {
    const { agentId } = await params;
    const projectId = request.nextUrl.searchParams.get('projectId');
    if (!projectId) {
      return NextResponse.json({ error: 'projectId query param required' }, { status: 400 });
    }
    const accessToken = await resolveAccessToken(request);
    if (!accessToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const drive = getDriveClient(accessToken);
    const afFolderId = await ensureAfFolder(drive, projectId);
    const fileId = await findSidecarFile(drive, afFolderId, sidecarFileName(agentId));
    if (!fileId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const contentRes = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'text' }
    );
    const body = contentRes.data as unknown;
    const raw = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    const parsed = JSON.parse(raw) as Canvas272SidecarV1;
    return NextResponse.json({ sidecar: parsed });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  try {
    const { agentId } = await params;
    const projectId = request.nextUrl.searchParams.get('projectId');
    if (!projectId) {
      return NextResponse.json({ error: 'projectId query param required' }, { status: 400 });
    }
    const accessToken = await resolveAccessToken(request);
    if (!accessToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json()) as SidecarPutBody;
    if (!body?.sidecar || body.sidecar.version !== 1 || body.sidecar.agentId !== agentId) {
      return NextResponse.json({ error: 'Invalid sidecar payload' }, { status: 400 });
    }

    const drive = getDriveClient(accessToken);
    const afFolderId = await ensureAfFolder(drive, projectId);
    const fileName = sidecarFileName(agentId);
    const json = JSON.stringify(body.sidecar, null, 2);
    const existingId = await findSidecarFile(drive, afFolderId, fileName);

    if (existingId) {
      await drive.files.update({
        fileId: existingId,
        media: { mimeType: 'application/json', body: json },
        supportsAllDrives: true,
      });
      return NextResponse.json({ ok: true, fileId: existingId });
    }

    const created = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [afFolderId],
        mimeType: 'application/json',
      },
      media: { mimeType: 'application/json', body: json },
      fields: 'id',
      supportsAllDrives: true,
    });
    return NextResponse.json({ ok: true, fileId: created.data.id ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
