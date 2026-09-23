import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { createJob, updateJob } from '@/app/lib/rag/jobRegistry';
import { createFileSearchStoreFromDrive } from '@/app/lib/rag/fileSearchStore';
import { createRefreshableAuth } from '@/app/lib/rag/auth';

// Ingestion runs the readability rescue, which can rasterise pages and run per-page OCR
// (sequential Gemini calls) — well beyond the default serverless budget. Pin nodejs
// (sharp/pdf2pic via fileSearchStore → pdfSplitter/OCR) and match the query route's cap.
export const runtime = 'nodejs';
export const maxDuration = 3600;

type StartFileBody = {
  folderId: string;
  displayName?: string;
  file: { id: string; name: string; mimeType: string; size?: number };
  allowPartialSuccess?: boolean;
};

const processInBackground = async (
  jobId: string,
  folderId: string,
  displayName: string,
  file: { id: string; name: string; mimeType: string; size?: number },
  allowPartialSuccess: boolean,
  auth: ReturnType<typeof createRefreshableAuth>
) => {
  try {
    await createFileSearchStoreFromDrive(
      folderId,
      displayName,
      [file.id],
      [{ id: file.id, name: file.name, mimeType: file.mimeType, size: file.size ?? 0 }],
      auth,
      jobId,
      { allowPartialSuccess }
    );
  } catch (error) {
    console.error(`[Job ${jobId}] Single-file processing failed:`, error);
    await updateJob(jobId, {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
      errorDetails: error,
    });
  }
};

export async function POST(request: Request) {
  const session = await getApiSession(request);

  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = (await request.json()) as StartFileBody;
    const { folderId, file } = body;

    if (!folderId || !file?.id || !file?.name || !file?.mimeType) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const displayName = body.displayName?.trim() || `Single file: ${file.name}`;
    const allowPartialSuccess = Boolean(body.allowPartialSuccess);

    const auth = createRefreshableAuth(session.accessToken, session.refreshToken);

    const jobId = await createJob({
      ownerEmail: session.user?.email ?? undefined,
      displayName,
      folderId,
      totalFiles: 1,
      selectedFiles: [{ id: file.id, name: file.name, mimeType: file.mimeType, size: file.size ?? 0 }],
      allowPartialSuccess,
    });

    processInBackground(jobId, folderId, displayName, file, allowPartialSuccess, auth);

    return NextResponse.json({ success: true, jobId });
  } catch (error) {
    console.error('Failed to start single-file job:', error);
    return NextResponse.json({ error: 'Failed to start single-file job' }, { status: 500 });
  }
}

