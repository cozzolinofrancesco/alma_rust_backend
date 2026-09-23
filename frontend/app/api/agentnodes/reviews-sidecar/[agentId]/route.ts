
import { NextRequest, NextResponse } from 'next/server';
import { google, drive_v3 } from 'googleapis';
import { getApiSession } from '@/app/lib/apiCaller.server';

export const runtime = 'nodejs';

function reviewFileName(agentId: string): string {
  return `${agentId}.reviews.json`;
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
    fields: 'files(id)',
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

async function findFile(
  drive: drive_v3.Drive,
  parentFolderId: string,
  fileName: string,
): Promise<string | null> {
  const escaped = fileName.replace(/'/g, "\\'");
  const list = await drive.files.list({
    q: `'${parentFolderId}' in parents and name = '${escaped}' and trashed = false`,
    fields: 'files(id)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return list.data.files?.[0]?.id ?? null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const { agentId } = await params;
    const projectId = request.nextUrl.searchParams.get('projectId');
    if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 });
    const accessToken = await resolveAccessToken(request);
    if (!accessToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const drive = getDriveClient(accessToken);
    const afId = await ensureAfFolder(drive, projectId);
    const fileId = await findFile(drive, afId, reviewFileName(agentId));
    if (!fileId) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const res = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'text' },
    );
    const body = res.data as unknown;
    const raw = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    return NextResponse.json({ reviewRun: JSON.parse(raw) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown' }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const { agentId } = await params;
    const projectId = request.nextUrl.searchParams.get('projectId');
    if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 });
    const accessToken = await resolveAccessToken(request);
    if (!accessToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = (await request.json()) as { reviewRun?: unknown };
    if (!body?.reviewRun) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

    const drive = getDriveClient(accessToken);
    const afId = await ensureAfFolder(drive, projectId);
    const fileName = reviewFileName(agentId);
    const json = JSON.stringify(body.reviewRun, null, 2);
    const existingId = await findFile(drive, afId, fileName);

    if (existingId) {
      await drive.files.update({
        fileId: existingId,
        media: { mimeType: 'application/json', body: json },
        supportsAllDrives: true,
      });
    } else {
      await drive.files.create({
        requestBody: { name: fileName, parents: [afId], mimeType: 'application/json' },
        media: { mimeType: 'application/json', body: json },
        fields: 'id',
        supportsAllDrives: true,
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown' }, { status: 500 });
  }
}
