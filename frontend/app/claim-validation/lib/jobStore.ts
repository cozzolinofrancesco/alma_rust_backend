import type { ValidationSession, ValidationJob, ValidationResult, SessionStatus, ValidationJobStatus } from '../types';

const MAX_SESSIONS = 50;
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

const globalForSessions = global as unknown as {
  claimValidationSessions?: Map<string, ValidationSession>;
};

const sessions: Map<string, ValidationSession> =
  globalForSessions.claimValidationSessions || new Map();

if (process.env.NODE_ENV !== 'production') {
  globalForSessions.claimValidationSessions = sessions;
}

function evictExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - new Date(session.created_at).getTime() > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}

function enforceCapacity(): void {
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort(
      (a, b) => new Date(a[1].created_at).getTime() - new Date(b[1].created_at).getTime()
    )[0];
    if (oldest) sessions.delete(oldest[0]);
  }
}

export function createSession(
  sessionId: string,
  claimIds: string[],
  corpusId: string,
  validationPromptTemplate: string,
  corpus_scope_sha?: string,
  documentFilename?: string,
  ownerEmail?: string
): ValidationSession {
  evictExpiredSessions();
  enforceCapacity();

  const now = new Date().toISOString();
  const session: ValidationSession = {
    session_id: sessionId,
    owner_email: ownerEmail,
    claim_ids: claimIds,
    corpus_id: corpusId,
    validation_prompt_template: validationPromptTemplate,
    status: 'pending',
    total: claimIds.length,
    completed_count: 0,
    failed_count: 0,
    created_at: now,
    updated_at: now,
    jobs: [],
    results: [],
    corpus_scope_sha,
    document_filename: documentFilename,
  };

  sessions.set(sessionId, session);
  return session;
}

export function getSession(sessionId: string): ValidationSession | undefined {
  return sessions.get(sessionId);
}

export function updateSessionStatus(sessionId: string, status: SessionStatus, errorMessage?: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.status = status;
  if (errorMessage) session.error_message = errorMessage;
  session.updated_at = new Date().toISOString();
}

export function addJob(sessionId: string, job: ValidationJob): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.jobs.push(job);
  session.updated_at = new Date().toISOString();
}

export function updateJobStatus(
  sessionId: string,
  jobId: string,
  status: ValidationJobStatus,
  errorMessage?: string
): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  const job = session.jobs.find((j) => j.job_id === jobId);
  if (!job) return;

  job.status = status;
  if (status === 'completed' || status === 'failed') {
    job.completed_at = new Date().toISOString();
  }
  if (errorMessage) {
    job.error_message = errorMessage;
  }

  session.updated_at = new Date().toISOString();
}

export function addResult(sessionId: string, result: ValidationResult): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.results.push(result);

  if (result.run_status === 'completed' || result.run_status === 'skipped') {
    session.completed_count += 1;
  } else {
    session.failed_count += 1;
  }

  const processed = session.completed_count + session.failed_count;
  if (processed >= session.total) {
    session.status = session.failed_count > 0 && session.completed_count > 0
      ? 'partial'
      : session.failed_count === session.total
        ? 'failed'
        : 'completed';
  } else {
    session.status = 'running';
  }

  session.updated_at = new Date().toISOString();
}

export interface SessionSnapshot {
  sessionId: string;
  owner_email?: string;
  status: SessionStatus;
  total: number;
  completed_count: number;
  failed_count: number;
  results: ValidationResult[];
  errors: Array<{ claim_id: string; message: string }>;
  corpus_scope_sha?: string;
  error_message?: string;
}

export interface LiveSessionMeta {
  session_id: string;
  owner_email?: string;
  document_filename?: string;
  corpus_id: string;
  status: SessionStatus;
  total: number;
  completed_count: number;
  failed_count: number;
  created_at: string;
  updated_at: string;
  is_live: true;
}

export function listSessionMetas(): LiveSessionMeta[] {
  evictExpiredSessions();
  return [...sessions.values()]
    .map((s) => ({
      session_id:       s.session_id,
      owner_email:      s.owner_email,
      document_filename: s.document_filename,
      corpus_id:        s.corpus_id,
      status:           s.status,
      total:            s.total,
      completed_count:  s.completed_count,
      failed_count:     s.failed_count,
      created_at:       s.created_at,
      updated_at:       s.updated_at,
      is_live:          true as const,
    }))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

export function getSessionSnapshot(sessionId: string): SessionSnapshot | null {
  const session = sessions.get(sessionId);
  if (!session) return null;

  const errors = session.results
    .filter((r) => r.run_status === 'failed')
    .map((r) => ({
      claim_id: r.claim_id,
      message: r.error_message ?? 'Unknown error',
    }));

  return {
    sessionId: session.session_id,
    owner_email: session.owner_email,
    status: session.status,
    total: session.total,
    completed_count: session.completed_count,
    failed_count: session.failed_count,
    results: session.results,
    errors,
    corpus_scope_sha: session.corpus_scope_sha,
    error_message: session.error_message,
  };
}
