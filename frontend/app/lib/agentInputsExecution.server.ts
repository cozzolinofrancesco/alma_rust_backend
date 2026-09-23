import { NextResponse } from 'next/server';
import { addAgentInputEvidence, parseAgentStepRequest, retrieveAgentInputEvidence, type AgentInputSession } from './agentInputs.server';
import { AgentFileError } from './agentFiles-gdrive';
import { agentTextExtensions, isAgentFileSupported } from './agentFiles';
import { MAX_FILE_SIZE_BYTES } from './fileValidation';
import { geminiChatWithGrounding, type ChatMessage } from './gemini';
import { getModelInfo, isImageModel } from './modelConfig';
import { isGalileoModel } from './stepModels';
import { resolveGalileoContext } from './galileo/preflight.server';
import { runGalileoInference } from './galileo/inference.server';
import { attachGalileoFailureDiagnostics, galileoErrorResponse, GalileoGatewayError } from './galileo/errors.server';

const binaryMimes = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'audio/mpeg', 'audio/wav', 'audio/mp4', 'video/mp4', 'video/webm', 'video/quicktime']);

export async function prepareAgentInputDocuments(files: File[], signal?: AbortSignal) {
  if (files.length > 5 || files.reduce((size, file) => size + file.size, 0) > MAX_FILE_SIZE_BYTES) {
    throw new AgentFileError('INPUT_TOO_LARGE', 'Use at most five combined files, up to 30MB in total.', 413);
  }
  const textDocuments: Array<{ name: string; text: string }> = [];
  const binaryFiles: File[] = [];
  let pages = 0;
  for (const file of files) {
    signal?.throwIfAborted();
    if (!file.size) throw new AgentFileError('UNREADABLE_DOCUMENT', `File "${file.name}" is empty.`, 422);
    const extension = file.name.toLowerCase().split('.').pop() ?? '';
    if (agentTextExtensions.has(extension) && isAgentFileSupported(file.type, file.name)) {
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
      catch { throw new AgentFileError('UNREADABLE_DOCUMENT', `File "${file.name}" is not valid UTF-8 text.`, 422); }
      if (!text.trim() || text.includes('\0')) throw new AgentFileError('UNREADABLE_DOCUMENT', `File "${file.name}" is not a readable text document.`, 422);
      textDocuments.push({ name: file.name, text });
      continue;
    }
    const mimeType = file.type || (extension === 'pdf' ? 'application/pdf' : '');
    if (!binaryMimes.has(mimeType)) throw new AgentFileError('UNSUPPORTED_INPUT', `The selected input format for "${file.name}" is not supported.`);
    if (mimeType === 'application/pdf') {
      try {
        const { PDFDocument } = await import('pdf-lib');
        const document = await PDFDocument.load(await file.arrayBuffer());
        pages += document.getPageCount();
      } catch { throw new AgentFileError('UNREADABLE_DOCUMENT', `PDF "${file.name}" is invalid or encrypted.`, 422); }
      if (pages > 1000) throw new AgentFileError('INPUT_TOO_LARGE', 'Combined PDFs exceed the 1000-page limit. Remove a file or use RAG explicitly.', 413);
    }
    binaryFiles.push(file.type ? file : new File([file], file.name, { type: mimeType }));
  }
  return { textDocuments, binaryFiles };
}

