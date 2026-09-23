import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { getCorpusById } from '@/app/lib/rag/registry';
import { createRefreshableAuth } from '@/app/lib/rag/auth';
import { queryFileSearchStore } from '@/app/lib/rag/fileSearchStore';

// Pin the Node.js runtime: transitively depends on native modules via fileSearchStore.
export const runtime = 'nodejs';

const PROBE_QUESTION = 'Summarize the main content of this document in 2-3 sentences.';

// POST /api/rag/corpora/[corpusId]/qa-probe
// User-triggered health check: runs ONE probe query and reports whether the corpus
// returns readable, grounded content — catches scanned/empty/garbage corpora that
// imported "successfully" but have nothing usable to retrieve.
export async function POST(
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
    const corpus = await getCorpusById(corpusId, auth);
    if (!corpus) {
      return NextResponse.json({ error: 'Corpus not found' }, { status: 404 });
    }

    const result = await queryFileSearchStore(
      corpusId,
      corpus.corpusId,
      [{ role: 'user', text: PROBE_QUESTION }],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      request.signal,
    );

    const chunkCount = result.groundingChunks?.length ?? 0;
    const charCount = result.response?.length ?? 0;
    const ok = Boolean(result.isGrounded) && chunkCount > 0 && charCount > 0;

    return NextResponse.json({
      ok,
      isGrounded: Boolean(result.isGrounded),
      chunkCount,
      charCount,
      sample: (result.response ?? '').slice(0, 300),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return NextResponse.json({ error: 'Probe aborted' }, { status: 499 });
    }
    const message = error instanceof Error ? error.message : 'Probe failed';
    console.error('❌ [QA Probe] Error:', message);
    const status = message.includes('not found') ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
