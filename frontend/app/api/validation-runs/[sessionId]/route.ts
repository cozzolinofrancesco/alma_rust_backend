import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { google } from 'googleapis';
import { loadRun } from '@/app/claim-validation/lib/runPersistence';
import type { RunRecord } from '@/app/claim-validation/lib/runPersistence';

const QC_SUBFOLDER_NAME = 'QC-reports';

async function findSubfolder(
  drive: ReturnType<typeof google.drive>,
  parentId: string,
  name: string
): Promise<string | null> {
  const res = await drive.files.list({
    q: `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files?.[0]?.id ?? null;
}

async function downloadDriveFile(
  drive: ReturnType<typeof google.drive>,
  fileId: string
): Promise<string> {
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data as ArrayBuffer).toString('utf-8');
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
): Promise<NextResponse> {
  try {
    const session = await getApiSession(request);
    if (!session?.accessToken) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { sessionId } = await params;
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(sessionId)) {
      return NextResponse.json({ error: 'Invalid sessionId' }, { status: 400 });
    }
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');

    if (projectId) {
      try {
        const oauth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID!,
          process.env.GOOGLE_CLIENT_SECRET!,
          process.env.GOOGLE_REDIRECT_URI!
        );
        oauth2Client.setCredentials({
          access_token: session.accessToken,
          refresh_token: session.refreshToken ?? undefined,
        });
        const drive = google.drive({ version: 'v3', auth: oauth2Client });

        const folderId = await findSubfolder(drive, projectId, QC_SUBFOLDER_NAME);
        if (folderId) {
          const filename = `run_${sessionId}.json`;
          const searchRes = await drive.files.list({
            q: `name='${filename}' and '${folderId}' in parents and trashed=false`,
            fields: 'files(id)',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          });
          const fileId = searchRes.data.files?.[0]?.id;
          if (fileId) {
            const raw = await downloadDriveFile(drive, fileId);
            const run = JSON.parse(raw) as RunRecord;
            return NextResponse.json(run);
          }
        }
      } catch (driveErr) {
        console.warn('[validation-runs/[sessionId]] Drive fetch failed, falling back to disk:', driveErr);
      }
    }

    if (request.headers.has('x-api-key')) return NextResponse.json({ error: 'Run not found in an authorized project' }, { status: 404 });
    const run = await loadRun(sessionId);
    if (!run) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }
    return NextResponse.json(run);
  } catch (error) {
    console.error('[validation-runs/[sessionId]] Failed to load run:', error);
    return NextResponse.json({ error: 'Failed to load validation run' }, { status: 500 });
  }
}
