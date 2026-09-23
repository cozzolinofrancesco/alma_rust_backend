import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import type { StepRunDiagnostics } from '../stepExecution';

const errors = {
  SESSION_REQUIRED: [401, 'Sign in before running this step.'],
  FEATURE_DISABLED: [503, 'Galileo is disabled. Enable GALILEO_ENABLED in server configuration when ready to test the gateway.'],
  GATEWAY_NOT_CONFIGURED: [503, 'The Galileo EU gateway configuration is missing or invalid. Check the server endpoint, key and provider routing settings.'],
  MODEL_UNAVAILABLE: [400, 'The selected model is not in the active EU OpenAI/Claude catalog.'],
  CATALOG_UNAVAILABLE: [503, 'The Galileo model catalog is unavailable. No inference request was sent.'],
  UNSUPPORTED_API: [400, 'This model does not advertise an API supported by the Galileo adapter.'],
  INVALID_STEP_REQUEST: [400, 'The step request is invalid. Check messages, model and generation settings.'],
  UNSUPPORTED_INPUT: [400, 'An attached file is not supported by this model or gateway protocol.'],
  INPUT_TOO_LARGE: [413, 'The step input exceeds the allowed file or model context limit. Reduce the input or use a corpus.'],
  UNREADABLE_DOCUMENT: [400, 'A document has no usable text layer and this model cannot accept it natively.'],
  SOURCE_ACCESS_DENIED: [403, 'The selected sources could not be read with your current session.'],
  NO_RETRIEVED_PASSAGES: [422, 'No usable corpus passages were retrieved. The selected Galileo model was not invoked.'],
  RETRIEVAL_FAILED: [502, 'Corpus retrieval failed before Galileo generation. Check the corpus and document selection.'],
  UPSTREAM_AUTH_FAILED: [502, 'Galileo rejected the gateway credentials or model permissions. Check the server key and workspace access.'],
  UPSTREAM_MODEL_UNAVAILABLE: [502, 'Galileo could not route to the selected model. Check the provider slug, model mapping and EU access.'],
  UPSTREAM_RATE_LIMITED: [429, 'The Galileo gateway rate limit or quota was reached.'],
  UPSTREAM_REJECTED: [502, 'The Galileo gateway rejected the model request. Check supported parameters and provider configuration.'],
  UPSTREAM_UNREACHABLE: [502, 'The Galileo gateway could not be reached. Check deployed network access, DNS and TLS.'],
  UPSTREAM_TIMEOUT: [504, 'The Galileo request timed out. The provider may still have processed it; check the gateway logs before retrying.'],
  UPSTREAM_RESPONSE_INVALID: [502, 'Galileo returned an invalid or empty model response.'],
  UPSTREAM_MODEL_MISMATCH: [502, 'The model reported by the gateway did not match the selected model. No replacement output was saved.'],
  UPSTREAM_INVALID_CITATION: [502, 'The generated answer cited a source that was not supplied. No replacement output was saved.'],
  UPSTREAM_TRUNCATED: [502, 'The model stopped at its output limit. Increase the output budget or reduce the requested answer.'],
  UPSTREAM_REFUSED: [422, 'The model or gateway declined the request.'],
  REQUEST_CANCELLED: [499, 'The Galileo request was cancelled.'],
} as const;

export type GalileoErrorCode = keyof typeof errors;

export class GalileoGatewayError extends Error {
  readonly status: number;
  diagnostics?: StepRunDiagnostics;
  constructor(readonly code: GalileoErrorCode) {
    super(errors[code][1]);
    this.name = 'GalileoGatewayError';
    this.status = errors[code][0];
  }
}

export function galileoHttpError(status: number): GalileoGatewayError {
  if (status === 401 || status === 403) return new GalileoGatewayError('UPSTREAM_AUTH_FAILED');
  if (status === 404) return new GalileoGatewayError('UPSTREAM_MODEL_UNAVAILABLE');
  if (status === 429) return new GalileoGatewayError('UPSTREAM_RATE_LIMITED');
  return new GalileoGatewayError('UPSTREAM_REJECTED');
}

export function galileoErrorResponse(error: GalileoGatewayError) {
  return NextResponse.json({ error: error.message, code: error.code, runDiagnostics: error.diagnostics }, {
    status: error.status, headers: { 'Cache-Control': 'no-store' },
  });
}

export function attachGalileoFailureDiagnostics(error: GalileoGatewayError, selectedModel: unknown,
  stage: StepRunDiagnostics['stage'], startedAt = new Date().toISOString()): GalileoGatewayError {
  if (error.diagnostics) return error;
  const completedAt = new Date().toISOString();
  error.diagnostics = {
    runId: randomUUID(), source: 'server', backend: 'galileo', region: 'eu',
    selectedModel: typeof selectedModel === 'string' && /^[a-zA-Z0-9:._/-]{1,512}$/.test(selectedModel) ? selectedModel : 'galileo:invalid',
    stage, status: error.code === 'REQUEST_CANCELLED' ? 'cancelled' : 'failed', startedAt, completedAt,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    inferenceAttempted: false, upstreamResponded: false, errorCode: error.code,
  };
  return error;
}