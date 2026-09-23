import { NextResponse, type NextRequest } from 'next/server';
import { getAgentnodesDrive } from '../../../lib/agentnodesApi/driveFromRequest';
import { getAgentFile, removeAgentFile, updateAgentFileLabel } from '../../../lib/agentFiles-gdrive';
import { agentFilesErrorResponse } from '../../../lib/agentFilesRoute.server';
import { z } from 'zod';

export const runtime = 'nodejs';
type RouteContext = { params: Promise<{ fileId: string }> };

export async function GET(request: NextRequest, route: RouteContext) {
  const context = await getAgentnodesDrive(request);
  if (!context) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const { fileId } = await route.params;
    return NextResponse.json({ file: await getAgentFile(context.drive, fileId, request.signal) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return agentFilesErrorResponse(error); }
}

export async function PATCH(request: NextRequest, route: RouteContext) {
  const context = await getAgentnodesDrive(request);
  if (!context) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = z.object({ name: z.string().trim().min(1).max(512) }).strict().safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid file label.' }, { status: 400 });
  try {
    const { fileId } = await route.params;
    return NextResponse.json({ file: await updateAgentFileLabel(context.drive, fileId, parsed.data.name, request.signal) });
  } catch (error) { return agentFilesErrorResponse(error); }
}

export async function DELETE(request: NextRequest, route: RouteContext) {
  const context = await getAgentnodesDrive(request);
  if (!context) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const { fileId } = await route.params;
    await removeAgentFile(context.drive, fileId, request.signal);
    return new NextResponse(null, { status: 204 });
  } catch (error) { return agentFilesErrorResponse(error); }
}