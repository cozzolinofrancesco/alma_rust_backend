import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { getAllJobs, jobBelongsTo, jobView, JobStatus } from '@/app/lib/rag/jobRegistry';

export async function GET(request: Request) {
  const session = await getApiSession(request);

  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const statusFilter = searchParams.get('status');
    const limitParam = searchParams.get('limit');
    const limit = limitParam ? parseInt(limitParam, 10) : 100;

    let jobs: JobStatus[] = (await getAllJobs()).filter(job => jobBelongsTo(job, session.user?.email));
    const total = jobs.length;

    if (statusFilter) {
      jobs = jobs.filter(job => job.status === statusFilter);
    }

    if (limit > 0 && jobs.length > limit) {
      jobs = jobs.slice(0, limit);
    }

    return NextResponse.json({ 
      jobs: jobs.map(jobView),
      count: jobs.length,
      total,
    });
  } catch (error) {
    console.error('Failed to list jobs:', error);
    return NextResponse.json(
      { error: 'Failed to list jobs' },
      { status: 500 }
    );
  }
}

