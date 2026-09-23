import { NextResponse } from 'next/server';
import { getGalileoCatalog } from './catalog.server';
import { isGalileoModel } from '../stepModels';
import { readGalileoConfig, GalileoConfigurationError } from './config.server';
import { resolveGalileoModelId, resolveGalileoProtocol } from './inference.server';
import { attachGalileoFailureDiagnostics, galileoErrorResponse, GalileoGatewayError, type GalileoErrorCode } from './errors.server';
import type { StepRunDiagnostics } from '../stepExecution';

export function galileoFailureResponse(code: GalileoErrorCode, selectedModel?: unknown) {
  const stage = code === 'SESSION_REQUIRED' ? 'authorization' : code === 'INVALID_STEP_REQUEST' ? 'input' : 'configuration';
  const error = attachGalileoFailureDiagnostics(new GalileoGatewayError(code), selectedModel, stage);
  return galileoErrorResponse(error);
}

export async function resolveGalileoContext(selectedModel: unknown) {
  const startedAt = new Date().toISOString();
  let stage: StepRunDiagnostics['stage'] = 'input';
  try {
    if (typeof selectedModel !== 'string' || !isGalileoModel(selectedModel) || !/^[a-zA-Z0-9:._/-]{1,512}$/.test(selectedModel)) {
      throw new GalileoGatewayError('INVALID_STEP_REQUEST');
    }
    stage = 'configuration';
    if (process.env.GALILEO_ENABLED !== 'true') throw new GalileoGatewayError('FEATURE_DISABLED');
    const config = readGalileoConfig();
    stage = 'catalog';
    const catalog = await getGalileoCatalog();
    if (catalog.state === 'unavailable') throw new GalileoGatewayError('CATALOG_UNAVAILABLE');
    const model = catalog.models.find(candidate => candidate.value === selectedModel);
    if (!model) throw new GalileoGatewayError('MODEL_UNAVAILABLE');
    resolveGalileoProtocol(model);
    resolveGalileoModelId(model);
    return { config, model };
  } catch (error) {
    const failure = error instanceof GalileoGatewayError ? error : new GalileoGatewayError(
      error instanceof GalileoConfigurationError ? 'GATEWAY_NOT_CONFIGURED' : 'CATALOG_UNAVAILABLE');
    attachGalileoFailureDiagnostics(failure, selectedModel, stage, startedAt);
    throw failure;
  }
}

export async function galileoPreflightResponse(selectedModel: unknown) {
  try {
    const { config, model } = await resolveGalileoContext(selectedModel);
    return NextResponse.json({ ready: true, model: model.value, endpoint: config.baseUrl, verified: false }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return galileoErrorResponse(error as GalileoGatewayError);
  }
}