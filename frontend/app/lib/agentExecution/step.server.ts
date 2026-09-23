import { executeAgentInputStep, prepareAgentInputDocuments } from '../agentInputsExecution.server';
import { buildReferencedStepsContext, buildStepMessagesPayload } from '../stepPrompt';
import { recordAgentOutput } from '../agentOutputHistory';
import { DEFAULT_MODEL, isImageModel } from '../modelConfig';
import { generateImageContent } from '../imageGeneration.server';
import { deleteGeminiFile, uploadFileToGeminiFilesAPI } from '../geminiFiles.server';
import { buildEffectiveStepInputs, type StepCorpusInput } from '../agentInputs';
import type { ExecutionContext } from './http.server';
import { AgentExecutionError } from './errors';
import { hashBytes, hashValue } from './hash.server';
import { imageUrlSchema, outputVersionSchema, stepExecuteSchema, type ExecutionSource } from './schema';
import { validateExecutableLayer } from './validation';

export async function resolveSuppliedFiles(sources: ExecutionSource[], files: Map<string, File>, signal?: AbortSignal) {
  const seen = new Set<string>();
  const resolved: File[] = [];
  for (const source of sources) {
    signal?.throwIfAborted();
    if (seen.has(source.sourceId)) throw new AgentExecutionError('DUPLICATE_SOURCE', 'Source IDs must be unique.');
    seen.add(source.sourceId);
    if (source.kind === 'text') {
      if (files.has(source.sourceId)) throw new AgentExecutionError('UNEXPECTED_FILE', 'A text source must not also have a file part.');
      resolved.push(new File([source.text], source.name.endsWith('.txt') ? source.name : `${source.name}.txt`, { type: 'text/plain' }));
    } else {
      const file = files.get(source.sourceId);
      if (!file) throw new AgentExecutionError('MISSING_SOURCE', `Supply file:${source.sourceId}.`);
      if (file.name !== source.name || file.type !== source.mimeType || hashBytes(new Uint8Array(await file.arrayBuffer())) !== source.sha256) {
        throw new AgentExecutionError('SOURCE_MISMATCH', `File ${source.sourceId} does not match its name, type or SHA-256.`, 409);
      }
      resolved.push(file);
    }
  }
  if (Array.from(files.keys()).some(key => !seen.has(key))) throw new AgentExecutionError('UNEXPECTED_FILE', 'Every uploaded file must be bound to this step.');
  return resolved;
}

