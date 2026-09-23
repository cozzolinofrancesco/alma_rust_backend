import { NextResponse } from 'next/server';
import { resolveGalileoContext } from './preflight.server';
import { parseGalileoStepRequest } from './stepRequest.server';
import { runGalileoInference } from './inference.server';
import { attachGalileoFailureDiagnostics, galileoErrorResponse, GalileoGatewayError } from './errors.server';
import type { GalileoSourceSession } from './sources.server';

export async function galileoStepResponse(raw: unknown, files: File[], session: GalileoSourceSession | null, signal?: AbortSignal) {
  if (raw && typeof raw === 'object' && 'agentInputs' in raw) {
    return (await import('../agentInputsExecution.server')).agentInputStepResponse(raw, files, session, signal);
  }
  const selectedModel = raw && typeof raw === 'object' && 'model' in raw ? raw.model : undefined;
  try {
    const { config, model } = await resolveGalileoContext(selectedModel);
    const input = { ...parseGalileoStepRequest(raw), attachments: files };
    const hasSources = Boolean(input.corpusId || input.corpusIds?.length || input.ragKnowledge?.length);
    const result = hasSources
      ? await (await import('./sources.server')).runGalileoWithSources(config, model, input, session, signal)
      : await runGalileoInference(config, model, input, signal);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const failure = error instanceof GalileoGatewayError ? error : new GalileoGatewayError('INVALID_STEP_REQUEST');
    return galileoErrorResponse(attachGalileoFailureDiagnostics(failure, selectedModel, 'input'));
  }
}