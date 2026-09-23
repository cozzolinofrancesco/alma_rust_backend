import { NextRequest, NextResponse } from 'next/server';
import { google, drive_v3 } from 'googleapis';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { z } from 'zod';

export const runtime = 'nodejs';

// Per-agent activity log, stored as its own sidecar file in the project's AF
// Drive folder — independent of the agent document's save/load cycle. Appends
// are done server-side (read-modify-write + concat) so concurrent editors never
// clobber each other's entries.

const MAX_ENTRIES = 2000;

const ActivityEntrySchema = z.object({
  username: z.string(),
  action: z.enum(['add_step', 'remove_step', 'edit_step', 'link_corpus', 'unlink_corpus']),
  target: z.string(),
  targetId: z.string().optional(),
  detail: z.string().optional(),
  timestamp: z.string(),
});

const AppendBodySchema = z.object({
  entries: z.array(ActivityEntrySchema).min(1).max(200),
});

type ActivityEntry = z.infer<typeof ActivityEntrySchema>;

interface ActivityLogV1 {
  version: 1;
  agentId: string;
  updatedAt: string;
  entries: ActivityEntry[];
}

function logFileName(agentId: string): string {
  return `${agentId}.activity.json`;
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

async function findLogFile(
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

async function readLog(
  drive: drive_v3.Drive,
  fileId: string,
  agentId: string
): Promise<ActivityLogV1> {
  const contentRes = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'text' }
  );
  const body = contentRes.data as unknown;
  const raw = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  const parsed = JSON.parse(raw) as Partial<ActivityLogV1>;
  return {
    version: 1,
    agentId,
    updatedAt: parsed.updatedAt ?? '',
    entries: Array.isArray(parsed.entries) ? parsed.entries : [],
  };
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
    const fileId = await findLogFile(drive, afFolderId, logFileName(agentId));
    if (!fileId) {
      // No log yet — return an empty log rather than 404 so the client renders cleanly.
      return NextResponse.json({ entries: [] });
    }

    const log = await readLog(drive, fileId, agentId);
    return NextResponse.json({ entries: log.entries, updatedAt: log.updatedAt });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
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

    const parsedBody = AppendBodySchema.safeParse(await request.json());
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Invalid activity payload' }, { status: 400 });
    }

    const drive = getDriveClient(accessToken);
    const afFolderId = await ensureAfFolder(drive, projectId);
    const fileName = logFileName(agentId);
    const existingId = await findLogFile(drive, afFolderId, fileName);

    const existing: ActivityEntry[] = existingId
      ? (await readLog(drive, existingId, agentId)).entries
      : [];

    const merged = existing.concat(parsedBody.data.entries).slice(-MAX_ENTRIES);
    const log: ActivityLogV1 = {
      version: 1,
      agentId,
      updatedAt: new Date().toISOString(),
      entries: merged,
    };
    const json = JSON.stringify(log, null, 2);

    if (existingId) {
      await drive.files.update({
        fileId: existingId,
        media: { mimeType: 'application/json', body: json },
        supportsAllDrives: true,
      });
      return NextResponse.json({ ok: true, count: merged.length, fileId: existingId });
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
    return NextResponse.json({ ok: true, count: merged.length, fileId: created.data.id ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
