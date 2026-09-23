import fs from 'fs/promises';
import path from 'path';
import { google } from 'googleapis';
import type { Claim, ValidationResult } from '../types';
import { findOrCreateSubfolder } from '@/app/lib/drive/findOrCreateSubfolder';

const RUNS_DIR = path.join(process.cwd(), 'validation_runs');

async function ensureRunsDir(): Promise<void> {
  try {
    await fs.access(RUNS_DIR);
  } catch {
    await fs.mkdir(RUNS_DIR, { recursive: true });
  }
}

export interface RunPayload {
  document_filename?: string;
  corpus_id: string;
  status: string;
  total: number;
  completed_count: number;
  failed_count: number;
  claims: Claim[];
  results: ValidationResult[];
  corpus_scope_sha?: string;
  chain_filename?: string;
  final_chain_hash?: string;
  drive?: {
    projectId: string;
    accessToken: string;
    refreshToken?: string;
  };
}

export interface RunRecord extends Omit<RunPayload, 'drive'> {
  session_id: string;
  saved_at: string;
}

export interface RunMeta {
  session_id: string;
  saved_at: string;
  document_filename?: string;
  corpus_id: string;
  status: string;
  total: number;
  completed_count: number;
  failed_count: number;
  corpus_scope_sha?: string;
  chain_filename?: string;
  final_chain_hash?: string;
}

export async function saveRun(sessionId: string, payload: RunPayload): Promise<void> {
  const { drive: driveOpts, ...rest } = payload;

  const record: RunRecord = {
    session_id: sessionId,
    saved_at: new Date().toISOString(),
    ...rest,
  };

  if (driveOpts?.projectId) {
    try {
      const { projectId, accessToken, refreshToken } = driveOpts;
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
      const folderId = await findOrCreateSubfolder(drive, projectId, 'QC-reports');
      const filename = `run_${sessionId}.json`;
      const fileRes = await drive.files.create({
        requestBody: {
          name: filename,
          parents: [folderId],
          mimeType: 'application/json',
        },
        media: {
          mimeType: 'application/json',
          body: JSON.stringify(record, null, 2),
        },
        fields: 'id',
        supportsAllDrives: true,
      });
      console.log(`[runPersistence] Saved run to Drive: ${fileRes.data.id}`);
    } catch (driveErr) {
      console.warn('[runPersistence] Drive upload failed:', driveErr);
    }
  } else {
    console.warn(`[runPersistence] No Drive credentials for session ${sessionId} — run not persisted.`);
  }
}

export async function listRuns(): Promise<RunMeta[]> {
  await ensureRunsDir();
  let files: string[];
  try {
    files = await fs.readdir(RUNS_DIR);
  } catch {
    return [];
  }

  const metas: RunMeta[] = [];
  for (const file of files) {
    if (!file.startsWith('run_') || !file.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(RUNS_DIR, file), 'utf-8');
      const record = JSON.parse(raw) as RunRecord;
      metas.push({
        session_id:       record.session_id,
        saved_at:         record.saved_at,
        document_filename: record.document_filename,
        corpus_id:        record.corpus_id,
        status:           record.status,
        total:            record.total,
        completed_count:  record.completed_count,
        failed_count:     record.failed_count,
        corpus_scope_sha: record.corpus_scope_sha,
        chain_filename:   record.chain_filename,
        final_chain_hash: record.final_chain_hash,
      });
    } catch {
    }
  }

  return metas.sort((a, b) => new Date(b.saved_at).getTime() - new Date(a.saved_at).getTime());
}

export async function loadRun(sessionId: string): Promise<RunRecord | null> {
  await ensureRunsDir();
  const filepath = path.join(RUNS_DIR, `run_${sessionId}.json`);
  try {
    const raw = await fs.readFile(filepath, 'utf-8');
    return JSON.parse(raw) as RunRecord;
  } catch {
    return null;
  }
}
