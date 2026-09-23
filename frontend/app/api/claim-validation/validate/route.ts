import { createHash, randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { getCorpusById } from '@/app/lib/rag/registry';
import { queryFileSearchStore } from '@/app/lib/rag/fileSearchStore';
import { createRefreshableAuth } from '@/app/lib/rag/auth';
import {
  createSession,
  addJob,
  addResult,
  updateJobStatus,
  updateSessionStatus,
  getSession,
} from '@/app/claim-validation/lib/jobStore';
import { renderValidationPrompt } from '@/app/claim-validation/lib/promptGenerationService';
import { mapQueryResultToRetrievalResult } from '@/app/claim-validation/lib/ragRetrievalService';
import { validateClaim } from '@/app/claim-validation/lib/validationService';
import { createIntegrityRecordSync } from '@/app/lib/integrity';
import { saveChainToDisk } from '@/app/lib/integrity/chainPersistence';
import { saveRun } from '@/app/claim-validation/lib/runPersistence';
import type { ValidateRequest, Claim, ValidationJob, ValidationResult } from '@/app/claim-validation/types';
import { resolveReferenceFile } from '@/app/claim-validation/lib/referenceFileGate';
import { runInBatches, withRetry } from '@/app/lib/concurrency';

function generateSessionId(): string {
  return `session_${randomUUID()}`;
}

function generateJobId(claimId: string): string {
  return `job_${claimId}_${Date.now()}`;
}

const MIN_CLAIM_TEXT_LENGTH = 10;

const MIN_EXTRACTION_CONFIDENCE = 0.2;

// How many claims to validate concurrently. Conservative because the Gemini
// RAG-query and validate calls have no built-in rate-limit handling other than
// the withRetry wrapper below; raising this increases 429 pressure.
const VALIDATION_CONCURRENCY = 4;

// The two Gemini calls throw Errors whose message embeds the HTTP status
// (e.g. "... failed (429): ...", "Gemini validation failed for claim X: 503 – ...").
// Retry only transient rate-limit / server errors.
const isTransientGeminiError = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(429|500|502|503|504)\b/.test(msg);
};

const retryTransient = <T>(fn: () => Promise<T>): Promise<T> =>
  withRetry(fn, { retries: 3, baseDelayMs: 1000, shouldRetry: isTransientGeminiError });

