import { NextResponse, type NextRequest } from 'next/server';
import { getAgentnodesDrive } from '../../lib/agentnodesApi/driveFromRequest';
import { importAgentFile, listAgentFiles, uploadAgentFile } from '../../lib/agentFiles-gdrive';
import { driveFileIdSchema } from '../../lib/agentFiles';
import { agentFilesErrorResponse } from '../../lib/agentFilesRoute.server';
import { MAX_FILE_SIZE_BYTES } from '../../lib/fileValidation';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const context = await getAgentnodesDrive(request);
  if (!context) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    return NextResponse.json({ files: await listAgentFiles(context.drive, request.signal) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return agentFilesErrorResponse(error); }
}

export async function POST(request: NextRequest) {
  const context = await getAgentnodesDrive(request);
  if (!context) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    if (Number(request.headers.get('content-length')) > MAX_FILE_SIZE_BYTES + 1024 * 1024) {
      return NextResponse.json({ error: 'Upload exceeds the 30MB limit.' }, { status: 413 });
    }
    if (request.headers.get('content-type')?.startsWith('multipart/form-data')) {
      const form = await request.formData();
      const files = form.getAll('file');
      if (files.length !== 1 || !(files[0] instanceof File)) return NextResponse.json({ error: 'Choose one file per upload.' }, { status: 400 });
      return NextResponse.json({ file: await uploadAgentFile(context.drive, files[0], request.signal) }, { status: 201 });
    }
    const body = await request.json().catch(() => null);
    const parsed = driveFileIdSchema.safeParse(body?.sourceId);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid source file.' }, { status: 400 });
    return NextResponse.json({ file: await importAgentFile(context.drive, parsed.data, 'drive', request.signal) }, { status: 201 });
  } catch (error) { return agentFilesErrorResponse(error); }
}