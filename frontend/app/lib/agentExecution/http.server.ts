import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeServiceRequest } from '../serviceApiAuth';
import type { AgentInputSession } from '../agentInputs.server';
import { AgentFileError } from '../agentFiles-gdrive';
import { GalileoGatewayError } from '../galileo/errors.server';
import { AgentExecutionError } from './errors';

export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 240_000;

export interface ExecutionContext {
  google: AgentInputSession | null;
  signal: AbortSignal;
  attemptId: string;
  finalInferenceAttempted: boolean;
}

export function executionJson(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function executionFailure(error: unknown, context: ExecutionContext) {
  let code = 'EXECUTION_FAILED';
  let message = 'Execution did not complete. Check the saved checkpoint before retrying.';
  let status = 502;
  let stage = context.finalInferenceAttempted ? 'inference' : 'input';
  if (error instanceof AgentExecutionError || error instanceof AgentFileError || error instanceof GalileoGatewayError) {
    ({ code, message, status } = error);
    if (error instanceof AgentExecutionError) stage = error.stage;
  } else if (error instanceof z.ZodError) {
    code = 'INVALID_REQUEST';
    message = error.issues.map(issue => `${issue.path.join('.') || 'request'}: ${issue.message}`).slice(0, 10).join('; ');
    status = 400;
    stage = 'validation';
  } else if (error instanceof Error) {
    const upstreamStatus = 'status' in error && typeof error.status === 'number' ? error.status : Number(/^Gemini API (\d{3}):/.exec(error.message)?.[1]);
    if (upstreamStatus === 429) {
      code = 'UPSTREAM_RATE_LIMITED';
      message = 'The selected provider rate limit or quota was reached. Review the attempt before explicitly retrying.';
      status = 429;
    } else if (upstreamStatus === 401 || upstreamStatus === 403) {
      code = 'UPSTREAM_AUTH_FAILED';
      message = 'The provider rejected the server credentials or model permissions.';
    } else if (upstreamStatus === 400) {
      code = 'UPSTREAM_REJECTED';
      message = 'The provider rejected the model request. Check input and generation settings.';
      status = 422;
    }
  }
  if (context.signal.aborted) {
    code = context.signal.reason?.name === 'TimeoutError' ? 'REQUEST_TIMEOUT' : 'REQUEST_CANCELLED';
    message = 'The request was interrupted. Its provider outcome may be unknown; do not retry automatically.';
    status = code === 'REQUEST_TIMEOUT' ? 504 : 499;
  }
  return {
    status,
    body: {
      error: { code, message, stage, attemptId: context.attemptId,
        finalInferenceAttempted: context.finalInferenceAttempted,
        outcome: context.finalInferenceAttempted ? 'unknown' : 'not_completed',
        retryable: false,
        ...(error instanceof GalileoGatewayError ? { provider: error.diagnostics } : {}) },
    },
  };
}

export async function withExecutionAuth(request: Request, handler: (context: ExecutionContext) => Promise<Response>): Promise<Response> {
  const auth = authorizeServiceRequest(request);
  if (!auth.ok) return executionJson({ error: { code: 'API_KEY_REQUIRED', message: auth.error, stage: 'authorization', finalInferenceAttempted: false, retryable: false } }, auth.status);
  const context: ExecutionContext = {
    google: null,
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    attemptId: randomUUID(),
    finalInferenceAttempted: false,
  };
  try {
    const authorization = request.headers.get('authorization');
    if (authorization) {
      const match = /^Bearer ([^\s]+)$/i.exec(authorization);
      if (!match || match[1].length > 16384) throw new AgentExecutionError('INVALID_GOOGLE_AUTH', 'Use a Google OAuth Bearer token only for Google-backed inputs.', 401, 'authorization');
      context.google = { accessToken: match[1] };
    }
    return await handler(context);
  } catch (error) {
    const failure = executionFailure(error, context);
    return executionJson(failure.body, failure.status);
  }
}

export async function readExecutionRequest(request: Request, signal?: AbortSignal): Promise<{ raw: unknown; files: Map<string, File> }> {
  if (Number(request.headers.get('content-length')) > MAX_REQUEST_BYTES) throw new AgentExecutionError('INPUT_TOO_LARGE', 'The request exceeds 32MB.', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AgentExecutionError('INVALID_REQUEST', 'A request body is required.', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new AgentExecutionError('INPUT_TOO_LARGE', 'The request exceeds 32MB.', 413);
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  const type = request.headers.get('content-type') ?? '';
  const mimeType = type.split(';')[0].trim().toLowerCase();
  const files = new Map<string, File>();
  try {
    if (mimeType === 'application/json') return { raw: JSON.parse(bytes.toString('utf8')), files };
    if (mimeType !== 'multipart/form-data') throw new AgentExecutionError('UNSUPPORTED_CONTENT_TYPE', 'Use application/json or multipart/form-data.', 415);
    const form = await new Request(request.url, { method: 'POST', headers: { 'content-type': type }, body: bytes }).formData();
    if (form.getAll('payload').length !== 1 || typeof form.get('payload') !== 'string') throw new AgentExecutionError('INVALID_MULTIPART', 'Supply exactly one JSON payload part.', 400);
    for (const [key, value] of form.entries()) {
      if (key === 'payload') continue;
      if (!key.startsWith('file:') || !(value instanceof File) || files.has(key.slice(5))) throw new AgentExecutionError('INVALID_MULTIPART', 'File parts must have unique file:<sourceId> names.', 400);
      files.set(key.slice(5), value);
    }
    return { raw: JSON.parse(form.get('payload') as string), files };
  } catch (error) {
    if (error instanceof AgentExecutionError) throw error;
    throw new AgentExecutionError('INVALID_REQUEST', 'The JSON or multipart body is invalid.', 400);
  }
}