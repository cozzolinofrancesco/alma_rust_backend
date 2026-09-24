import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { google } from 'googleapis';
import { createRefreshableAuth } from '@/app/lib/rag/auth';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ fileId: string }> }
) {
  const session = await getApiSession(request);
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { fileId } = await params;

    const auth = createRefreshableAuth(session.accessToken, session.refreshToken);

    const drive = google.drive({ version: 'v3', auth });

    const fileMetadata = await drive.files.get({
      fileId,
      fields: 'name,mimeType',
      supportsAllDrives: true,
    });

    const response = await drive.files.get(
      {
        fileId,
        alt: 'media',
        supportsAllDrives: true,
      },
      { responseType: 'text' }
    );

    const content = response.data;

    if (
      fileMetadata.data.mimeType === 'application/json' ||
      fileMetadata.data.name?.endsWith('.json')
    ) {
      try {
        const parsed = typeof content === 'string' ? JSON.parse(content) : content;
        return NextResponse.json(parsed);
      } catch {
        return new NextResponse(String(content), {
          headers: {
            'Content-Type': 'text/plain',
            // MISC-INFO-001: force download + block MIME sniffing so attacker-supplied
            // content cannot render inline (e.g. as HTML) in this origin.
            'Content-Disposition': 'attachment',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
    }

    return new NextResponse(String(content), {
      headers: {
        'Content-Type': fileMetadata.data.mimeType || 'text/plain',
        // MISC-INFO-001: the mimeType comes from Drive (attacker-controllable);
        // force download + block MIME sniffing so a declared HTML mimeType cannot
        // render inline in this origin.
        'Content-Disposition': 'attachment',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    console.error('Failed to download file:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to download file' },
      { status: 500 }
    );
  }
}
