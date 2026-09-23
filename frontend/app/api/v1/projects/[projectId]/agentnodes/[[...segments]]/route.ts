import type { NextRequest } from 'next/server';
import { dispatchAgentnodes } from '@/app/lib/agentnodesApi/dispatchAgentnodes';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ projectId: string; segments?: string[] }> };

async function handle(request: NextRequest, context: RouteContext) {
  const { projectId, segments } = await context.params;
  return dispatchAgentnodes(request, projectId, segments);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
