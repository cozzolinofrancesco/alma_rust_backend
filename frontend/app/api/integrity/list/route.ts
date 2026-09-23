import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { google } from 'googleapis';

const INTEGRITY_SUBFOLDER_NAME = 'Integrity-Keys';

export interface ChainMetadata {
  filename: string;
  saved_at: string;
  saved_by: string;
  label: string | null;
  operation_type: string;
  project_id: string | null;
  step_count: number;
  final_chain_hash: string;
  drive_file_id: string | null;
}

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
      return NextResponse.json({ chains: [] });
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

    const folderId = await findSubfolder(drive, projectId, INTEGRITY_SUBFOLDER_NAME);
    if (!folderId) {
      return NextResponse.json({ chains: [] });
    }

    const listRes = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/json' and trashed=false`,
      fields: 'files(id, name)',
      orderBy: 'createdTime desc',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const chains: ChainMetadata[] = [];

    for (const file of listRes.data.files ?? []) {
      try {
        const raw = await downloadDriveFile(drive, file.id!);
        const parsed = JSON.parse(raw) as Partial<ChainMetadata>;
        chains.push({
          filename:         file.name ?? '',
          saved_at:         parsed.saved_at ?? '',
          saved_by:         parsed.saved_by ?? '',
          label:            parsed.label ?? null,
          operation_type:   parsed.operation_type ?? 'unknown',
          project_id:       projectId,
          step_count:       parsed.step_count ?? 0,
          final_chain_hash: parsed.final_chain_hash ?? '',
          drive_file_id:    file.id ?? null,
        });
      } catch {
      }
    }

    return NextResponse.json({ chains });
  } catch (error) {
    console.error('[integrity/list] Error:', error);
    return NextResponse.json({ error: 'Failed to list integrity chains' }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await getApiSession(request);
    if (!session?.accessToken) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const body = (await request.json()) as { filename?: string; driveFileId?: string };

    if (body.driveFileId) {
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
      const raw = await downloadDriveFile(drive, body.driveFileId);
      const parsed = JSON.parse(raw) as { chain: unknown[] };
      return NextResponse.json({ chain: parsed.chain ?? [] });
    }

    if (body.filename) {
      if (request.headers.has('x-api-key')) return NextResponse.json({ error: 'Use an authorized driveFileId for script access.' }, { status: 400 });
      const { default: fs } = await import('fs/promises');
      const { default: path } = await import('path');
      const filename = body.filename;
      if (!filename.endsWith('.json') || filename.includes('/') || filename.includes('..')) {
        return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
      }
      const CHAINS_DIR = path.join(process.cwd(), 'integrity_chains');
      const raw = await fs.readFile(path.join(CHAINS_DIR, filename), 'utf-8');
      const parsed = JSON.parse(raw) as { chain: unknown[] };
      return NextResponse.json({ chain: parsed.chain });
    }

    return NextResponse.json({ error: 'driveFileId or filename required' }, { status: 400 });
  } catch (error) {
    console.error('[integrity/list] load error:', error);
    return NextResponse.json({ error: 'Failed to load chain' }, { status: 500 });
  }
}
