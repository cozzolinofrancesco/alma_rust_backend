
import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { createRefreshableAuth } from '@/app/lib/rag/auth';
import { google } from 'googleapis';
import {
  loadSessionManifest,
  updateSessionManifest,
  saveSessionManifest,
  reconcileManifestWithDrive,
  deleteSessionManifest,
} from '@/app/lib/reportCreation/sessionManifest';
import { getJob } from '@/app/lib/rag/jobRegistry';
import type { UpdateSessionPayload } from '@/app/lib/reportCreation/sessionTypes';

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

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
): Promise<Response> {
  const session = await getApiSession(request);
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { sessionId } = await params;
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('projectId');
  const reconcile = searchParams.get('reconcile') === 'true';

  if (!projectId) {
    return NextResponse.json({ error: 'projectId query parameter is required' }, { status: 400 });
  }

  try {
    const auth = createRefreshableAuth(session.accessToken, session.refreshToken);

    const folderId = await getReportCreationCorpusFolderId(auth, projectId);
    if (!folderId) {
      return NextResponse.json({ error: 'report_creation_corpus folder not found' }, { status: 404 });
    }

    let manifest = await loadSessionManifest(auth, folderId, sessionId);
    if (!manifest) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    console.log(`[GET ${sessionId}] loaded currentStage="${manifest.currentStage}" reconcile=${reconcile}`);

    if (reconcile) {
      manifest = await reconcileManifestWithDrive(
        auth,
        manifest,
        async (jobId) => {
          const job = await getJob(jobId);
          if (!job) return null;
          return { status: job.status, corpusId: job.corpusId };
        }
      );
      await saveSessionManifest(auth, manifest);
    }

    return NextResponse.json({ session: manifest });
  } catch (error) {
    console.error('[report-creation/sessions/:id] GET failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load session' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
): Promise<Response> {
  const session = await getApiSession(request);
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { sessionId } = await params;
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('projectId');

  if (!projectId) {
    return NextResponse.json({ error: 'projectId query parameter is required' }, { status: 400 });
  }

  try {
    const auth = createRefreshableAuth(session.accessToken, session.refreshToken);

    const folderId = await getReportCreationCorpusFolderId(auth, projectId);
    if (!folderId) {
      return NextResponse.json({ error: 'report_creation_corpus folder not found' }, { status: 404 });
    }

    const result = await deleteSessionManifest(auth, folderId, sessionId);
    if (result.alreadyGone) {
      console.log(`[DELETE ${sessionId}] session manifest already gone`);
    } else {
      console.log(`[DELETE ${sessionId}] session manifest deleted`);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('[report-creation/sessions/:id] DELETE failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete session' },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
): Promise<Response> {
  const session = await getApiSession(request);
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { sessionId } = await params;
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('projectId');

  if (!projectId) {
    return NextResponse.json({ error: 'projectId query parameter is required' }, { status: 400 });
  }

  let body: UpdateSessionPayload;
  try {
    body = (await request.json()) as UpdateSessionPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const auth = createRefreshableAuth(session.accessToken, session.refreshToken);

    const folderId = await getReportCreationCorpusFolderId(auth, projectId);
    if (!folderId) {
      return NextResponse.json({ error: 'report_creation_corpus folder not found' }, { status: 404 });
    }

    if (body.currentStage) {
      console.log(`[PATCH ${sessionId}] currentStage → "${body.currentStage}"`);
    }

    const updated = await updateSessionManifest(auth, folderId, sessionId, body);
    if (!updated) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    return NextResponse.json({ session: updated });
  } catch (error) {
    console.error('[report-creation/sessions/:id] PATCH failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update session' },
      { status: 500 }
    );
  }
}