async function runValidationInBackground(
  sessionId: string,
  claims: Claim[],
  corpusId: string,
  validationPromptTemplate: string,
  accessToken: string,
  refreshToken: string | null | undefined,
  selectedFileIds?: string[],
  documentFilename?: string,
  projectId?: string
): Promise<void> {
  updateSessionStatus(sessionId, 'running');

  const auth = createRefreshableAuth(accessToken, refreshToken ?? undefined);

  const corpus = await getCorpusById(corpusId, auth);
  if (!corpus) {
    const err = new Error(`Corpus not found: ${corpusId}`);
    console.error(`[validate] ${err.message}`);
    updateSessionStatus(sessionId, 'failed', 'Corpus not found. Please select a different RAG corpus.');
    return;
  }

  const indexedFiles = corpus.files.filter((f) => f.status === 'indexed');
  if (indexedFiles.length === 0) {
    console.error(`[validate] Corpus ${corpusId} has no indexed files — cannot validate`);
    updateSessionStatus(
      sessionId,
      'failed',
      'This corpus has no indexed files yet. Add documents in RAG Knowledge Manager and wait for indexing to complete, or choose another corpus.'
    );
    return;
  }

  const scopeFiles =
    selectedFileIds && selectedFileIds.length > 0
      ? indexedFiles.filter((f) => selectedFileIds.includes(f.fileId))
      : indexedFiles;

  const scopeString = scopeFiles
    .map((f) => `${f.fileId}:${f.status}`)
    .sort()
    .join('|');

  const corpus_scope_sha = createHash('sha512').update(scopeString).digest('hex');

  const activeSession = getSession(sessionId);
  if (activeSession) {
    activeSession.corpus_scope_sha = corpus_scope_sha;
  }

  console.log(`[validate] session=${sessionId} corpus_scope_sha=${corpus_scope_sha.slice(0, 16)}… (${scopeFiles.length} files)`);

  // Per-claim chain inputs captured during the concurrent phase so the integrity
  // chain can be threaded sequentially (in claim order) afterwards. Only claims
  // that reach validateClaim are "chainable" — matching the original behaviour
  // where early-skipped and exception-failed claims are not part of the chain.
  interface ClaimChainInputs {
    claim: Claim;
    rendered: ReturnType<typeof renderValidationPrompt>;
    retrieval: ReturnType<typeof mapQueryResultToRetrievalResult>;
    refGate: ReturnType<typeof resolveReferenceFile>;
    validationResult: ValidationResult;
  }
  const chainInputsByIndex: Array<ClaimChainInputs | null> = new Array(claims.length).fill(null);

  // Phase 1 — validate claims with bounded concurrency. Each claim's RAG query +
  // validateClaim are independent; results are added live for incremental polling.
  await runInBatches(claims, VALIDATION_CONCURRENCY, async (claim, index) => {
    const jobId = generateJobId(claim.claim_id);
    const job: ValidationJob = {
      job_id:       jobId,
      claim_id:     claim.claim_id,
      corpus_id:    corpusId,
      prompt_id:    'manual',
      status:       'running',
      retry_count:  0,
      created_at:   new Date().toISOString(),
      completed_at: null,
      error_message: null,
    };

    addJob(sessionId, job);

    if (claim.claim_text.trim().length < MIN_CLAIM_TEXT_LENGTH) {
      console.warn(`[validate] claim=${claim.claim_id} skipped — claim_text too short`);
      updateJobStatus(sessionId, jobId, 'completed');
      addResult(sessionId, {
        result_id:          `res_skipped_${claim.claim_id}_short`,
        claim_id:           claim.claim_id,
        claim_text:         claim.claim_text,
        verdict:            'insufficient_evidence',
        support_level:      'none',
        explanation:        'Claim text is too short to be validated against the corpus.',
        evidence_snippets:  [],
        evidence_sources:   [],
        contradiction_flag: false,
        insufficiency_flag: true,
        confidence:         0,
        match_score:        null,
        run_status:         'skipped',
      });
      return;
    }

    if (claim.extraction_confidence < MIN_EXTRACTION_CONFIDENCE) {
      console.warn(`[validate] claim=${claim.claim_id} skipped — extraction_confidence=${claim.extraction_confidence} below threshold`);
      updateJobStatus(sessionId, jobId, 'completed');
      addResult(sessionId, {
        result_id:          `res_skipped_${claim.claim_id}_lowconf`,
        claim_id:           claim.claim_id,
        claim_text:         claim.claim_text,
        verdict:            'insufficient_evidence',
        support_level:      'none',
        explanation:        `Claim extraction confidence (${(claim.extraction_confidence * 100).toFixed(0)}%) is below the minimum threshold — claim may be an extraction artefact.`,
        evidence_snippets:  [],
        evidence_sources:   [],
        contradiction_flag: false,
        insufficiency_flag: true,
        confidence:         0,
        match_score:        null,
        run_status:         'skipped',
      });
      return;
    }

    try {
      const rendered = renderValidationPrompt(validationPromptTemplate, claim);

      const ragQuery = claim.claim_summary?.trim()
        || claim.source_snippet?.trim()
        || claim.claim_text;

      const refGate = resolveReferenceFile(claim.claim_ref, scopeFiles);
      if (refGate.matchedFile) {
        console.log(
          `[validate][ref-gate] claim=${claim.claim_id} ref="${claim.claim_ref}" ` +
          `→ narrowing search to "${refGate.matchedFile.name}" (filter: ${refGate.metadataFilter})`
        );
      }

      const result = await retryTransient(() => queryFileSearchStore(
        corpusId,
        corpus.corpusId,
        [{ role: 'user', text: ragQuery }],
        undefined,
        'gemini-3-flash-preview',
        refGate.metadataFilter
      ));

      const retrieval = mapQueryResultToRetrievalResult(
        claim.claim_id,
        corpusId,
        result,
        corpus
      );

      const { result: validationResult } = await retryTransient(() => validateClaim({
        claimId:        claim.claim_id,
        claimText:      claim.claim_text,
        renderedPrompt: rendered.prompt_text,
        retrieval,
      }));

      updateJobStatus(sessionId, jobId, 'completed');
      addResult(sessionId, validationResult);
      // Defer integrity-record creation to the ordered phase below.
      chainInputsByIndex[index] = { claim, rendered, retrieval, refGate, validationResult };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[validate] claim=${claim.claim_id} failed:`, message);

      updateJobStatus(sessionId, jobId, 'failed', message);

      const failedResult: ValidationResult = {
        result_id:          `res_failed_${claim.claim_id}`,
        claim_id:           claim.claim_id,
        claim_text:         claim.claim_text,
        verdict:            'unclear',
        support_level:      'none',
        explanation:        '',
        evidence_snippets:  [],
        evidence_sources:   [],
        contradiction_flag: false,
        insufficiency_flag: true,
        confidence:         0,
        match_score:        null,
        run_status:         'failed',
        error_message:      message,
      };

      addResult(sessionId, failedResult);
    }
  });

  // Phase 2 — thread the tamper-evident integrity chain in CLAIM ORDER. This is
  // pure synchronous hashing (no network), so it is deterministic and identical
  // to the previous sequential implementation. Each validationResult is the same
  // object reference already stored via addResult, so attaching the record here
  // updates the stored result in place.
  let previousChainHash: string | null = null;
  for (let i = 0; i < chainInputsByIndex.length; i++) {
    const inputs = chainInputsByIndex[i];
    if (!inputs) continue;
    const { claim, rendered, retrieval, refGate, validationResult } = inputs;
    try {
      const integrityRecord = createIntegrityRecordSync({
        name: `Claim: ${claim.claim_text.slice(0, 80)}${claim.claim_text.length > 80 ? '…' : ''}`,
        previousChainHash,
        components: [
          { type: 'user_input',         label: 'Claim Text',          value: claim.claim_text },
          { type: 'user_input',         label: 'Claim Ref',           value: claim.claim_ref ?? 'null' },
          { type: 'user_input',         label: 'Source Page',         value: claim.source_page ?? 'null' },
          { type: 'rag_config',         label: 'Corpus ID',           value: corpusId },
          { type: 'rag_config',         label: 'Corpus Scope Files',  value: scopeFiles.map(f => f.fileId) },
          { type: 'rag_config',         label: 'Corpus Scope SHA',    value: corpus_scope_sha },
          { type: 'rag_config',         label: 'Ref Gate File',       value: refGate.matchedFile?.name ?? 'all files' },
          { type: 'rag_config',         label: 'Ref Gate Ref Token',  value: refGate.matchedRef ?? 'none' },
          { type: 'final_prompt',       label: 'Validation Prompt',   value: rendered.prompt_text },
          { type: 'evidence',           label: 'Retrieved Chunks',    value: retrieval.retrieved_chunks.map(c => c.content) },
          { type: 'evidence',           label: 'Source Refs',         value: retrieval.source_refs },
          { type: 'model_config',       label: 'Model',               value: 'gemini-3-flash-preview' },
          { type: 'model_config',       label: 'Model Settings',      value: { topK: 20 } },
          { type: 'execution_metadata', label: 'Timestamp',           value: new Date().toISOString() },
          { type: 'output',             label: 'Status',              value: validationResult.verdict },
          { type: 'output',             label: 'Support Strength',    value: validationResult.support_level },
          { type: 'output',             label: 'Action',              value: validationResult.action ?? 'null' },
          { type: 'output',             label: 'RAG Quote',           value: validationResult.rag_quote ?? '' },
          { type: 'output',             label: 'RAG Location',        value: validationResult.rag_location ?? 'null' },
          { type: 'output',             label: 'Rationale',           value: validationResult.explanation },
          { type: 'output',             label: 'Contradiction',       value: validationResult.contradiction_flag },
          { type: 'output',             label: 'Insufficient Evidence', value: validationResult.insufficiency_flag },
          { type: 'output',             label: 'Run Status',          value: validationResult.run_status },
        ],
      });
      validationResult.integrity_record = integrityRecord;
      previousChainHash = integrityRecord.chain_hash;
    } catch (integrityError) {
      console.warn(`[validate][integrity] Failed for claim=${claim.claim_id}:`, integrityError);
    }
  }

  // Restore deterministic claim-order in the stored results (the concurrent phase
  // appends them in completion order) so the saved run snapshot is stable.
  const orderByClaimId = new Map(claims.map((c, i) => [c.claim_id, i]));
  const orderedSession = getSession(sessionId);
  if (orderedSession) {
    orderedSession.results.sort(
      (a, b) => (orderByClaimId.get(a.claim_id) ?? 0) - (orderByClaimId.get(b.claim_id) ?? 0),
    );
  }

  const completedSession = getSession(sessionId);
  if (!completedSession) return;

  const failed  = completedSession.results.filter((r) => r.run_status === 'failed').length;
  const finalStatus = failed === 0 ? 'completed' : failed === completedSession.results.length ? 'failed' : 'partial';
  updateSessionStatus(sessionId, finalStatus as 'completed' | 'failed' | 'partial');

  let chainFilename: string | undefined;
  let finalChainHash: string | undefined;
  try {
    const integrityRecords = completedSession.results
      .map((r) => r.integrity_record)
      .filter((rec): rec is NonNullable<typeof rec> => rec != null);
    if (integrityRecords.length > 0) {
      const saved = await saveChainToDisk(integrityRecords, {
        label: `Claim Validation — ${documentFilename ?? 'unknown'}`,
        operationType: 'Claim Validation',
        savedBy: 'system',
        ...(projectId ? { drive: { projectId, accessToken, refreshToken: refreshToken ?? undefined } } : {}),
      });
      chainFilename = saved.filename;
      finalChainHash = saved.final_chain_hash;
      console.log(`[validate] Auto-saved integrity chain: ${chainFilename}`);
    }
  } catch (chainErr) {
    console.error(`[validate] Failed to auto-save integrity chain for session ${sessionId}:`, chainErr);
  }

  try {
    await saveRun(sessionId, {
      document_filename: documentFilename,
      corpus_id:         corpusId,
      status:            finalStatus,
      total:             completedSession.total,
      completed_count:   completedSession.results.filter((r) => r.run_status !== 'failed').length,
      failed_count:      failed,
      claims,
      results:           completedSession.results,
      corpus_scope_sha:  completedSession.corpus_scope_sha,
      chain_filename:    chainFilename,
      final_chain_hash:  finalChainHash,
      ...(projectId ? { drive: { projectId, accessToken, refreshToken: refreshToken ?? undefined } } : {}),
    });
    console.log(`[validate] Auto-saved run snapshot for session ${sessionId}`);
  } catch (runErr) {
    console.error(`[validate] Failed to auto-save run for session ${sessionId}:`, runErr);
  }
}

export async function POST(request: Request) {
  const session = await getApiSession(request);
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: ValidateRequest;
  try {
    body = await request.json() as ValidateRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { claims, corpusId, validationPromptTemplate, selectedFileIds, documentFilename, projectId } = body;

  if (!Array.isArray(claims) || claims.length === 0) {
    return NextResponse.json({ error: 'No claims provided' }, { status: 400 });
  }
  if (!corpusId) {
    return NextResponse.json({ error: 'corpusId is required' }, { status: 400 });
  }
  if (!validationPromptTemplate?.trim()) {
    return NextResponse.json({ error: 'validationPromptTemplate is required' }, { status: 400 });
  }

  const sessionId    = body.sessionId ?? generateSessionId();
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(sessionId)) {
    return NextResponse.json({ error: 'Invalid sessionId' }, { status: 400 });
  }
  if (getSession(sessionId)) {
    return NextResponse.json({ error: 'This validation session ID is already allocated. Use a new ID for a new run.' }, { status: 409 });
  }
  const claimIds     = claims.map((c) => c.claim_id);
  const accessToken  = session.accessToken as string;
  const refreshToken = session.refreshToken ?? undefined;

  createSession(sessionId, claimIds, corpusId, validationPromptTemplate, undefined, documentFilename, session.user?.email ?? undefined);

  runValidationInBackground(
    sessionId,
    claims,
    corpusId,
    validationPromptTemplate,
    accessToken,
    refreshToken,
    Array.isArray(selectedFileIds) ? selectedFileIds : undefined,
    documentFilename,
    projectId
  ).catch((err) => {
    console.error(`[validate] Fatal session error for ${sessionId}:`, err);
    updateSessionStatus(sessionId, 'failed');
  });

  return NextResponse.json({ sessionId });
}
