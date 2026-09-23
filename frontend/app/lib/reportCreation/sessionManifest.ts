
import { google } from 'googleapis';
import type { OAuth2Client } from 'googleapis-common';
import { nanoid } from 'nanoid';
import type {
  ReportCreationSessionManifest,
  UpdateSessionPayload,
  SessionListEntry,
  ClinicalPipelineState,
  BiomaterialPipelineState,
  MatchingState,
} from './sessionTypes';

const SESSION_FILE_PREFIX = 'report-session-';
const SESSION_MIME = 'application/json';

function now(): string {
  return new Date().toISOString();
}

function makeSessionId(): string {
  return `rc-${Date.now()}-${nanoid(8)}`;
}

function makeFileName(sessionId: string): string {
  return `${SESSION_FILE_PREFIX}${sessionId}.json`;
}

async function findSessionFile(
  drive: ReturnType<typeof google.drive>,
  folderId: string,
  sessionId: string
): Promise<string | null> {
  const fileName = makeFileName(sessionId);
  const res = await drive.files.list({
    q: `name='${fileName}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files?.[0]?.id ?? null;
}

async function readFileContent<T>(
  drive: ReturnType<typeof google.drive>,
  fileId: string
): Promise<T> {
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'text' }
  );
  return JSON.parse(res.data as string) as T;
}

async function writeFileContent(
  drive: ReturnType<typeof google.drive>,
  folderId: string,
  fileName: string,
  payload: unknown,
  existingFileId?: string | null
): Promise<string> {
  const body = JSON.stringify(payload, null, 2);

  if (existingFileId) {
    await drive.files.update({
      fileId: existingFileId,
      media: { mimeType: SESSION_MIME, body },
      supportsAllDrives: true,
    });
    return existingFileId;
  }

  const res = await drive.files.create({
    requestBody: { name: fileName, mimeType: SESSION_MIME, parents: [folderId] },
    media: { mimeType: SESSION_MIME, body },
    fields: 'id',
    supportsAllDrives: true,
  });
  return res.data.id!;
}

export async function createSessionManifest(
  auth: OAuth2Client,
  params: {
    projectId: string;
    userEmail: string;
    sessionName: string;
    manifestFolderId: string;
  }
): Promise<ReportCreationSessionManifest> {
  const drive = google.drive({ version: 'v3', auth });

  const sessionId = makeSessionId();
  const timestamp = now();

  const emptyPipeline = (): ClinicalPipelineState => ({
    selectedFiles: [],
    corpusMode: 'new',
    corpusName: '',
  });

  const emptyBiomaterial = (): BiomaterialPipelineState => ({
    selectedFiles: [],
    corpusMode: 'new',
    corpusName: '',
  });

  const manifest: ReportCreationSessionManifest = {
    sessionId,
    projectId: params.projectId,
    userEmail: params.userEmail,
    sessionName: params.sessionName,
    status: 'active',
    currentStage: 'clinical_corpus_select',
    manifestFolderId: params.manifestFolderId,
    clinical: emptyPipeline(),
    biomaterial: emptyBiomaterial(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const fileName = makeFileName(sessionId);
  const fileId = await writeFileContent(drive, params.manifestFolderId, fileName, manifest);
  manifest.manifestFileId = fileId;

  await writeFileContent(drive, params.manifestFolderId, fileName, manifest, fileId);

  return manifest;
}

export async function loadSessionManifest(
  auth: OAuth2Client,
  folderId: string,
  sessionId: string
): Promise<ReportCreationSessionManifest | null> {
  const drive = google.drive({ version: 'v3', auth });
  const fileId = await findSessionFile(drive, folderId, sessionId);
  if (!fileId) return null;
  try {
    const manifest = await readFileContent<ReportCreationSessionManifest>(drive, fileId);
    return manifest;
  } catch {
    return null;
  }
}

export async function saveSessionManifest(
  auth: OAuth2Client,
  manifest: ReportCreationSessionManifest
): Promise<void> {
  if (!manifest.manifestFileId || !manifest.manifestFolderId) {
    throw new Error('Cannot save manifest without manifestFileId and manifestFolderId');
  }
  const drive = google.drive({ version: 'v3', auth });
  const fileName = makeFileName(manifest.sessionId);
  await writeFileContent(
    drive,
    manifest.manifestFolderId,
    fileName,
    { ...manifest, updatedAt: now() },
    manifest.manifestFileId
  );
}

export async function updateSessionManifest(
  auth: OAuth2Client,
  folderId: string,
  sessionId: string,
  update: UpdateSessionPayload
): Promise<ReportCreationSessionManifest | null> {
  const manifest = await loadSessionManifest(auth, folderId, sessionId);
  if (!manifest) return null;

  if (update.currentStage !== undefined) manifest.currentStage = update.currentStage;
  if (update.lastCompletedStage !== undefined) manifest.lastCompletedStage = update.lastCompletedStage;
  if (update.status !== undefined) manifest.status = update.status;
  if (update.resumeHints !== undefined) manifest.resumeHints = update.resumeHints;
  if (update.biomaterialSkipped !== undefined) manifest.biomaterialSkipped = update.biomaterialSkipped;

  if (update.clinical) {
    manifest.clinical = { ...manifest.clinical, ...update.clinical };
  }
  if (update.biomaterial) {
    manifest.biomaterial = { ...manifest.biomaterial, ...update.biomaterial };
  }
  if (update.matching) {
    manifest.matching = {
      ...(manifest.matching ?? {
        agentName: '',
        studyOverrides: [],
        sec3Overrides: [],
        sec1Overrides: [],
        metaFileOverrides: [],
      } as MatchingState),
      ...update.matching,
    };
  }

  manifest.updatedAt = now();
  await saveSessionManifest(auth, manifest);
  return manifest;
}

export async function deleteSessionManifest(
  auth: OAuth2Client,
  folderId: string,
  sessionId: string
): Promise<{ deleted: true; alreadyGone?: true }> {
  const drive = google.drive({ version: 'v3', auth });
  const fileId = await findSessionFile(drive, folderId, sessionId);
  if (!fileId) {
    return { deleted: true, alreadyGone: true };
  }
  await drive.files.delete({ fileId, supportsAllDrives: true });
  return { deleted: true };
}

export async function listSessionManifests(
  auth: OAuth2Client,
  folderId: string
): Promise<SessionListEntry[]> {
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.list({
    q: `name contains '${SESSION_FILE_PREFIX}' and '${folderId}' in parents and mimeType='${SESSION_MIME}' and trashed=false`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    pageSize: 20,
  });

  const files = res.data.files ?? [];
  const entries: SessionListEntry[] = [];

  await Promise.all(
    files.map(async (f) => {
      if (!f.id) return;
      try {
        const m = await readFileContent<ReportCreationSessionManifest>(drive, f.id);
        entries.push({
          sessionId: m.sessionId,
          sessionName: m.sessionName,
          status: m.status,
          currentStage: m.currentStage,
          updatedAt: m.updatedAt,
          createdAt: m.createdAt,
        });
      } catch {
      }
    })
  );

  return entries.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export async function reconcileManifestWithDrive(
  auth: OAuth2Client,
  manifest: ReportCreationSessionManifest,
  jobStatusFetcher: (jobId: string) => Promise<{ status: string; corpusId?: string } | null>
): Promise<ReportCreationSessionManifest> {
  const drive = google.drive({ version: 'v3', auth });

  if (
    manifest.currentStage === 'clinical_corpus_running' &&
    manifest.clinical.corpusJobId
  ) {
    const job = await jobStatusFetcher(manifest.clinical.corpusJobId);
    if (job && (job.status === 'completed' || job.status === 'completed_with_errors')) {
      const corpusId = job.corpusId ?? manifest.clinical.corpusId;
      manifest.clinical.corpusId = corpusId;
      manifest.currentStage = 'clinical_summary_running';
      manifest.lastCompletedStage = 'clinical_corpus_running';
      manifest.updatedAt = now();
    } else if (!job) {
      if (manifest.clinical.summaryJsonFile?.id) {
        manifest.currentStage = 'biomaterial_corpus_select';
        manifest.lastCompletedStage = 'clinical_summary_running';
        manifest.updatedAt = now();
      } else if (manifest.clinical.corpusId) {
        manifest.currentStage = 'clinical_summary_running';
        manifest.updatedAt = now();
      } else {
        manifest.currentStage = 'needs_attention';
        manifest.resumeHints = {
          needsUserAction: 'clinical_corpus_lost',
          errorMessage: 'Clinical corpus job was lost; please restart corpus creation.',
        };
        manifest.updatedAt = now();
      }
    }
  }

  if (
    manifest.currentStage === 'clinical_summary_running' &&
    manifest.clinical.summaryJobId
  ) {
    const job = await jobStatusFetcher(manifest.clinical.summaryJobId);
    if (job && (job.status === 'completed' || job.status === 'completed_with_errors')) {
      manifest.currentStage = 'biomaterial_corpus_select';
      manifest.lastCompletedStage = 'clinical_summary_running';
      manifest.updatedAt = now();
    } else if (!job) {
      if (manifest.clinical.summaryJsonFile?.id) {
        manifest.currentStage = 'biomaterial_corpus_select';
        manifest.lastCompletedStage = 'clinical_summary_running';
        manifest.updatedAt = now();
      } else {
        manifest.currentStage = 'needs_attention';
        manifest.resumeHints = {
          needsUserAction: 'clinical_summary_lost',
          errorMessage: 'Clinical summary job was lost; please load an existing summary or retry.',
        };
        manifest.updatedAt = now();
      }
    }
  }

  if (
    manifest.currentStage === 'biomaterial_corpus_running' &&
    manifest.biomaterial.corpusJobId
  ) {
    const job = await jobStatusFetcher(manifest.biomaterial.corpusJobId);
    if (job && (job.status === 'completed' || job.status === 'completed_with_errors')) {
      const corpusId = job.corpusId ?? manifest.biomaterial.corpusId;
      manifest.biomaterial.corpusId = corpusId;
      manifest.currentStage = 'biomaterial_summary_running';
      manifest.lastCompletedStage = 'biomaterial_corpus_running';
      manifest.updatedAt = now();
    } else if (!job) {
      if (manifest.biomaterial.corpusId) {
        manifest.currentStage = 'biomaterial_summary_running';
        manifest.updatedAt = now();
      } else {
        manifest.currentStage = 'needs_attention';
        manifest.resumeHints = {
          needsUserAction: 'biomaterial_corpus_lost',
          errorMessage: 'Biomaterial corpus job was lost; please restart corpus creation.',
        };
        manifest.updatedAt = now();
      }
    }
  }

  if (
    manifest.currentStage === 'biomaterial_summary_running' &&
    manifest.biomaterial.summaryJobId
  ) {
    const job = await jobStatusFetcher(manifest.biomaterial.summaryJobId);
    if (job && (job.status === 'completed' || job.status === 'completed_with_errors')) {
      manifest.currentStage = 'matching_ready';
      manifest.lastCompletedStage = 'biomaterial_summary_running';
      manifest.updatedAt = now();
    } else if (!job) {
      if (manifest.biomaterial.summaryJsonFile?.id) {
        manifest.currentStage = 'matching_ready';
        manifest.lastCompletedStage = 'biomaterial_summary_running';
        manifest.updatedAt = now();
      } else {
        manifest.currentStage = 'needs_attention';
        manifest.resumeHints = {
          needsUserAction: 'biomaterial_summary_lost',
          errorMessage: 'Biomaterial summary job was lost; please load an existing summary or retry.',
        };
        manifest.updatedAt = now();
      }
    }
  }

  void drive;
  return manifest;
}
