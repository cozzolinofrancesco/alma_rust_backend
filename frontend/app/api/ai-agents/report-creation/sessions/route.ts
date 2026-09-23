
import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { createRefreshableAuth } from '@/app/lib/rag/auth';
import { google } from 'googleapis';
import {
  createSessionManifest,
  listSessionManifests,
} from '@/app/lib/reportCreation/sessionManifest';
import type { CreateSessionPayload } from '@/app/lib/reportCreation/sessionTypes';

export const runtime = 'nodejs';

async function getReportCreationCorpusFolderId(
  auth: ReturnType<typeof createRefreshableAuth>,
  projectId: string
): Promise<string | null> {
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.list({
    q: `'${projectId}' in parents and name='report_creation_corpus' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files?.[0]?.id ?? null;
}

async function ensureReportCreationCorpusFolder(
  auth: ReturnType<typeof createRefreshableAuth>,
  projectId: string
): Promise<string> {
  const existing = await getReportCreationCorpusFolderId(auth, projectId);
  if (existing) return existing;

  const drive = google.drive({ version: 'v3', auth });
  const created = await drive.files.create({
    requestBody: {
      name: 'report_creation_corpus',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [projectId],
    },
    fields: 'id',
    supportsAllDrives: true,
  });
  const folderId = created.data.id;
  if (!folderId) throw new Error('Failed to create report_creation_corpus folder');
  return folderId;
}

export async function POST(request: Request): Promise<Response> {
  const session = await getApiSession(request);
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: CreateSessionPayload;
  try {
    body = (await request.json()) as CreateSessionPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { projectId, sessionName } = body;
  if (!projectId || !sessionName?.trim()) {
    return NextResponse.json(
      { error: 'projectId and sessionName are required' },
      { status: 400 }
    );
  }

  try {
    const auth = createRefreshableAuth(session.accessToken, session.refreshToken);

    const folderId = await ensureReportCreationCorpusFolder(auth, projectId);

    const manifest = await createSessionManifest(auth, {
      projectId,
      userEmail: session.user?.email ?? 'unknown',
      sessionName: sessionName.trim(),
      manifestFolderId: folderId,
    });

    return NextResponse.json({ session: manifest }, { status: 201 });
  } catch (error) {
    console.error('[report-creation/sessions] POST failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create session' },
      { status: 500 }
    );
  }
}

export async function GET(request: Request): Promise<Response> {
  const session = await getApiSession(request);
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('projectId');
  if (!projectId) {
    return NextResponse.json({ error: 'projectId query parameter is required' }, { status: 400 });
  }

  try {
    const auth = createRefreshableAuth(session.accessToken, session.refreshToken);

    const folderId = await getReportCreationCorpusFolderId(auth, projectId);
    if (!folderId) {
      return NextResponse.json({ sessions: [] });
    }

    const sessions = await listSessionManifests(auth, folderId);
    return NextResponse.json({ sessions });
  } catch (error) {
    console.error('[report-creation/sessions] GET failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list sessions' },
      { status: 500 }
    );
  }
}
