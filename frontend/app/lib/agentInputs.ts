import type { AgentCorpusRef, AgentInputMetadata } from './agentFiles';
import { normalizeAgentInputMetadata } from './agentFiles';

export interface AgentInputFile {
  file: File;
  sourceId: string;
  revision?: string;
}

export interface AgentInputSnapshot {
  files: AgentInputFile[];
  corpusRefs: AgentCorpusRef[];
}

export interface StepCorpusInput extends AgentCorpusRef {
  documentSelections?: string[];
  metadataFilter?: string;
}

export function hasAgentInputs(metadata: AgentInputMetadata | undefined): boolean {
  return Boolean(metadata?.fileIds?.length || metadata?.corpusRefs?.length);
}

export function buildEffectiveStepInputs(
  shared: AgentInputSnapshot,
  localFiles: AgentInputFile[] = [],
  localCorpora: StepCorpusInput[] = [],
): { files: File[]; corpora: StepCorpusInput[] } {
  const files = new Map<string, File>();
  for (const entry of [...shared.files, ...localFiles]) {
    const identity = `${entry.sourceId}:${entry.revision ?? ''}`;
    if (!files.has(identity)) files.set(identity, entry.file);
  }
  const corpora = new Map<string, StepCorpusInput>();
  for (const ref of shared.corpusRefs) corpora.set(ref.corpusId, { ...ref });
  for (const ref of localCorpora) {
    corpora.set(ref.corpusId, { ...corpora.get(ref.corpusId), ...ref });
  }
  return { files: Array.from(files.values()), corpora: Array.from(corpora.values()) };
}

export function snapshotAgentInputMetadata(metadata: AgentInputMetadata | undefined): AgentInputMetadata {
  return normalizeAgentInputMetadata(metadata);
}