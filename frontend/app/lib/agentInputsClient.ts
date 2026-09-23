import { buildEffectiveStepInputs, type AgentInputFile, type AgentInputSnapshot, type StepCorpusInput } from './agentInputs';
import { getStepEndpoint } from './stepExecution';
import { MAX_FILE_SIZE_BYTES } from './fileValidation';

const fileSources = new WeakMap<File, { sourceId: string; revision?: string }>();
let nextLocalId = 0;

export function registerAgentInputFile(file: File, sourceId: string, revision?: string): File {
  fileSources.set(file, { sourceId, revision });
  return file;
}

export function getAgentInputFileSourceId(file: File): string | undefined {
  return fileSources.get(file)?.sourceId;
}

function localInputFiles(files: File[], snapshot: AgentInputSnapshot): AgentInputFile[] {
  return files.map(file => {
    let identity = fileSources.get(file);
    if (!identity) {
      identity = { sourceId: `local-upload-${++nextLocalId}` };
      fileSources.set(file, identity);
    }
    const shared = snapshot.files.find(entry => entry.sourceId === identity?.sourceId);
    return { file, ...identity, revision: identity.revision ?? shared?.revision };
  });
}

export async function fetchWithAgentInputs(
  snapshot: AgentInputSnapshot,
  body: Record<string, unknown>,
  localFiles: File[] = [],
  localCorpora: StepCorpusInput[] = [],
  signal?: AbortSignal,
): Promise<Response> {
  signal?.throwIfAborted();
  const inputs = buildEffectiveStepInputs(snapshot, localInputFiles(localFiles, snapshot), localCorpora);
  if (inputs.files.length > 5 || inputs.files.reduce((size, file) => size + file.size, 0) > MAX_FILE_SIZE_BYTES) {
    throw new Error('Use at most five combined files, up to 30MB in total.');
  }
  const payload: Record<string, unknown> = { ...body, agentInputs: { corpora: inputs.corpora } };
  for (const key of ['corpusId', 'corpusIds', 'corpusDisplayHints', 'metadataFilter', 'enablePromptCache']) delete payload[key];
  const endpoint = getStepEndpoint(String(body.model));
  if (inputs.files.length) {
    const form = new FormData();
    inputs.files.forEach((file, index) => form.append(`file${index}`, file));
    for (const [key, value] of Object.entries(payload)) {
      if (value !== undefined && value !== null) form.append(key, ['model', 'projectId', 'thinkingLevel'].includes(key) ? String(value) : JSON.stringify(value));
    }
    return fetch(endpoint, { method: 'POST', credentials: 'include', headers: { 'X-Agent-Inputs': '1' }, body: form, signal });
  }
  return fetch(endpoint, { method: 'POST', credentials: 'include', headers: { 'X-Agent-Inputs': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal });
}

export async function prepareAgentImagePrompt(snapshot: AgentInputSnapshot, body: Record<string, unknown>, localFiles: File[], localCorpora: StepCorpusInput[], signal?: AbortSignal): Promise<string> {
  const response = await fetchWithAgentInputs(snapshot, body, localFiles.filter(file => !file.type.startsWith('image/')), localCorpora, signal);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Image input preparation failed (HTTP ${response.status}).`);
  if (typeof data.preparedPrompt !== 'string' || !data.preparedPrompt.trim()) throw new Error('The shared image inputs could not be prepared.');
  return data.preparedPrompt;
}

export function getLocalCorpusInputs(corpusId: string | undefined | null, documentSelections: unknown, projectId?: string | null): StepCorpusInput[] {
  if (!corpusId) return [];
  return [{ corpusId, ...(projectId ? { projectId } : {}),
    ...(Array.isArray(documentSelections) ? { documentSelections: documentSelections.filter((value): value is string => typeof value === 'string') } : {}),
  }];
}

export function getActiveStepInputs(activeTab: string, files: File[], corpusId: string | undefined | null, documentSelections: unknown, ragKnowledge: unknown, projectId?: string | null) {
  return {
    files: ['upload', 'bibliography', 'files'].includes(activeTab) ? files : [],
    corpora: activeTab === 'corpus' ? getLocalCorpusInputs(corpusId, documentSelections, projectId) : [],
    ragKnowledge: ['corpus', 'bibliography', 'files', 'papers'].includes(activeTab) && Array.isArray(ragKnowledge) ? ragKnowledge : [],
  };
}