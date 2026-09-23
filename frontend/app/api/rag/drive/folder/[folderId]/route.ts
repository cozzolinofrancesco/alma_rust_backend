import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { getFolderMetadata, listFolderFiles } from '@/app/lib/rag/drive';
import { createRefreshableAuth } from '@/app/lib/rag/auth';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ folderId: string }> }
) {
  const session = await getApiSession(request);

  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { folderId } = await params;

  if (!folderId) {
    return NextResponse.json({ error: 'Folder ID is required' }, { status: 400 });
  }

  try {
    const auth = createRefreshableAuth(session.accessToken, session.refreshToken);

    const [folder, files] = await Promise.all([
      getFolderMetadata(folderId, auth),
      listFolderFiles(folderId, auth),
    ]);

    return NextResponse.json({ folder, files });
  } catch (error) {
    console.error('Folder listing error:', error);
    return NextResponse.json(
      { error: 'Failed to list folder files' },
      { status: 500 }
    );
  }
}
