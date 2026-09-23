import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { z } from 'zod';
import { createRefreshableAuth } from '@/app/lib/rag/auth';
import { addOrUpdateCorpus, getCorpusById } from '@/app/lib/rag/registry';
import { reimportFileWithMetadata, type ReimportResult } from '@/app/lib/rag/fileSearchStore';
import { verifyCorpusMetadata } from '@/app/lib/rag/verifyCorpusMetadata';

const HealBody = z.object({
  // Files to heal. Omit to heal every file currently flagged needs_repair + healable.
  fileIds: z.array(z.string().min(1)).optional(),
  // Optional per-file corrected pdf_name (used by the "edit" affordance).
  pdfNameOverrides: z.record(z.string(), z.string().min(1)).optional(),
});

// POST /api/rag/corpora/[corpusId]/heal
// Self-heal / edit metadata: delete each target file's chunk-documents and re-import
// (from Drive) with a correct `pdf_name` (+ `file_id`). Re-verifies + persists after.
// Runs synchronously and sequentially (chunk imports are rate-limited); intended as an
// admin action from the Knowledge Manager.
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
    const parsed = HealBody.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { fileIds, pdfNameOverrides } = parsed.data;

    const auth = createRefreshableAuth(session.accessToken, session.refreshToken);
    const entry = await getCorpusById(corpusId, auth);
    if (!entry) {
      return NextResponse.json({ error: 'Corpus not found' }, { status: 404 });
    }

    // Resolve targets: explicit list, or every flagged + healable file.
    let targets: string[];
    if (fileIds && fileIds.length > 0) {
      targets = fileIds;
    } else {
      const verification = entry.verification ?? (await verifyCorpusMetadata(entry));
      targets = verification.files
        .filter((f) => f.issue !== 'ok' && f.healable)
        .map((f) => f.fileId);
    }

    if (targets.length === 0) {
      return NextResponse.json({ error: 'No healable files to repair' }, { status: 400 });
    }

    const healed: ReimportResult[] = [];
    const failures: Array<{ fileId: string; error: string }> = [];
    for (const fileId of targets) {
      try {
        const override = pdfNameOverrides?.[fileId];
        healed.push(await reimportFileWithMetadata(corpusId, fileId, auth, override));
      } catch (err) {
        failures.push({ fileId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Re-verify against the now-updated registry and persist.
    const fresh = await getCorpusById(corpusId, auth);
    let verification = fresh?.verification;
    if (fresh) {
      verification = await verifyCorpusMetadata(fresh);
      fresh.verification = verification;
      try {
        await addOrUpdateCorpus(fresh, auth);
      } catch (persistErr) {
        console.warn('[Heal] Failed to persist verification result:', persistErr);
      }
    }

    return NextResponse.json({ healed, failures, verification });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to heal corpus';
    console.error('❌ [Heal] Error:', message);
    const status = message.includes('not found') ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
