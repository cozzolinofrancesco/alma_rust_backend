import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { createRefreshableAuth } from '@/app/lib/rag/auth';
import { addOrUpdateCorpus } from '@/app/lib/rag/registry';
import { verifyCorpusById } from '@/app/lib/rag/verifyCorpusMetadata';

// GET /api/rag/corpora/[corpusId]/verify
// Verify that every indexed file's chunks carry a correct `pdf_name` (the key a
// subset document filter matches on). Persists the result on the corpus so the
// Knowledge Manager can show a badge without re-verifying.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ corpusId: string }> },
) {
  const session = await getApiSession(request);
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { corpusId } = await params;
    const auth = createRefreshableAuth(session.accessToken, session.refreshToken);

    const { entry, verification } = await verifyCorpusById(corpusId, auth);

    entry.verification = verification;
    try {
      await addOrUpdateCorpus(entry, auth);
    } catch (persistErr) {
      console.warn('[Verify] Failed to persist verification result:', persistErr);
    }

    return NextResponse.json({ verification });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to verify corpus';
    console.error('❌ [Verify] Error:', message);
    const status = message.includes('not found') ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
