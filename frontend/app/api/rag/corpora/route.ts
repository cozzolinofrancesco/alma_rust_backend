import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { z } from 'zod';
import { listFileSearchStores, listAllFileSearchStores, createFileSearchStoreFromDrive, addFilesToExistingStore } from '@/app/lib/rag/fileSearchStore';
import type { GeminiStoreSummary } from '@/app/lib/rag/fileSearchStore';
import { createJob, updateJob, addJobLog, getJob } from '@/app/lib/rag/jobRegistry';
import { createRefreshableAuth } from '@/app/lib/rag/auth';
import { getFilesMetadataByIds } from '@/app/lib/rag/drive';
import { getCorpusById } from '@/app/lib/rag/registry';
import { upsertProjectCorpusLink } from '@/app/lib/agentnodesApi/projectCorpusLinksStore';
import { isDevUser } from '@/app/lib/devAccess';
import { google } from 'googleapis';

// Pin the Node.js runtime: this route transitively depends on native modules
// (sharp/pdf2pic via fileSearchStore → pdfSplitter → pdfCompressor).
export const runtime = 'nodejs';

const MAX_CORPUS_NAME_LENGTH = 100;

// Lenient on purpose: several callers omit `mode` (defaults to 'new') and send
// loosely-shaped file objects. Validate the basics here; per-mode required
// fields are checked in the handler.
const fileSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional().default(''),
    mimeType: z.string().optional().default('application/octet-stream'),
    size: z.number().optional().default(0),
    pageRange: z.object({ startPage: z.number(), endPage: z.number() }).optional(),
  })
  .passthrough();

const corpusRequestSchema = z.object({
  mode: z.enum(['new', 'existing']).optional(),
  displayName: z.string().optional(),
  folderId: z.string().optional(),
  existingCorpusId: z.string().optional(),
  selectedFileIds: z.array(z.string().min(1)).min(1),
  files: z.array(fileSchema).optional().default([]),
  allowPartialSuccess: z.boolean().optional(),
  // Optional so non-UI callers keep working; the RAG Corpus Manager requires it for 'new'.
  projectId: z.string().optional(),
});

// After a new corpus finishes indexing, mirror it into the chosen project's shared
// corpusLinks file so collaborators resolve its name + store path. Best-effort; never
// throws into the job.
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
    console.error(`[Job ${jobId}] Could not link corpus to project ${projectId}:`, error);
  }
}

export async function GET(request: Request) {
  const session = await getApiSession(request);

  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const auth = createRefreshableAuth(session.accessToken, session.refreshToken);

    const corpora = await listFileSearchStores(auth);

    // Devs can attach and test ANY corpus in the shared Gemini namespace, not only the
    // ones in their own Drive registry — this mirrors the run-path bypass in
    // /api/rag/query (see devAccess). Merge every store in, skipping those already in
    // the registry so the caller's own corpora keep their richer file metadata. Store
    // names carry a "fileSearchStores/…" prefix and are used verbatim as the corpus id
    // (the query route resolves raw store names for devs); per-document selection for
    // these cross-user stores falls back to full-corpus search.
    if (isDevUser(session.user?.email)) {
      const known = new Set(corpora.map((c) => c.corpusId));
      let allStores: GeminiStoreSummary[] = [];
      try {
        allStores = await listAllFileSearchStores();
      } catch (error) {
        console.error('Failed to list all corpora for dev merge:', error);
      }
      const devOnly = allStores
        .filter((s) => !known.has(s.name))
        .map((s) => ({
          id: s.name,
          corpusId: s.name,
          displayName: s.displayName,
          files: [] as [],
        }));
      return NextResponse.json({ corpora: [...corpora, ...devOnly] });
    }

    return NextResponse.json({ corpora });
  } catch (error) {
    console.error('Failed to list corpora:', error);
    return NextResponse.json(
      { error: 'Failed to list corpora' },
      { status: 500 }
    );
  }
}

