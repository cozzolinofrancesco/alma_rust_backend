import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { getJob, jobBelongsTo } from '@/app/lib/rag/jobRegistry';
import { createRefreshableAuth } from '@/app/lib/rag/auth';
import { loadRegistry } from '@/app/lib/rag/registry';

function generateStoreName(folderId: string): string {
  const normalized = folderId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `fileSearchStores/folder-${normalized}`;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const session = await getApiSession(request);

  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { jobId } = await params;
    const job = await getJob(jobId);

    if (!jobBelongsTo(job, session.user?.email)) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    const auth = createRefreshableAuth(session.accessToken, session.refreshToken);
    const registry = await loadRegistry(auth);

    const storeName = generateStoreName(job.folderId);
    const entry = registry.corpora.find((c) => c.corpusId === storeName) || null;

    return NextResponse.json({
      success: true,
      jobId,
      storeName,
      corpusEntryId: entry?.id || null,
      files: entry?.files || [],
      updatedAt: entry?.updatedAt || null,
    });
  } catch (error) {
    console.error('Failed to load job files from registry:', error);
    return NextResponse.json({ error: 'Failed to load job files' }, { status: 500 });
  }
}