export async function executeAgentInputStep(
  raw: unknown,
  files: File[],
  session: AgentInputSession | null,
  signal?: AbortSignal,
  uploadFile?: (file: File, signal?: AbortSignal) => Promise<string>,
  cleanupFile?: (uri: string) => Promise<void>,
  onInference?: () => void,
  options?: { singleAttempt?: boolean; includeMetadata?: boolean; onCleanupFailure?: () => void },
) {
  const uploaded: string[] = [];
  let selectedModel: string | undefined;
  try {
    const input = parseAgentStepRequest(raw);
    selectedModel = input.model;
    const galileo = isGalileoModel(input.model) ? await resolveGalileoContext(input.model) : null;
    if (!galileo && !isImageModel(input.model) && !getModelInfo(input.model)?.maxInputTokens) {
      throw new AgentFileError('UNSUPPORTED_MODEL', 'Choose a model with a known input limit for shared files.');
    }
    if (galileo && files.length && !galileo.model.supportsAttachments) throw new AgentFileError('UNSUPPORTED_INPUT', 'This model does not support attached files.');
    const prepared = await prepareAgentInputDocuments(files, signal);
    if (isImageModel(input.model) && prepared.binaryFiles.length) {
      throw new AgentFileError('UNSUPPORTED_INPUT', 'This image step supports shared text files and corpus passages, but cannot read shared PDF or binary documents.');
    }
    const sources = await retrieveAgentInputEvidence(input, session, signal);
    signal?.throwIfAborted();
    const grounded = addAgentInputEvidence(input, sources);
    const lastUser = grounded.messages.map(message => message.role).lastIndexOf('user');
    if (isImageModel(input.model)) {
      if (prepared.textDocuments.length) grounded.messages[lastUser].text += `\n\n<attached_documents>\n${JSON.stringify(prepared.textDocuments)}\n</attached_documents>`;
      return { preparedPrompt: [grounded.systemInstruction, ...grounded.messages.map(message => message.text)].join('\n\n'), sources };
    }
    let result;
    if (galileo) {
      onInference?.();
      result = await runGalileoInference(galileo.config, galileo.model, {
        messages: grounded.messages, systemInstruction: grounded.systemInstruction, attachments: files,
        maxTokens: input.maxTokens, temperature: input.temperature, thinkingLevel: input.thinkingLevel, includeThoughts: input.includeThoughts,
      }, signal);
    } else {
      const messages: ChatMessage[] = grounded.messages.map(message => ({ ...message }));
      if (prepared.textDocuments.length) messages[lastUser].text += `\n\n<attached_documents>\n${JSON.stringify(prepared.textDocuments)}\n</attached_documents>`;
      for (const file of prepared.binaryFiles) {
        messages[lastUser].text += `\nAttached file: ${JSON.stringify(file.name)}`;
        if (file.size >= 5 * 1024 * 1024 && uploadFile) {
          const uri = await uploadFile(file, signal);
          uploaded.push(uri);
          (messages[lastUser].fileDataList ??= []).push({ mimeType: file.type, fileUri: uri });
        } else {
          (messages[lastUser].inlineDataList ??= []).push({ mimeType: file.type, data: Buffer.from(await file.arrayBuffer()).toString('base64') });
        }
      }
      const modelInfo = getModelInfo(input.model);
      if (input.maxTokens && modelInfo?.maxOutputTokens && input.maxTokens > modelInfo.maxOutputTokens) throw new AgentFileError('INVALID_STEP_REQUEST', 'Output limit exceeds the selected model capacity.');
      onInference?.();
      const response = await geminiChatWithGrounding(messages, input.model, { role: 'system', text: grounded.systemInstruction }, undefined, undefined, {
        ...(input.maxTokens ? { maxOutputTokens: input.maxTokens } : {}),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        thinkingConfig: { includeThoughts: input.includeThoughts ?? false, ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}) },
      }, { signal, validateInputBudget: true, strictResponse: true, redactLogs: true,
        singleAttempt: options?.singleAttempt, includeMetadata: options?.includeMetadata });
      if (!response.text?.trim()) throw new AgentFileError('EMPTY_RESPONSE', 'The model did not return an answer.', 502);
      result = { response: response.text, reasoning: response.reasoning, supports: response.supports,
        ...(response.metadata ? { generationMetadata: response.metadata } : {}) };
    }
    signal?.throwIfAborted();
    if (sources.length) {
      const validIds = new Set(sources.map(source => source.index));
      const citations = Array.from((result.response ?? '').matchAll(/\[(\d+)\]/g), match => Number(match[1]));
      if (citations.some(id => !validIds.has(id))) throw new AgentFileError('INVALID_CITATION', 'The model returned a citation not present in the retrieved evidence.', 502);
    }
    return { ...result, sources, ...(sources.length ? { isGrounded: true, groundingChunks: sources.map(source => ({ text: source.text, title: source.title, uri: source.uri })) } : {}),
      inputSummary: { fileCount: files.length, corpusCount: input.agentInputs.corpora.length, sourceCount: sources.length } };
  } catch (error) {
    if (error instanceof GalileoGatewayError) throw attachGalileoFailureDiagnostics(error, selectedModel, 'input');
    throw error;
  } finally {
    if (cleanupFile) for (const uri of uploaded) {
      try { await cleanupFile(uri); } catch {
        options?.onCleanupFailure?.();
        console.warn('[Agent inputs] Temporary provider file cleanup failed.');
      }
    }
  }
}

export async function agentInputStepResponse(...args: Parameters<typeof executeAgentInputStep>) {
  try {
    return NextResponse.json(await executeAgentInputStep(...args), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (args[3]?.aborted || (error instanceof Error && error.name === 'AbortError')) return NextResponse.json({ error: 'Step cancelled.', code: 'REQUEST_CANCELLED' }, { status: 499 });
    if (error instanceof GalileoGatewayError) return galileoErrorResponse(error);
    if (error instanceof AgentFileError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    const message = error instanceof Error && /^(Combined files|The model response was truncated|Could not verify|Invalid input size|The selected model has no known)/.test(error.message)
      ? error.message : 'The step could not read all its inputs or complete generation. No sources were silently omitted. Retry or check the source access and model limits.';
    return NextResponse.json({ error: message, code: 'SHARED_INPUT_FAILED' }, { status: 502 });
  }
}