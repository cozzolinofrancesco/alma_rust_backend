import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { getJob, createJob, updateJob, jobBelongsTo } from '@/app/lib/rag/jobRegistry';
import { createFileSearchStoreFromDrive } from '@/app/lib/rag/fileSearchStore';
import { createRefreshableAuth } from '@/app/lib/rag/auth';

const processInBackground = async (
  jobId: string, 
  folderId: string, 
  displayName: string, 
  selectedFileIds: string[], 
  files: Array<{ id: string; name: string; mimeType: string; size: number }>, 
  allowPartialSuccess: boolean,
  auth: ReturnType<typeof createRefreshableAuth>
) => {
  try {
    console.log(`[Job ${jobId}] Starting background processing (restart)...`);
    await createFileSearchStoreFromDrive(folderId, displayName, selectedFileIds, files, auth, jobId, { allowPartialSuccess });
    console.log(`[Job ${jobId}] Completed successfully.`);
  } catch (error) {
    console.error(`[Job ${jobId}] Failed:`, error);
    await updateJob(jobId, { 
      status: 'failed', 
      error: error instanceof Error ? error.message : 'Unknown error',
      errorDetails: error
    });
  }
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const session = await getApiSession(request);

  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { jobId: oldJobId } = await params;
    const oldJob = await getJob(oldJobId);
    
    if (!jobBelongsTo(oldJob, session.user?.email)) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }
    
    if (!['failed', 'cancelled', 'completed_with_errors'].includes(oldJob.status)) {
      return NextResponse.json(
        { error: 'Only failed, cancelled, or jobs with errors can be restarted' },
        { status: 400 }
      );
    }
    
    if (!oldJob.selectedFiles || oldJob.selectedFiles.length === 0) {
      return NextResponse.json(
        { error: 'Cannot restart: job does not have stored file information' },
        { status: 400 }
      );
    }
    
    const auth = createRefreshableAuth(session.accessToken, session.refreshToken);
    
    const newJobId = await createJob({
      ownerEmail: session.user?.email ?? undefined,
      displayName: `${oldJob.displayName} (Retry)`,
      folderId: oldJob.folderId,
      totalFiles: oldJob.selectedFiles.length,
      selectedFiles: oldJob.selectedFiles,
      allowPartialSuccess: oldJob.allowPartialSuccess === true,
    });
    
    const files = oldJob.selectedFiles.map(f => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      size: f.size || 0
    }));
    
    const selectedFileIds = oldJob.selectedFiles.map(f => f.id);
    
    processInBackground(newJobId, oldJob.folderId, oldJob.displayName, selectedFileIds, files, oldJob.allowPartialSuccess === true, auth);
    
    return NextResponse.json({
      success: true,
      newJobId,
      oldJobId,
      message: 'Job restarted successfully'
    });
    
  } catch (error) {
    console.error('Failed to restart job:', error);
    return NextResponse.json(
      { error: 'Failed to restart job' },
      { status: 500 }
    );
  }
}

