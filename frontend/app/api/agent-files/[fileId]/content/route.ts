import { NextResponse, type NextRequest } from 'next/server';
import { getAgentnodesDrive } from '../../../../lib/agentnodesApi/driveFromRequest';
import { downloadAgentFile } from '../../../../lib/agentFiles-gdrive';
import { agentFilesErrorResponse } from '../../../../lib/agentFilesRoute.server';

export const runtime = 'nodejs';

export async function GET(request: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
  const context = await getAgentnodesDrive(request);
  if (!context) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const { fileId } = await params;
    const content = await downloadAgentFile(context.drive, fileId, request.signal);
    return new NextResponse(new Uint8Array(content.bytes), {
      headers: {
        'Content-Type': content.mimeType,
        'Content-Length': String(content.bytes.length),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(content.name)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Agent-File-Name': encodeURIComponent(content.name),
        'X-Agent-Source-Id': content.sourceId,
        ...(content.revision ? { 'X-Agent-Source-Revision': content.revision } : {}),
      },
    });
  } catch (error) { return agentFilesErrorResponse(error); }
}