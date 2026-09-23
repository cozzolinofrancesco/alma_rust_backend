
import { google } from 'googleapis';
import type { IntegrityRecord } from '../integrity';
import { findOrCreateSubfolder } from '../drive/findOrCreateSubfolder';

export interface SaveChainOptions {
  label?: string;
  operationType?: string;
  savedBy?: string;
  drive?: {
    projectId: string;
    accessToken: string;
    refreshToken?: string;
  };
}

export interface SaveChainResult {
  filename: string;
  final_chain_hash: string;
  step_count: number;
  drive_file_id?: string;
}

export async function saveChainToDisk(
  chain: IntegrityRecord[],
  options: SaveChainOptions = {}
): Promise<SaveChainResult> {
  if (chain.length === 0) throw new Error('chain must be non-empty');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `chain_${timestamp}.json`;

  const lastRecord = chain[chain.length - 1];

  const payload: Record<string, unknown> = {
    filename,
    saved_at: new Date().toISOString(),
    saved_by: options.savedBy ?? 'system',
    label: options.label ?? null,
    operation_type: options.operationType ?? 'Claim Validation',
    step_count: chain.length,
    final_chain_hash: lastRecord.chain_hash,
    chain,
  };

  let driveFileId: string | undefined;
  if (options.drive?.projectId) {
    try {
      const { projectId, accessToken, refreshToken } = options.drive;
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID!,
        process.env.GOOGLE_CLIENT_SECRET!,
        process.env.GOOGLE_REDIRECT_URI!
      );
      oauth2Client.setCredentials({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      const drive = google.drive({ version: 'v3', auth: oauth2Client });
      const folderId = await findOrCreateSubfolder(drive, projectId, 'Integrity-Keys');
      const fileRes = await drive.files.create({
        requestBody: {
          name: filename,
          parents: [folderId],
          mimeType: 'application/json',
        },
        media: {
          mimeType: 'application/json',
          body: JSON.stringify(payload, null, 2),
        },
        fields: 'id',
        supportsAllDrives: true,
      });
      driveFileId = fileRes.data.id ?? undefined;
      console.log(`[chainPersistence] Saved chain to Drive: ${driveFileId}`);
    } catch (driveErr) {
      console.warn('[chainPersistence] Drive upload failed:', driveErr);
    }
  } else {
    console.warn('[chainPersistence] No Drive credentials — chain not persisted.');
  }

  return {
    filename,
    final_chain_hash: lastRecord.chain_hash,
    step_count: chain.length,
    drive_file_id: driveFileId,
  };
}