export async function executePortableStep(raw: unknown, files: Map<string, File>, context: ExecutionContext) {
  const input = stepExecuteSchema.parse(raw);
  context.attemptId = input.attemptId ?? context.attemptId;
  const { step } = input;
  validateExecutableLayer(step);
  for (const reference of step.referencedSteps) {
    if (reference === step.id || !input.previousOutputs[reference]) throw new AgentExecutionError('MISSING_PREREQUISITE', `Supply a pinned upstream output for ${reference}.`);
  }
  const referenceContext = buildReferencedStepsContext(step.referencedSteps, {
    getName: reference => input.referenceNames[reference] ?? reference,
    getResult: reference => input.previousOutputs[reference]?.result,
  });
  if (referenceContext.truncated) throw new AgentExecutionError('REFERENCE_CONTEXT_TOO_LARGE', 'Referenced outputs exceed the supported context limit.');
  const supplied = await resolveSuppliedFiles(input.sources, files, context.signal);
  const localCorpusIds = new Set([...(step.corpusId ? [step.corpusId] : []),
    ...(step.ragKnowledge ?? []).filter(source => /^(?:filesearch-|fileSearchStores\/)/.test(source.id)).map(source => source.id)]);
  if (!localCorpusIds.size && (step.documentSelections?.length || step.metadataFilter)) throw new AgentExecutionError('UNBOUND_DOCUMENT_SELECTION', 'Bind document selections to an explicit step corpus.');
  const localCorpora: StepCorpusInput[] = Array.from(localCorpusIds, corpusId => ({ corpusId,
    documentSelections: step.documentSelections, metadataFilter: step.metadataFilter }));
  const effective = buildEffectiveStepInputs({ files: [], corpusRefs: input.corpora }, [], localCorpora);
  const model = step.selectedModel ?? DEFAULT_MODEL;
  const suppliedImages = isImageModel(model) ? supplied.filter(file => file.type.startsWith('image/')) : [];
  if (isImageModel(model) && (suppliedImages.length > 1 || step.thinkingLevel || step.includeThoughts)) throw new AgentExecutionError('UNSUPPORTED_IMAGE_SETTINGS', 'Image steps accept one supplied base image and do not support thinking settings.');
  if (suppliedImages.length) await prepareAgentInputDocuments(supplied, context.signal);
  const prompt = buildStepMessagesPayload(step, referenceContext.text, input.skills.map(skill => skill.text));
  const generationInput = {
    ...prompt, model, agentInputs: { corpora: effective.corpora }, projectId: input.projectId,
    ragKnowledge: step.ragKnowledge, maxTokens: step.maxTokens, temperature: step.temperature,
    thinkingLevel: step.thinkingLevel, includeThoughts: step.includeThoughts,
  };
  const startedAt = new Date().toISOString();
  let temporaryFileCleanupFailed = false;
  const promptFiles = suppliedImages.length ? supplied.filter(file => !suppliedImages.includes(file)) : supplied;
  const result = await executeAgentInputStep(generationInput, promptFiles, context.google, context.signal, uploadFileToGeminiFilesAPI, deleteGeminiFile,
    () => { context.finalInferenceAttempted = true; }, { singleAttempt: true, includeMetadata: true,
      onCleanupFailure: () => { temporaryFileCleanupFailed = true; } });
  let text = 'response' in result ? result.response ?? '' : '';
  let imageUrls: string[] = [];
  if (isImageModel(model)) {
    if (!('preparedPrompt' in result) || !result.preparedPrompt) throw new AgentExecutionError('IMAGE_PROMPT_MISSING', 'The image prompt was not prepared.', 502, 'inference');
    const referenceImage = step.referencedSteps.flatMap(reference => input.previousOutputs[reference]?.imageUrls ?? [])[0];
    const parsed = referenceImage ? /^data:(image\/[a-z]+);base64,(.+)$/.exec(referenceImage) : null;
    const baseImage = suppliedImages[0] ? { mimeType: suppliedImages[0].type, data: Buffer.from(await suppliedImages[0].arrayBuffer()).toString('base64') }
      : parsed ? { mimeType: parsed[1], data: parsed[2] } : undefined;
    context.finalInferenceAttempted = true;
    const generated = await generateImageContent(result.preparedPrompt, model, baseImage, context.signal,
      { singleAttempt: true, maxTokens: step.maxTokens, temperature: step.temperature });
    imageUrls = generated.images.map(image => imageUrlSchema.parse(`data:${image.mimeType};base64,${image.data}`));
    if (!imageUrls.length) throw new AgentExecutionError('EMPTY_IMAGE_RESPONSE', 'The selected image model did not return an image.', 502, 'inference');
    text = generated.text ?? '';
  }
  context.signal.throwIfAborted();
  const completedAt = new Date().toISOString();
  const updatedStep = recordAgentOutput(step, { result: text, imageUrls }, completedAt);
  const output = outputVersionSchema.parse(updatedStep.outputHistory[updatedStep.outputHistory.length - 1]);
  return {
    schemaVersion: 1 as const, status: 'succeeded' as const, stepId: step.id, attemptId: context.attemptId,
    output, updatedStep, sources: result.sources,
    responseMetadata: { ...('supports' in result ? { supports: result.supports } : {}),
      ...('reasoning' in result && input.step.includeThoughts ? { reasoning: result.reasoning } : {}) },
    diagnostics: { selectedModel: model, startedAt, completedAt, finalInferenceAttempted: context.finalInferenceAttempted,
      temporaryFileCleanupFailed,
      inputHash: hashValue({ generationInput, sources: input.sources, previousOutputs: input.previousOutputs }),
      retrievalHash: hashValue(result.sources),
      sourceMode: result.sources.length ? 'retrieved' : supplied.length ? 'attached' : 'none',
      ...('runDiagnostics' in result ? { provider: result.runDiagnostics } : {}),
      ...('generationMetadata' in result ? { generation: result.generationMetadata } : {}) },
  };
}