import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { getJob, cancelJob, deleteJob, skipJobFile, jobBelongsTo, jobView } from '@/app/lib/rag/jobRegistry';

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

    return NextResponse.json(jobView(job));
  } catch (error) {
    console.error('Failed to get job status:', error);
    return NextResponse.json(
      { error: 'Failed to get job status' },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const session = await getApiSession(request);

  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { jobId } = await params;
    if (!jobBelongsTo(await getJob(jobId), session.user?.email)) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }
    const body = await request.json();
    
    if (body.action === 'cancel') {
      const success = await cancelJob(jobId);
      
      if (!success) {
        const job = await getJob(jobId);
        if (!job) {
          return NextResponse.json({ error: 'Job not found' }, { status: 404 });
        }
        return NextResponse.json(
          { error: 'Job cannot be cancelled (not pending or processing)' },
          { status: 400 }
        );
      }
      
      const updatedJob = await getJob(jobId);
      return NextResponse.json({ success: true, job: updatedJob ? jobView(updatedJob) : null });
    }

    if (body.action === 'skip_file') {
      const fileId = body.fileId as string | undefined;
      if (!fileId) {
        return NextResponse.json({ error: 'Missing fileId' }, { status: 400 });
      }

      const success = await skipJobFile(jobId, fileId);
      if (!success) {
        const job = await getJob(jobId);
        if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
        return NextResponse.json(
          { error: 'File cannot be skipped (job not pending/processing)' },
          { status: 400 }
        );
      }

      const updatedJob = await getJob(jobId);
      return NextResponse.json({ success: true, job: updatedJob ? jobView(updatedJob) : null });
    }
    
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    console.error('Failed to update job:', error);
    return NextResponse.json(
      { error: 'Failed to update job' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const session = await getApiSession(request);

  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { jobId } = await params;
    if (!jobBelongsTo(await getJob(jobId), session.user?.email)) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }
    const success = await deleteJob(jobId);
    
    if (!success) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete job:', error);
    return NextResponse.json(
      { error: 'Failed to delete job' },
      { status: 500 }
    );
  }
}
