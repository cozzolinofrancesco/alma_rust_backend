import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { google } from 'googleapis';
import { listSessionMetas } from '@/app/claim-validation/lib/jobStore';
import type { RunMeta } from '@/app/claim-validation/lib/runPersistence';

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

export async function GET(request: Request) {
  const session = await getApiSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('projectId');

  const live = listSessionMetas().filter((l) => l.owner_email === session.user?.email);
  const liveIds = new Set(live.map((l) => l.session_id));

  if (!projectId) {
    return NextResponse.json({ jobs: live });
  }

  const driveRuns: RunMeta[] = [];
  try {
    if (!session.accessToken) throw new Error('No access token');

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
      const listRes = await drive.files.list({
        q: `'${folderId}' in parents and mimeType='application/json' and trashed=false`,
        fields: 'files(id, name)',
        orderBy: 'createdTime desc',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      for (const file of listRes.data.files ?? []) {
        try {
          const raw = await downloadDriveFile(drive, file.id!);
          const record = JSON.parse(raw) as RunMeta;
          driveRuns.push({
            session_id:        record.session_id,
            saved_at:          record.saved_at,
            document_filename: record.document_filename,
            corpus_id:         record.corpus_id,
            status:            record.status,
            total:             record.total,
            completed_count:   record.completed_count,
            failed_count:      record.failed_count,
            corpus_scope_sha:  record.corpus_scope_sha,
            chain_filename:    record.chain_filename,
            final_chain_hash:  record.final_chain_hash,
          });
        } catch {
        }
      }
    }
  } catch (err) {
    console.warn('[claim-validation/jobs] Drive fetch failed:', err);
  }

  const filteredDrive = driveRuns.filter((r) => !liveIds.has(r.session_id));
  const jobs = [...live, ...filteredDrive];

  return NextResponse.json({ jobs });
}
