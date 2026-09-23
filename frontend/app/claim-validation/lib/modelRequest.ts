import { fetchWithTimeout } from '@/app/lib/fetchWithTimeout';
import { DEFAULT_API_TIMEOUT_MS } from '@/app/lib/modelConfig';

export interface ClaimModelOptions {
  signal?: AbortSignal;
  maxOutputTokens?: number;
  maxInputTokens?: number;
  strictCompletion?: boolean;
}

export interface ClaimModelMetadata {
  sentModel: string;
  reportedModel?: string;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
}

export interface ClaimModelResponse {
  modelVersion?: string;
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export class ClaimModelFailure extends Error {
  constructor(public code: string, message: string, public rawText?: string, public metadata?: ClaimModelMetadata) { super(message); }
}

export async function fetchClaimModel(endpoint: string, body: unknown, options: ClaimModelOptions): Promise<Response> {
  options.signal?.throwIfAborted();
  const serialized = JSON.stringify(body);
  if (options.strictCompletion && options.maxInputTokens && new TextEncoder().encode(serialized).byteLength + (options.maxOutputTokens ?? 0) > options.maxInputTokens) {
    throw new ClaimModelFailure('input_limit', 'The claim assessment exceeds the selected model input budget.');
  }
  const request = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: serialized };
  if (!options.strictCompletion && !options.signal) return fetchWithTimeout(endpoint, request, DEFAULT_API_TIMEOUT_MS);
  const deadline = AbortSignal.timeout(DEFAULT_API_TIMEOUT_MS);
  return fetch(endpoint, { ...request, redirect: 'error', signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline });
}

export function claimResponse(data: ClaimModelResponse, model: string, startedAt: number, options: ClaimModelOptions) {
  const candidate = data.candidates?.[0];
  const rawText = options.strictCompletion
    ? candidate?.content?.parts?.filter(part => !part.thought).map(part => part.text ?? '').join('')
    : candidate?.content?.parts?.[0]?.text;
  const metadata: ClaimModelMetadata = { sentModel: model, reportedModel: data.modelVersion, finishReason: candidate?.finishReason,
    inputTokens: data.usageMetadata?.promptTokenCount, outputTokens: data.usageMetadata?.candidatesTokenCount, durationMs: Date.now() - startedAt };
  if (options.strictCompletion && candidate?.finishReason !== 'STOP') throw new ClaimModelFailure('incomplete_claim_response', 'The claim service did not return a complete response.', rawText, metadata);
  if (!rawText?.trim()) throw new ClaimModelFailure('empty_claim_response', 'The claim service returned an empty response.', rawText, metadata);
  return { rawText, metadata };
}