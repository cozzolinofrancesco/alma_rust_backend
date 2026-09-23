import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { z } from 'zod';
import {
  createFileSearchStoreFromLocalFiles,
  addLocalFilesToExistingStore,
  LocalRagFile,
} from '@/app/lib/rag/fileSearchStore';
import { createJob, updateJob, addJobLog, getJob } from '@/app/lib/rag/jobRegistry';
import { createRefreshableAuth } from '@/app/lib/rag/auth';
import { getCorpusById } from '@/app/lib/rag/registry';
import { upsertProjectCorpusLink } from '@/app/lib/agentnodesApi/projectCorpusLinksStore';
import { google } from 'googleapis';

const SUPPORTED_APPLICATION_MIME_TYPES = new Set<string>([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.text',
  'application/json',
  'application/xml',
  'application/sql',
  'application/typescript',
  'application/ecmascript',
  'application/zip',
]);

function isSupportedMimeType(mimeType: string): boolean {
  return mimeType.startsWith('text/') || SUPPORTED_APPLICATION_MIME_TYPES.has(mimeType);
}

const metadataSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('new'),
    displayName: z.string().trim().min(1, 'displayName is required'),
    allowPartialSuccess: z.boolean(),
    projectId: z.string().optional(),
  }),
  z.object({
    mode: z.literal('existing'),
    existingCorpusId: z.string().trim().min(1, 'existingCorpusId is required'),
    allowPartialSuccess: z.boolean(),
    projectId: z.string().optional(),
  }),
]);

// Mirror a newly created local corpus into the chosen project's shared corpusLinks.
async function linkCreatedCorpusToProject(
  jobId: string,
  projectId: string,
  callerEmail: string,
  auth: ReturnType<typeof createRefreshableAuth>,
): Promise<void> {
  try {
    const job = await getJob(jobId);
    const registryId = job?.corpusId;
    if (!registryId) return;
    const entry = await getCorpusById(registryId, auth);
    if (!entry) return;
    const drive = google.drive({ version: 'v3', auth });
    await upsertProjectCorpusLink(drive, projectId, {
      corpusId: entry.id,
      storeName: entry.corpusId,
      displayName: entry.displayName,
      ownerEmail: callerEmail,
      addedBy: callerEmail,
    });
  } catch (error) {
    console.error(`[Job ${jobId}] Could not link local corpus to project ${projectId}:`, error);
  }
}

export async function POST(request: Request) {
  const session = await getApiSession(request);

  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const formData = await request.formData();

    const parsed = metadataSchema.safeParse({
      mode: formData.get('mode') ?? 'new',
      displayName: formData.get('displayName') ?? undefined,
      existingCorpusId: formData.get('existingCorpusId') ?? undefined,
      allowPartialSuccess: formData.get('allowPartialSuccess') === 'true',
      projectId: formData.get('projectId') ?? undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const uploads = formData.getAll('file').filter((entry): entry is File => entry instanceof File);
    if (uploads.length === 0) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    }

    const localFiles: LocalRagFile[] = [];
    for (let i = 0; i < uploads.length; i++) {
      const upload = uploads[i];
      const mimeType = upload.type || 'application/octet-stream';
      if (!isSupportedMimeType(mimeType)) {
        return NextResponse.json(
          { error: `Unsupported file type for "${upload.name}": ${mimeType}` },
          { status: 400 }
        );
      }
      const buffer = Buffer.from(await upload.arrayBuffer());
      localFiles.push({
        id: `local-file-${Date.now()}-${i}-${Math.random().toString(36).substring(2, 8)}`,
        name: upload.name,
        mimeType,
        size: buffer.length,
        buffer,
      });
    }

    const auth = createRefreshableAuth(session.accessToken, session.refreshToken);

    const jobId = await createJob({
      ownerEmail: session.user?.email ?? undefined,
      displayName:
        parsed.data.mode === 'existing'
          ? `Add to ${parsed.data.existingCorpusId}`
          : parsed.data.displayName,
      folderId: parsed.data.mode === 'existing' ? parsed.data.existingCorpusId : 'local-upload',
      totalFiles: localFiles.length,
      selectedFiles: localFiles.map((f) => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        size: f.size,
      })),
      allowPartialSuccess: parsed.data.allowPartialSuccess,
    });

    const callerEmail = session.user?.email ?? '';
    const runner =
      parsed.data.mode === 'existing'
        ? createExistingRunner(jobId, parsed.data.existingCorpusId, localFiles, parsed.data.allowPartialSuccess, auth)
        : createNewRunner(jobId, parsed.data.displayName, localFiles, parsed.data.allowPartialSuccess, auth, parsed.data.projectId, callerEmail);

    void runner;

    return NextResponse.json({
      jobId,
      status: 'pending',
      message:
        parsed.data.mode === 'existing'
          ? 'Adding files to existing corpus in background'
          : 'Corpus creation started in background',
    });
  } catch (error) {
    console.error('Failed to initiate local corpus creation:', error);
    return NextResponse.json(
      { error: 'Failed to initiate local corpus creation' },
      { status: 500 }
    );
  }
}

function createNewRunner(
  jobId: string,
  displayName: string,
  files: LocalRagFile[],
  allowPartialSuccess: boolean,
  auth: ReturnType<typeof createRefreshableAuth>,
  projectId?: string,
  callerEmail?: string
): Promise<void> {
  return (async () => {
    try {
      await createFileSearchStoreFromLocalFiles(displayName, files, auth, jobId, { allowPartialSuccess });
      if (projectId) {
        await linkCreatedCorpusToProject(jobId, projectId, callerEmail ?? '', auth);
      }
    } catch (error) {
      await handleRunnerError(jobId, error);
    }
  })();
}

function createExistingRunner(
  jobId: string,
  existingCorpusId: string,
  files: LocalRagFile[],
  allowPartialSuccess: boolean,
  auth: ReturnType<typeof createRefreshableAuth>
): Promise<void> {
  return (async () => {
    try {
      await addLocalFilesToExistingStore(existingCorpusId, files, auth, jobId, { allowPartialSuccess });
    } catch (error) {
      await handleRunnerError(jobId, error);
    }
  })();
}

async function handleRunnerError(jobId: string, error: unknown): Promise<void> {
  console.error(`[Job ${jobId}] Failed:`, error);
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  await addJobLog(jobId, { level: 'error', message: `Job failed: ${errorMessage}` });
  await updateJob(jobId, {
    status: 'failed',
    error: errorMessage,
    errorDetails: error,
    currentOperation: undefined,
    currentFile: undefined,
  });
}
