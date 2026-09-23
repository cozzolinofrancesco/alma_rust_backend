import {
  addJob,
  addResult,
  getSession,
  updateJobStatus,
  updateSessionStatus,
} from '@/app/claim-validation/lib/jobStore';
import { createIntegrityRecordSync } from '@/app/lib/integrity';
import { saveChainToDisk } from '@/app/lib/integrity/chainPersistence';
import { runInBatches, withRetry } from '@/app/lib/concurrency';
import type { Claim, ValidationJob, ValidationResult } from '@/app/claim-validation/types';
import type { AdapterContext, Judge, ReferenceAdapter } from './referenceAdapter';

// Generalized version of claim-validation's runValidationInBackground: extract
// is done by the caller, then per claim we ask the adapter for evidence and the
// judge for a verdict. Reuses jobStore (so the existing poll route + UI work),
// bounded concurrency, transient-error retry, and integrity-chain threading.

const MIN_CLAIM_TEXT_LENGTH = 10;

const isTransient = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(429|500|502|503|504)\b/.test(msg);
};
const retryTransient = <T>(fn: () => Promise<T>): Promise<T> =>
  withRetry(fn, { retries: 3, baseDelayMs: 1000, shouldRetry: isTransient });

function generateJobId(claimId: string): string {
  return `job_${claimId}_${Date.now()}`;
}

interface RunParams {
  sessionId: string;
  claims: Claim[];
  adapter: ReferenceAdapter;
  judge: Judge;
  ctx: AdapterContext;
  documentFilename?: string;
  concurrency?: number;
}

export async function runValidationGeneric(params: RunParams): Promise<void> {
  const { sessionId, claims, adapter, judge, ctx, documentFilename } = params;
  const concurrency = params.concurrency ?? 4;

  updateSessionStatus(sessionId, 'running');

  try {
    await adapter.prepare?.(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Adapter setup failed';
    console.error(`[validation:${adapter.mode}] prepare failed:`, message);
    updateSessionStatus(sessionId, 'failed', message);
    return;
  }

  const chainByIndex: Array<{ claim: Claim; result: ValidationResult } | null> =
    new Array(claims.length).fill(null);

  await runInBatches(claims, concurrency, async (claim, index) => {
    const jobId = generateJobId(claim.claim_id);
    const job: ValidationJob = {
      job_id: jobId,
      claim_id: claim.claim_id,
      corpus_id: adapter.mode,
      prompt_id: adapter.mode,
      status: 'running',
      retry_count: 0,
      created_at: new Date().toISOString(),
      completed_at: null,
      error_message: null,
    };
    addJob(sessionId, job);

    if (claim.claim_text.trim().length < MIN_CLAIM_TEXT_LENGTH) {
      updateJobStatus(sessionId, jobId, 'completed');
      addResult(sessionId, {
        result_id: `res_skipped_${claim.claim_id}_short`,
        claim_id: claim.claim_id,
        claim_text: claim.claim_text,
        verdict: 'insufficient_evidence',
        support_level: 'none',
        explanation: 'Claim text is too short to validate.',
        evidence_snippets: [], evidence_sources: [],
        contradiction_flag: false, insufficiency_flag: true,
        confidence: 0, match_score: null, run_status: 'skipped',
      });
      return;
    }

    try {
      const retrieval = await retryTransient(() => adapter.getEvidence(claim, ctx));
      const result = await retryTransient(() => judge.judge(claim, retrieval));
      updateJobStatus(sessionId, jobId, 'completed');
      addResult(sessionId, result);
      chainByIndex[index] = { claim, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[validation:${adapter.mode}] claim=${claim.claim_id} failed:`, message);
      updateJobStatus(sessionId, jobId, 'failed', message);
      addResult(sessionId, {
        result_id: `res_failed_${claim.claim_id}`,
        claim_id: claim.claim_id,
        claim_text: claim.claim_text,
        verdict: 'unclear',
        support_level: 'none',
        explanation: '',
        evidence_snippets: [], evidence_sources: [],
        contradiction_flag: false, insufficiency_flag: true,
        confidence: 0, match_score: null, run_status: 'failed',
        error_message: message,
      });
    }
  });

  // Thread the tamper-evident integrity chain in claim order (pure hashing).
  let previousChainHash: string | null = null;
  for (let i = 0; i < chainByIndex.length; i++) {
    const entry = chainByIndex[i];
    if (!entry) continue;
    const { claim, result } = entry;
    try {
      const record = createIntegrityRecordSync({
        name: `Claim: ${claim.claim_text.slice(0, 80)}${claim.claim_text.length > 80 ? '…' : ''}`,
        previousChainHash,
        components: [
          { type: 'user_input', label: 'Claim Text', value: claim.claim_text },
          { type: 'rag_config', label: 'Validation Mode', value: adapter.mode },
          { type: 'evidence', label: 'Evidence', value: (result.retrieval_result?.retrieved_chunks ?? []).map((c) => c.content) },
          { type: 'evidence', label: 'Source Refs', value: result.retrieval_result?.source_refs ?? [] },
          { type: 'execution_metadata', label: 'Timestamp', value: new Date().toISOString() },
          { type: 'output', label: 'Verdict', value: result.verdict },
          { type: 'output', label: 'Support', value: result.support_level },
          { type: 'output', label: 'Rationale', value: result.explanation },
          { type: 'output', label: 'Contradiction', value: result.contradiction_flag },
          { type: 'output', label: 'Run Status', value: result.run_status },
        ],
      });
      result.integrity_record = record;
      previousChainHash = record.chain_hash;
    } catch (integrityError) {
      console.warn(`[validation:${adapter.mode}] integrity failed for ${claim.claim_id}:`, integrityError);
    }
  }

  // Restore claim order in the stored results (concurrent phase appends out of order).
  const orderByClaimId = new Map(claims.map((c, i) => [c.claim_id, i]));
  const session = getSession(sessionId);
  if (session) {
    session.results.sort((a, b) => (orderByClaimId.get(a.claim_id) ?? 0) - (orderByClaimId.get(b.claim_id) ?? 0));
  }

  const finalSession = getSession(sessionId);
  if (!finalSession) return;
  const failed = finalSession.results.filter((r) => r.run_status === 'failed').length;
  const finalStatus = failed === 0 ? 'completed' : failed === finalSession.results.length ? 'failed' : 'partial';
  updateSessionStatus(sessionId, finalStatus);

  try {
    const records = finalSession.results
      .map((r) => r.integrity_record)
      .filter((rec): rec is NonNullable<typeof rec> => rec != null);
    if (records.length > 0) {
      await saveChainToDisk(records, {
        label: `Validation (${adapter.mode}) — ${documentFilename ?? 'unknown'}`,
        operationType: `Validation: ${adapter.label}`,
        savedBy: 'system',
      });
    }
  } catch (chainErr) {
    console.error(`[validation:${adapter.mode}] chain save failed:`, chainErr);
  }
}
