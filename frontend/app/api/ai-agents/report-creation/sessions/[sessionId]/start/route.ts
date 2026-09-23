
import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { createRefreshableAuth } from '@/app/lib/rag/auth';
import { google } from 'googleapis';
import {
  loadSessionManifest,
  saveSessionManifest,
} from '@/app/lib/reportCreation/sessionManifest';
import type { ReportCreationStage } from '@/app/lib/reportCreation/sessionTypes';

export const runtime = 'nodejs';

type StartableStage =
  | 'clinical_corpus'
  | 'clinical_summary'
  | 'biomaterial_corpus'
  | 'biomaterial_summary';

interface StartStagePayload {
  stage: StartableStage;
  jobId: string;
  corpusId?: string;
}

const STAGE_MAP: Record<StartableStage, ReportCreationStage> = {
  clinical_corpus: 'clinical_corpus_running',
  clinical_summary: 'clinical_summary_running',
  biomaterial_corpus: 'biomaterial_corpus_running',
  biomaterial_summary: 'biomaterial_summary_running',
};

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

export async function POST(
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

  let body: StartStagePayload;
  try {
    body = (await request.json()) as StartStagePayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { stage, jobId, corpusId } = body;
  if (!stage || !jobId) {
    return NextResponse.json({ error: 'stage and jobId are required' }, { status: 400 });
  }

  const nextStage = STAGE_MAP[stage];
  if (!nextStage) {
    return NextResponse.json(
      { error: `Unknown stage "${stage}". Must be one of: ${Object.keys(STAGE_MAP).join(', ')}` },
      { status: 400 }
    );
  }

  try {
    const auth = createRefreshableAuth(session.accessToken, session.refreshToken);

    const folderId = await getReportCreationCorpusFolderId(auth, projectId);
    if (!folderId) {
      return NextResponse.json({ error: 'report_creation_corpus folder not found' }, { status: 404 });
    }

    const manifest = await loadSessionManifest(auth, folderId, sessionId);
    if (!manifest) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    switch (stage) {
      case 'clinical_corpus':
        manifest.clinical.corpusJobId = jobId;
        if (corpusId) manifest.clinical.corpusId = corpusId;
        break;
      case 'clinical_summary':
        manifest.clinical.summaryJobId = jobId;
        break;
      case 'biomaterial_corpus':
        manifest.biomaterial.corpusJobId = jobId;
        if (corpusId) manifest.biomaterial.corpusId = corpusId;
        break;
      case 'biomaterial_summary':
        manifest.biomaterial.summaryJobId = jobId;
        break;
    }

    manifest.lastCompletedStage = manifest.currentStage;
    manifest.currentStage = nextStage;
    manifest.updatedAt = new Date().toISOString();

    await saveSessionManifest(auth, manifest);

    return NextResponse.json({ session: manifest });
  } catch (error) {
    console.error('[report-creation/sessions/:id/start] POST failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to start stage' },
      { status: 500 }
    );
  }
}
