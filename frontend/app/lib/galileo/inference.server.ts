import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { GalileoModelOption } from '../stepModels';
import type { StepRunDiagnostics, StepRunResponse } from '../stepExecution';
import type { GalileoGatewayConfig } from './config.server';
import { GalileoGatewayError, galileoHttpError } from './errors.server';
import { prepareGalileoInputs } from './inputs.server';

export interface GalileoMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
}

export interface GalileoInput {
  attachments?: File[];
  messages: GalileoMessage[];
  systemInstruction?: string;
  maxTokens?: number;
  temperature?: number;
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high';
  includeThoughts?: boolean;
}

export type GalileoProtocol = 'responses' | 'chat';

export function resolveGalileoProtocol(model: GalileoModelOption): GalileoProtocol {
  if (model.vendor === 'openai' && model.apiTypes.includes('responses')) return 'responses';
  if (model.apiTypes.includes('completions') || (model.provider === 'bedrock' && model.apiTypes.includes('request'))) return 'chat';
  throw new GalileoGatewayError('UNSUPPORTED_API');
}

export function resolveGalileoModelId(model: GalileoModelOption): string {
  const selected = model.provider === 'bedrock' ? model.euInferenceProfile || model.modelId
    : model.provider === 'azure-openai' ? model.modelName || model.modelAlias || model.modelId : model.modelId;
  if (!/^[a-zA-Z0-9._:/@-]{1,512}$/.test(selected) || /^(?:us|global)\./i.test(selected)) {
    throw new GalileoGatewayError('MODEL_UNAVAILABLE');
  }
  return selected;
}

export function galileoHeaders(config: GalileoGatewayConfig, model: GalileoModelOption): Record<string, string> {
  const provider = config.providerSlugs[model.provider];
  return {
    ...(config.authMode === 'portkey' ? { 'x-portkey-api-key': config.apiKey } : { Authorization: `Bearer ${config.apiKey}` }),
    ...(provider ? { 'x-portkey-provider': provider } : {}),
  };
}

export function buildGalileoRequest(model: GalileoModelOption, input: GalileoInput, attachmentBlocks: Record<string, unknown>[] = []): { path: string; body: Record<string, unknown> } {
  const protocol = resolveGalileoProtocol(model);
  const sentModel = resolveGalileoModelId(model);
  const maxTokens = input.maxTokens ?? Math.min(8192, model.maxOutputTokens ?? 8192);
  if (!input.messages.length || !input.messages.some(message => message.role === 'user' && message.text.trim()) ||
      !Number.isInteger(maxTokens) || maxTokens <= 0 || maxTokens > (model.maxOutputTokens ?? 8192) ||
      (input.temperature !== undefined && (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2))) {
    throw new GalileoGatewayError('INVALID_STEP_REQUEST');
  }
  const system = [input.systemInstruction, ...input.messages.filter(message => message.role === 'system').map(message => message.text)]
    .filter(Boolean).join('\n\n');
  const messages: Array<{ role: string; content: string | Record<string, unknown>[] }> = input.messages.filter(message => message.role !== 'system')
    .map(message => ({ role: message.role, content: message.text }));
  const textBytes = Buffer.byteLength(system + input.messages.filter(message => message.role !== 'system').map(message => message.text).join(''), 'utf8');
  if (textBytes + maxTokens > model.contextWindowTokens) throw new GalileoGatewayError('INPUT_TOO_LARGE');
  if (attachmentBlocks.length) {
    const lastUser = messages.map(message => message.role).lastIndexOf('user');
    if (lastUser < 0) throw new GalileoGatewayError('INVALID_STEP_REQUEST');
    messages[lastUser] = { role: 'user', content: [{ type: protocol === 'responses' ? 'input_text' : 'text', text: messages[lastUser].content }, ...attachmentBlocks] };
  }
  const sampling = model.supportsTemperature && input.temperature !== undefined ? { temperature: input.temperature } : {};
  const effort = input.thinkingLevel === 'minimal' ? 'low' : input.thinkingLevel;
  if (protocol === 'responses') {
    return {
      path: '/responses', body: {
        model: sentModel, input: messages, ...(system ? { instructions: system } : {}),
        max_output_tokens: maxTokens, store: false, stream: false, truncation: 'disabled', ...sampling,
        ...(model.supportsReasoning && (effort || input.includeThoughts) ? { reasoning: {
          ...(effort ? { effort } : {}), ...(input.includeThoughts ? { summary: 'auto' } : {}),
        } } : {}),
      },
    };
  }
  return {
    path: '/chat/completions', body: {
      model: sentModel, messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
      ...(model.vendor === 'claude' ? { max_tokens: maxTokens } : { max_completion_tokens: maxTokens }),
      stream: false, ...sampling,
      ...(model.supportsReasoning && effort ? { reasoning_effort: effort } : {}),
    },
  };
}

