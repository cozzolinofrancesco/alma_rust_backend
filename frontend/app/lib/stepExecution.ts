import { z } from 'zod';
import type { DebugAnswerSupport, DebugSourceChunk } from './answerDebug';
import { isGalileoModel } from './stepModels';

const diagnosticsSchema = z.object({
  runId: z.string().max(128).optional(),
  source: z.enum(['server', 'client']),
  backend: z.literal('galileo'),
  selectedModel: z.string().max(512),
  provider: z.enum(['openai', 'bedrock', 'azure-openai']).optional(),
  modelId: z.string().max(512).optional(),
  region: z.literal('eu'),
  stage: z.enum(['authorization', 'catalog', 'configuration', 'input', 'retrieval', 'inference', 'client']),
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number().finite().nonnegative(),
  inferenceAttempted: z.boolean().optional(),
  upstreamResponded: z.boolean().optional(),
  sentModel: z.string().max(512).optional(),
  reportedModel: z.string().max(512).optional(),
  upstreamRequestId: z.string().max(256).optional(),
  upstreamStatus: z.number().int().optional(),
  endpoint: z.string().max(512).optional(),
  protocol: z.enum(['responses', 'chat']).optional(),
  routingProvider: z.string().max(128).optional(),
  inputTokens: z.number().finite().nonnegative().optional(),
  outputTokens: z.number().finite().nonnegative().optional(),
  uploadedFileCount: z.number().int().nonnegative().optional(),
  fileCleanupFailed: z.boolean().optional(),
  retrieval: z.object({
    model: z.string().max(512).optional(), durationMs: z.number().finite().nonnegative(), sourceCount: z.number().int().nonnegative(),
  }).optional(),
  errorCode: z.string().max(100).optional(),
});

export type StepRunDiagnostics = z.infer<typeof diagnosticsSchema>;

export function parseStepRunDiagnostics(value: unknown): StepRunDiagnostics | undefined {
  const parsed = diagnosticsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export interface StepRunResponse {
  ready?: boolean;
  response?: string;
  isGrounded?: boolean;
  groundingChunks?: unknown[];
  sources?: DebugSourceChunk[];
  supports?: DebugAnswerSupport[];
  reasoning?: string | null;
  error?: string;
  code?: string;
  runDiagnostics?: StepRunDiagnostics;
}

export class StepRunError extends Error {
  constructor(message: string, readonly diagnostics?: StepRunDiagnostics, readonly code?: string) {
    super(message);
    this.name = 'StepRunError';
  }
}

export function isStepSessionFailure(error: unknown): boolean {
  if (error instanceof StepRunError && error.code) return error.code === 'SESSION_REQUIRED';
  return error instanceof Error && /401|authentication|unauthorized/i.test(error.message);
}

export function getStepEndpoint(model: unknown, corpus = false): string {
  return corpus ? '/api/rag/query' : isGalileoModel(model) ? '/api/galileo' : '/api/gemini';
}

export function getGalileoGenerationSettings(model: unknown, settings: { maxTokens?: unknown; temperature?: unknown }) {
  if (!isGalileoModel(model)) return {};
  return {
    ...(typeof settings.maxTokens === 'number' ? { maxTokens: settings.maxTokens } : {}),
    ...(typeof settings.temperature === 'number' ? { temperature: settings.temperature } : {}),
  };
}

export async function assertStepModelReady(model: string, signal?: AbortSignal): Promise<void> {
  if (!isGalileoModel(model)) return;
  const response = await fetch(`/api/galileo?model=${encodeURIComponent(model)}`, { cache: 'no-store', signal });
  const data = await readStepRunResponse(response, true);
  if (data.ready !== true) {
    throw new StepRunError('Galileo gateway readiness was not confirmed.', data.runDiagnostics, 'GATEWAY_NOT_CONFIGURED');
  }
}

export async function readStepRunResponse(response: Response, allowEmpty = false, expectedModel?: string): Promise<StepRunResponse> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new StepRunError(`Step API returned an unreadable response (HTTP ${response.status}).`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StepRunError('Step API returned an invalid response.');
  }
  const data = raw as StepRunResponse;
  const diagnostics = parseStepRunDiagnostics(data.runDiagnostics);
  if (!response.ok || data.error != null || diagnostics?.status === 'failed' || diagnostics?.status === 'cancelled') {
    throw new StepRunError(
      typeof data.error === 'string' && data.error ? data.error : `Step API request failed (HTTP ${response.status}).`,
      diagnostics,
      typeof data.code === 'string' ? data.code : undefined,
    );
  }
  if (!allowEmpty && (typeof data.response !== 'string' || !data.response.trim())) {
    throw new StepRunError('No response from the selected model.',
      diagnostics ? { ...diagnostics, status: 'failed', errorCode: 'EMPTY_RESPONSE' } : undefined, 'EMPTY_RESPONSE');
  }
  if (isGalileoModel(expectedModel) && (!diagnostics || diagnostics.source !== 'server' ||
      diagnostics.selectedModel !== expectedModel || diagnostics.status !== 'succeeded' ||
      diagnostics.inferenceAttempted !== true || diagnostics.upstreamResponded !== true || !diagnostics.sentModel)) {
    throw new StepRunError('The server did not confirm execution of the selected Galileo model.', undefined, 'RUN_UNCONFIRMED');
  }
  return { ...data, runDiagnostics: diagnostics };
}

export function getStepFailureDiagnostics(error: unknown, selectedModel: string, startedAt: string): StepRunDiagnostics | undefined {
  if (!isGalileoModel(selectedModel)) return undefined;
  if (error instanceof StepRunError && error.diagnostics) return error.diagnostics;
  const completedAt = new Date().toISOString();
  const cancelled = error instanceof Error && error.name === 'AbortError';
  return {
    source: 'client', backend: 'galileo', selectedModel, region: 'eu', stage: 'client',
    status: cancelled ? 'cancelled' : 'failed', startedAt, completedAt,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    errorCode: cancelled ? 'CLIENT_CANCELLED' : 'RUN_UNCONFIRMED',
  };
}