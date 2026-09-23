import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { google } from 'googleapis';
import fs from 'fs/promises';
import path from 'path';
import type { IntegrityRecord } from '../../../lib/integrity';
import { findOrCreateSubfolder } from '../../../lib/drive/findOrCreateSubfolder';

const CHAINS_DIR = path.join(process.cwd(), 'integrity_chains');
const INTEGRITY_SUBFOLDER_NAME = 'Integrity-Keys';
const FALLBACK_FOLDER_NAME = 'ALMA Integrity Chains';

async function ensureChainsDir(): Promise<void> {
  try {
    await fs.access(CHAINS_DIR);
  } catch {
    await fs.mkdir(CHAINS_DIR, { recursive: true });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await getApiSession(request);
    if (!session?.accessToken) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const savedBy =
      session.user?.email ||
      session.user?.name ||
      'unknown';

    const body = (await request.json()) as {
      chain: IntegrityRecord[];
      label?: string;
      operationType?: string;
      projectId?: string;
    };

    if (!Array.isArray(body.chain) || body.chain.length === 0) {
      return NextResponse.json({ error: 'chain must be a non-empty array' }, { status: 400 });
    }

    await ensureChainsDir();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `chain_${timestamp}.json`;
    const filepath = path.join(CHAINS_DIR, filename);

    const lastRecord = body.chain[body.chain.length - 1];

    const payload: Record<string, unknown> = {
      filename,
      saved_at: new Date().toISOString(),
      saved_by: savedBy,
      label: body.label ?? null,
      operation_type: body.operationType ?? 'unknown',
      project_id: body.projectId ?? null,
      step_count: body.chain.length,
      final_chain_hash: lastRecord.chain_hash,
      chain: body.chain,
    };

    let driveFileId: string | null = null;
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

      let targetFolderId: string;

      if (body.projectId) {
        targetFolderId = await findOrCreateSubfolder(drive, body.projectId, INTEGRITY_SUBFOLDER_NAME);
      } else {
        const rootList = await drive.files.list({
          q: `name='${FALLBACK_FOLDER_NAME}' and 'root' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          fields: 'files(id)',
          supportsAllDrives: true,
        });
        if (rootList.data.files?.length && rootList.data.files[0].id) {
          targetFolderId = rootList.data.files[0].id;
        } else {
          const createRes = await drive.files.create({
            requestBody: {
              name: FALLBACK_FOLDER_NAME,
              mimeType: 'application/vnd.google-apps.folder',
              parents: ['root'],
            },
            fields: 'id',
            supportsAllDrives: true,
          });
          targetFolderId = createRes.data.id!;
        }
      }

      const jsonStr = JSON.stringify({ ...payload, drive_file_id: null }, null, 2);
      const fileRes = await drive.files.create({
        requestBody: {
          name: filename,
          parents: [targetFolderId],
          mimeType: 'application/json',
        },
        media: {
          mimeType: 'application/json',
          body: jsonStr,
        },
        fields: 'id',
        supportsAllDrives: true,
      });
      driveFileId = fileRes.data.id ?? null;
    } catch (driveErr) {
      if (request.headers.has('x-api-key')) return NextResponse.json({ error: 'Integrity chain could not be saved to authorized Drive storage.', code: 'DRIVE_SAVE_FAILED' }, { status: 502 });
      console.warn('[integrity/save] Drive upload failed, saving locally only:', driveErr);
    }

    if (driveFileId) {
      payload.drive_file_id = driveFileId;
    }
    const payloadStr = JSON.stringify(payload, null, 2);
    await fs.writeFile(filepath, payloadStr, 'utf-8');

    return NextResponse.json({
      success: true,
      filename,
      drive_file_id: driveFileId,
      step_count: body.chain.length,
      final_chain_hash: lastRecord.chain_hash,
    });
  } catch (error) {
    console.error('[integrity/save] Error:', error);
    return NextResponse.json({ error: 'Failed to save integrity chain' }, { status: 500 });
  }
}
