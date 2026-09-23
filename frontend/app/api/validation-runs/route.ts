import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { google } from 'googleapis';
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

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await getApiSession(request);
    if (!session?.accessToken) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');

    if (!projectId) {
      return NextResponse.json({ runs: [] });
    }

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
    if (!folderId) {
      return NextResponse.json({ runs: [] });
    }

    const listRes = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/json' and trashed=false`,
      fields: 'files(id, name)',
      orderBy: 'createdTime desc',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const runs: RunMeta[] = [];

    for (const file of listRes.data.files ?? []) {
      try {
        const raw = await downloadDriveFile(drive, file.id!);
        const record = JSON.parse(raw) as RunMeta & { drive_file_id?: string };
        runs.push({
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

    return NextResponse.json({ runs });
  } catch (error) {
    console.error('[validation-runs] Failed to list runs:', error);
    return NextResponse.json({ error: 'Failed to list validation runs' }, { status: 500 });
  }
}