const chatSchema = z.object({
  model: z.string().max(512).optional(),
  choices: z.array(z.object({
    finish_reason: z.string().nullable(),
    message: z.object({ role: z.literal('assistant'), content: z.string().nullable(), refusal: z.string().nullable().optional() }),
  })).min(1),
  usage: z.object({ prompt_tokens: z.number().nonnegative().optional(), completion_tokens: z.number().nonnegative().optional() }).optional(),
});
const responseSchema = z.object({
  status: z.string(), model: z.string().max(512).optional(),
  output: z.array(z.object({
    type: z.string(), role: z.string().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    summary: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  })),
  usage: z.object({ input_tokens: z.number().nonnegative().optional(), output_tokens: z.number().nonnegative().optional() }).optional(),
});

export function parseGalileoResponse(raw: unknown, protocol: GalileoProtocol) {
  if (!raw || typeof raw !== 'object' || ('error' in raw && raw.error != null)) throw new GalileoGatewayError('UPSTREAM_RESPONSE_INVALID');
  if (protocol === 'chat') {
    const parsed = chatSchema.safeParse(raw);
    if (!parsed.success) throw new GalileoGatewayError('UPSTREAM_RESPONSE_INVALID');
    const choice = parsed.data.choices[0];
    if (choice.finish_reason === 'length') throw new GalileoGatewayError('UPSTREAM_TRUNCATED');
    if (choice.message.refusal || choice.finish_reason === 'content_filter' || choice.finish_reason === 'guardrail_intervened') {
      throw new GalileoGatewayError('UPSTREAM_REFUSED');
    }
    if (choice.finish_reason !== 'stop' || !choice.message.content?.trim()) throw new GalileoGatewayError('UPSTREAM_RESPONSE_INVALID');
    return { text: choice.message.content, model: parsed.data.model, reasoning: undefined,
      inputTokens: parsed.data.usage?.prompt_tokens, outputTokens: parsed.data.usage?.completion_tokens };
  }
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) throw new GalileoGatewayError('UPSTREAM_RESPONSE_INVALID');
  const data = parsed.data;
  if (data.output.some(item => item.content?.some(part => part.type === 'refusal'))) throw new GalileoGatewayError('UPSTREAM_REFUSED');
  if (data.status === 'incomplete') throw new GalileoGatewayError('UPSTREAM_TRUNCATED');
  if (data.status !== 'completed') throw new GalileoGatewayError('UPSTREAM_RESPONSE_INVALID');
  const text = data.output.filter(item => item.type === 'message' && item.role === 'assistant')
    .flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text ?? '').join('\n');
  if (!text.trim()) throw new GalileoGatewayError('UPSTREAM_RESPONSE_INVALID');
  const reasoning = data.output.filter(item => item.type === 'reasoning').flatMap(item => item.summary ?? [])
    .filter(part => part.type === 'summary_text').map(part => part.text ?? '').join('\n') || undefined;
  return { text, model: data.model, reasoning, inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens };
}

