import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { z } from 'zod';
import { createSession, updateSessionStatus } from '@/app/claim-validation/lib/jobStore';
import type { Claim } from '@/app/claim-validation/types';
import { runValidationGeneric } from '@/app/validation/lib/runValidationGeneric';
import { defaultJudge, contradictionJudge, reconciliationJudge } from '@/app/validation/lib/judges';
import { createDocumentAdapter } from '@/app/validation/lib/adapters/documentAdapter';
import { createSelfAdapter } from '@/app/validation/lib/adapters/selfAdapter';
import { createPublicAdapter } from '@/app/validation/lib/adapters/publicAdapter';
import { createDatabaseAdapter } from '@/app/validation/lib/adapters/databaseAdapter';
import type { AdapterContext, Judge, PerClaimMode, ReferenceAdapter } from '@/app/validation/lib/referenceAdapter';

export const maxDuration = 3000;

// Claims are produced client-side by the existing /api/claim-validation/extract-claims
// route, so here we trust their shape minimally (the heavy validation happened at
// extraction). We only need the fields the spine reads.
const claimSchema = z.object({
  claim_id: z.string(),
  document_id: z.string(),
  claim_text: z.string(),
  claim_type: z.string(),
  source_page: z.number().nullable(),
  source_snippet: z.string(),
  extraction_confidence: z.number(),
  review_status: z.string(),
  selected: z.boolean(),
  claim_summary: z.string().optional(),
  claim_ref: z.string().nullable().optional(),
}).passthrough();

const bodySchema = z.object({
  claims: z.array(claimSchema).min(1),
  documentFilename: z.string().optional(),
  // doc-doc:
  referenceFileUri: z.string().optional(),
  referenceMimeType: z.string().optional(),
  referenceFilename: z.string().optional(),
  // doc-db:
  dbConnectionId: z.string().optional(),
});

const MODES: ReadonlySet<string> = new Set<PerClaimMode>(['doc-doc', 'doc-public', 'doc-db', 'self']);

function buildAdapterAndJudge(mode: PerClaimMode): { adapter: ReferenceAdapter; judge: Judge; concurrency: number } {
  switch (mode) {
    case 'doc-doc': return { adapter: createDocumentAdapter(), judge: defaultJudge, concurrency: 4 };
    case 'doc-public': return { adapter: createPublicAdapter(), judge: defaultJudge, concurrency: 2 };
    case 'doc-db': return { adapter: createDatabaseAdapter(), judge: reconciliationJudge, concurrency: 3 };
    case 'self': return { adapter: createSelfAdapter(), judge: contradictionJudge, concurrency: 4 };
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ mode: string }> }
): Promise<NextResponse> {
  const session = await getApiSession(request);
  const ownerEmail = session?.user?.email;
  if (!ownerEmail) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { mode } = await params;
  if (!MODES.has(mode)) {
    return NextResponse.json({ error: `Unknown validation mode: ${mode}` }, { status: 404 });
  }
  const perClaimMode = mode as PerClaimMode;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 400 });
  }
  const body = parsed.data;

  if (perClaimMode === 'doc-doc' && !body.referenceFileUri) {
    return NextResponse.json({ error: 'referenceFileUri is required for doc-doc' }, { status: 400 });
  }
  if (perClaimMode === 'doc-db' && !body.dbConnectionId) {
    return NextResponse.json({ error: 'dbConnectionId is required for doc-db' }, { status: 400 });
  }

  const claims = body.claims as Claim[];
  const sessionId = `session_${randomUUID()}`;
  createSession(sessionId, claims.map((c) => c.claim_id), perClaimMode, perClaimMode, undefined, body.documentFilename, ownerEmail);

  const { adapter, judge, concurrency } = buildAdapterAndJudge(perClaimMode);
  const ctx: AdapterContext = {
    claims,
    ownerEmail,
    referenceFileUri: body.referenceFileUri,
    referenceMimeType: body.referenceMimeType,
    referenceFilename: body.referenceFilename,
    dbConnectionId: body.dbConnectionId,
  };

  runValidationGeneric({ sessionId, claims, adapter, judge, ctx, documentFilename: body.documentFilename, concurrency })
    .catch((err) => {
      console.error(`[validation:${perClaimMode}] fatal:`, err);
      updateSessionStatus(sessionId, 'failed', err instanceof Error ? err.message : 'Run failed');
    });

  return NextResponse.json({ sessionId });
}