const processInBackground = async (
  jobId: string, 
  folderId: string, 
  displayName: string, 
  selectedFileIds: string[], 
  files: Array<{ id: string; name: string; mimeType: string; size: number; pageRange?: { startPage: number; endPage: number } }>, 
  allowPartialSuccess: boolean,
  auth: ReturnType<typeof createRefreshableAuth>,
  projectId?: string,
  callerEmail?: string
) => {
  try {
    console.log(`[Job ${jobId}] Starting background processing...`);
    await addJobLog(jobId, {
      level: 'info',
      message: `Background processor started for "${displayName}" with ${files.length} files`
    });
    await createFileSearchStoreFromDrive(folderId, displayName, selectedFileIds, files, auth, jobId, { allowPartialSuccess });
    console.log(`[Job ${jobId}] Completed successfully.`);
    if (projectId) {
      await linkCreatedCorpusToProject(jobId, projectId, callerEmail ?? '', auth);
    }
  } catch (error) {
    console.error(`[Job ${jobId}] Failed:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await addJobLog(jobId, {
      level: 'error',
      message: `Job failed: ${errorMessage}`
    });
    await updateJob(jobId, { 
      status: 'failed', 
      error: errorMessage,
      errorDetails: error,
      currentOperation: undefined,
      currentFile: undefined
    });
  }
};

const processAddToExistingInBackground = async (
  jobId: string,
  existingCorpusId: string,
  selectedFileIds: string[],
  files: Array<{ id: string; name: string; mimeType: string; size: number; pageRange?: { startPage: number; endPage: number } }>,
  allowPartialSuccess: boolean,
  auth: ReturnType<typeof createRefreshableAuth>
) => {
  try {
    console.log(`[Job ${jobId}] Starting background processing for adding files to existing corpus...`);
    await addJobLog(jobId, {
      level: 'info',
      message: `Adding ${files.length} files to existing corpus ${existingCorpusId}`
    });
    await addFilesToExistingStore(existingCorpusId, selectedFileIds, files, auth, jobId, { allowPartialSuccess });
    console.log(`[Job ${jobId}] Completed successfully.`);
  } catch (error) {
    console.error(`[Job ${jobId}] Failed:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await addJobLog(jobId, {
      level: 'error',
      message: `Job failed: ${errorMessage}`
    });
    await updateJob(jobId, {
      status: 'failed',
      error: errorMessage,
      errorDetails: error,
      currentOperation: undefined,
      currentFile: undefined
    });
  }
};

export async function POST(request: Request) {
  const session = await getApiSession(request);

  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let displayName: string | undefined;
  let folderId: string | undefined;
  let selectedFileIds: string[] | undefined;
  let files: Array<{ id: string; name: string; mimeType: string; size: number; pageRange?: { startPage: number; endPage: number } }> | undefined;
  let allowPartialSuccess: boolean | undefined;

  try {
    const parsed = corpusRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const body = parsed.data;
    const mode = body.mode ?? 'new';
    selectedFileIds = body.selectedFileIds;
    files = body.files;
    allowPartialSuccess = Boolean(body.allowPartialSuccess);
    const existingCorpusId = body.existingCorpusId;
    const projectId = body.projectId;
    const callerEmail = session.user?.email ?? '';

    if (mode === 'existing') {
      if (!existingCorpusId) {
        return NextResponse.json(
          { error: 'Missing existingCorpusId for adding to an existing corpus' },
          { status: 400 }
        );
      }
    } else {
      displayName = (body.displayName ?? '').replace(/\s+/g, ' ').trim();
      folderId = body.folderId;
      if (!displayName || !folderId) {
        return NextResponse.json(
          { error: 'Corpus name and folder are required' },
          { status: 400 }
        );
      }
      if (displayName.length > MAX_CORPUS_NAME_LENGTH) {
        return NextResponse.json(
          { error: `Corpus name must be at most ${MAX_CORPUS_NAME_LENGTH} characters` },
          { status: 400 }
        );
      }
    }

    const filesWithRanges = files?.filter(f => f.pageRange);
    if (filesWithRanges && filesWithRanges.length > 0) {
      console.log(`📄 [API] Received ${filesWithRanges.length} file(s) with page ranges:`);
      filesWithRanges.forEach(f => {
        console.log(`   - ${f.name}: pages ${f.pageRange?.startPage}-${f.pageRange?.endPage}`);
      });
    }

    const auth = createRefreshableAuth(session.accessToken, session.refreshToken);

    // Reject creating a new corpus whose display name already exists.
    if (mode === 'new') {
      const existing = await listFileSearchStores(auth);
      if (existing.some((c) => c.displayName.trim().toLowerCase() === displayName!.toLowerCase())) {
        return NextResponse.json(
          { error: `A corpus named "${displayName}" already exists` },
          { status: 409 }
        );
      }
    }

    const providedById = new Map<string, { id: string; name: string; mimeType: string; size: number; pageRange?: { startPage: number; endPage: number } }>(
      files.map((f) => [f.id, f])
    );
    const missingIds = selectedFileIds.filter((id) => !providedById.has(id));
    if (missingIds.length > 0) {
      const fetched = await getFilesMetadataByIds(missingIds, auth);
      for (const f of fetched) {
        providedById.set(f.id, {
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          size: f.size ?? 0,
        });
      }
    }

    const allFiles = selectedFileIds.map((id) => {
      const f = providedById.get(id);
      return (
        f || {
          id,
          name: id,
          mimeType: 'application/octet-stream',
          size: 0,
        }
      );
    });

    const jobId = await createJob({
      ownerEmail: session.user?.email ?? undefined,
      displayName: mode === 'existing' ? `Add to ${existingCorpusId!}` : displayName!,
      folderId: mode === 'existing' ? existingCorpusId! : folderId!,
      totalFiles: selectedFileIds.length,
      selectedFiles: allFiles.map((f) => ({ 
        id: f.id, 
        name: f.name, 
        mimeType: f.mimeType, 
        size: f.size,
        pageRange: f.pageRange,
      })),
      allowPartialSuccess,
    });

    if (mode === 'existing') {
      console.log(`[API] Starting job to add files to existing corpus: ${existingCorpusId}`);
      processAddToExistingInBackground(jobId, existingCorpusId!, selectedFileIds, allFiles, allowPartialSuccess, auth);
    } else {
      console.log(`[API] Starting job to create new corpus: ${displayName}`);
      processInBackground(jobId, folderId!, displayName!, selectedFileIds, allFiles, allowPartialSuccess, auth, projectId, callerEmail);
    }

    return NextResponse.json({ 
      jobId, 
      status: 'pending',
      message: mode === 'existing' 
        ? 'Adding files to existing corpus in background' 
        : 'Corpus creation started in background'
    });

  } catch (error) {
    // Log full details (stack, names, counts) server-side only; never return
    // the stack or internal identifiers to the client.
    console.error('Failed to initiate corpus creation:', {
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      timestamp: new Date().toISOString(),
      displayName,
      folderId,
      fileCount: selectedFileIds?.length || 0,
    });

    return NextResponse.json(
      { error: 'Failed to initiate corpus creation' },
      { status: 500 }
    );
  }
}
