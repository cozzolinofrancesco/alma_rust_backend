import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { searchDriveFolders, searchDriveItems } from '@/app/lib/rag/drive';
import { createRefreshableAuth } from '@/app/lib/rag/auth';

export async function GET(request: Request) {
  const session = await getApiSession(request);

  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');

  if (!query) {
    return NextResponse.json({ error: 'Query parameter "q" is required' }, { status: 400 });
  }

  try {
    const auth = createRefreshableAuth(session.accessToken, session.refreshToken);

    const q = query.trim();
    const isDirectIdLookup = /^[a-zA-Z0-9_-]{20,}$/.test(q);
    const isExtensionTokenQuery = !isDirectIdLookup && !q.includes('.') && !/\s/.test(q);
    const EXT_TOKENS = new Set([
      'pdf','json','doc','docx','txt','md','csv','xls','xlsx','ppt','pptx','xml','sql','ts','js','py','r','yaml','yml'
    ]);

    if (isExtensionTokenQuery && EXT_TOKENS.has(q.toLowerCase())) {
      const folders = await searchDriveFolders(q, auth);
      return NextResponse.json({ folders, files: [] });
    }

    const result = await searchDriveItems(q, auth);

    return NextResponse.json(result);
  } catch (error) {
    console.error('Drive search error:', error);
    return NextResponse.json(
      { error: 'Failed to search Drive' },
      { status: 500 }
    );
  }
}
