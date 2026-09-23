import { randomUUID } from 'node:crypto';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { executionFailure, executionJson, readExecutionRequest, REQUEST_TIMEOUT_MS, withExecutionAuth, type ExecutionContext } from '@/app/lib/agentExecution/http.server';
import { runValidationAnalysis } from '@/app/lib/validationAnalysis/analysis.server';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request: Request) {
  const run = async (context: ExecutionContext) => {
    const { raw, files } = await readExecutionRequest(request, context.signal);
    return executionJson(await runValidationAnalysis(raw, files, context));
  };
  if (request.headers.has('x-api-key')) return withExecutionAuth(request, run);
  const session = await getApiSession(request);
  if (!session?.accessToken) return executionJson({ error: { code: 'UNAUTHORIZED', message: 'Sign in or supply an API key.' } }, 401);
  const context: ExecutionContext = { google: session, signal: AbortSignal.any([request.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]), attemptId: randomUUID(), finalInferenceAttempted: false };
  try { return await run(context); }
  catch (error) { const failure = executionFailure(error, context); return executionJson(failure.body, failure.status); }
}