export async function runGalileoInference(config: GalileoGatewayConfig, model: GalileoModelOption, input: GalileoInput, signal?: AbortSignal): Promise<StepRunResponse> {
  const startedAt = new Date().toISOString();
  const diagnostics: StepRunDiagnostics = {
    runId: randomUUID(), source: 'server', backend: 'galileo', selectedModel: model.value,
    provider: model.provider, modelId: model.modelId, region: 'eu', stage: 'input', status: 'failed',
    startedAt, completedAt: startedAt, durationMs: 0, inferenceAttempted: false, upstreamResponded: false,
  };
  const controller = new AbortController();
  const uploadedIds: string[] = [];
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    if (!config.enabled) throw new GalileoGatewayError('FEATURE_DISABLED');
    const protocol = resolveGalileoProtocol(model);
    diagnostics.endpoint = config.baseUrl;
    diagnostics.protocol = protocol;
    diagnostics.routingProvider = config.providerSlugs[model.provider];
    buildGalileoRequest(model, input);
    const prepared = await prepareGalileoInputs(model, input, protocol, combinedSignal);
    buildGalileoRequest(model, prepared.input);
    const attachmentBlocks: Record<string, unknown>[] = [];
    for (const attachment of prepared.attachments) {
      combinedSignal.throwIfAborted();
      if (protocol === 'responses') {
        const form = new FormData();
        form.append('file', attachment.file);
        form.append('purpose', 'assistants');
        const uploaded = await fetch(`${config.baseUrl}/files`, {
          method: 'POST', headers: galileoHeaders(config, model), body: form,
          cache: 'no-store', redirect: 'error', signal: combinedSignal,
        });
        if (!uploaded.ok) {
          await uploaded.body?.cancel();
          throw galileoHttpError(uploaded.status);
        }
        const uploadedFile = await uploaded.json() as { id?: unknown };
        if (typeof uploadedFile.id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(uploadedFile.id) || uploadedFile.id.includes(config.apiKey)) {
          throw new GalileoGatewayError('UPSTREAM_RESPONSE_INVALID');
        }
        uploadedIds.push(uploadedFile.id);
        diagnostics.uploadedFileCount = uploadedIds.length;
        attachmentBlocks.push({ type: attachment.kind === 'image' ? 'input_image' : 'input_file', file_id: uploadedFile.id });
      } else {
        const data = Buffer.from(await attachment.file.arrayBuffer()).toString('base64');
        attachmentBlocks.push({ type: 'image_url', image_url: { url: `data:${attachment.file.type};base64,${data}` } });
      }
    }
    const request = buildGalileoRequest(model, prepared.input, attachmentBlocks);
    combinedSignal.throwIfAborted();
    diagnostics.stage = 'inference';
    diagnostics.sentModel = resolveGalileoModelId(model);
    diagnostics.inferenceAttempted = true;
    const response = await fetch(`${config.baseUrl}${request.path}`, {
      method: 'POST', headers: { ...galileoHeaders(config, model), 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body), cache: 'no-store', redirect: 'error', signal: combinedSignal,
    });
    diagnostics.upstreamResponded = true;
    diagnostics.upstreamStatus = response.status;
    const requestId = response.headers.get('x-request-id') || response.headers.get('x-portkey-trace-id') || response.headers.get('x-amzn-requestid');
    if (requestId && /^[a-zA-Z0-9._:/-]{1,256}$/.test(requestId) && !requestId.includes(config.apiKey)) diagnostics.upstreamRequestId = requestId;
    if (!response.ok) {
      await response.body?.cancel();
      throw galileoHttpError(response.status);
    }
    let raw: unknown;
    try { raw = await response.json(); } catch { throw new GalileoGatewayError('UPSTREAM_RESPONSE_INVALID'); }
    combinedSignal.throwIfAborted();
    const parsed = parseGalileoResponse(raw, resolveGalileoProtocol(model));
    if (parsed.model) {
      const reported = parsed.model.replace(/^@[^/]+\//, '');
      const accepted = [diagnostics.sentModel, model.modelId, model.modelName, model.modelAlias, model.euInferenceProfile].filter(Boolean);
      if (!accepted.includes(reported)) throw new GalileoGatewayError('UPSTREAM_MODEL_MISMATCH');
      diagnostics.reportedModel = parsed.model.includes(config.apiKey) ? undefined : parsed.model;
    }
    diagnostics.status = 'succeeded';
    diagnostics.inputTokens = parsed.inputTokens;
    diagnostics.outputTokens = parsed.outputTokens;
    return { response: parsed.text, reasoning: input.includeThoughts ? parsed.reasoning : undefined, runDiagnostics: diagnostics };
  } catch (error) {
    const failure = signal?.aborted ? new GalileoGatewayError('REQUEST_CANCELLED')
      : timedOut ? new GalileoGatewayError('UPSTREAM_TIMEOUT')
        : error instanceof GalileoGatewayError ? error : new GalileoGatewayError('UPSTREAM_UNREACHABLE');
    diagnostics.errorCode = failure.code;
    diagnostics.status = failure.code === 'REQUEST_CANCELLED' ? 'cancelled' : 'failed';
    failure.diagnostics = diagnostics;
    throw failure;
  } finally {
    clearTimeout(timer);
    for (const fileId of uploadedIds) {
      try {
        const deleted = await fetch(`${config.baseUrl}/files/${encodeURIComponent(fileId)}`, {
          method: 'DELETE', headers: galileoHeaders(config, model), redirect: 'error',
          signal: AbortSignal.timeout(10000), cache: 'no-store',
        });
        if (!deleted.ok && deleted.status !== 404) diagnostics.fileCleanupFailed = true;
        await deleted.body?.cancel();
      } catch { diagnostics.fileCleanupFailed = true; }
    }
    diagnostics.completedAt = new Date().toISOString();
    diagnostics.durationMs = Math.max(0, Date.parse(diagnostics.completedAt) - Date.parse(startedAt));
    console.info('[Galileo invocation]', {
      runId: diagnostics.runId, provider: diagnostics.provider, status: diagnostics.status,
      stage: diagnostics.stage, code: diagnostics.errorCode, durationMs: diagnostics.durationMs,
      upstreamStatus: diagnostics.upstreamStatus, inferenceAttempted: diagnostics.inferenceAttempted,
    });
  }
}