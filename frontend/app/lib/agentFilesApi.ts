import { agentFileSchema, agentInputMetadataSchema, type AgentFile, type AgentInputMetadata } from './agentFiles';
import type { AgentInputSnapshot } from './agentInputs';
import { snapshotAgentInputMetadata } from './agentInputs';
import { agentnodesV1BasePath } from './agentnodesApi/agentnodesV1Flags';
import { queueAgentFileSave } from './agentSaveQueue';
import { MAX_FILE_SIZE_BYTES } from './fileValidation';

async function checkResponse(response: Response): Promise<Response> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body?.error === 'string' ? body.error : `File request failed (HTTP ${response.status}).`);
  }
  return response;
}

export async function fetchAgentFileLibrary(signal?: AbortSignal): Promise<AgentFile[]> {
  const response = await checkResponse(await fetch('/api/agent-files', { credentials: 'include', cache: 'no-store', signal }));
  const body = await response.json();
  return agentFileSchema.array().parse(body.files);
}

export async function saveAgentFile(input: File | { sourceId: string }, signal?: AbortSignal): Promise<AgentFile> {
  const form = input instanceof File ? new FormData() : null;
  if (form) form.append('file', input as File);
  const response = await checkResponse(await fetch('/api/agent-files', {
    method: 'POST', credentials: 'include', signal,
    ...(form ? { body: form } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
  }));
  return agentFileSchema.parse((await response.json()).file);
}

export async function deleteAgentFileEntry(id: string, signal?: AbortSignal): Promise<void> {
  await checkResponse(await fetch(`/api/agent-files/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include', signal }));
}

export async function persistAgentInputs(projectId: string, agentId: string, metadata: AgentInputMetadata): Promise<void> {
  const snapshot = agentInputMetadataSchema.parse(metadata);
  await queueAgentFileSave(projectId, agentId, async () => {
    await checkResponse(await fetch(`${agentnodesV1BasePath(projectId)}/agents/${encodeURIComponent(agentId)}`, {
      method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: snapshot }),
    }));
  });
}

export async function prepareAgentInputSnapshot(metadata: AgentInputMetadata | undefined, signal?: AbortSignal): Promise<AgentInputSnapshot> {
  const selection = snapshotAgentInputMetadata(metadata);
  const snapshot: AgentInputSnapshot = { files: [], corpusRefs: selection.corpusRefs ?? [] };
  const sources = new Set<string>();
  let size = 0;
  for (const id of selection.fileIds ?? []) {
    signal?.throwIfAborted();
    const base = `/api/agent-files/${encodeURIComponent(id)}`;
    const response = await checkResponse(await fetch(base, { credentials: 'include', cache: 'no-store', signal }));
    const entry = agentFileSchema.parse((await response.json()).file);
    if (sources.has(entry.sourceId)) continue;
    if (sources.size >= 5) throw new Error('A run supports at most five combined files.');
    const content = await checkResponse(await fetch(`${base}/content`, { credentials: 'include', cache: 'no-store', signal }));
    const blob = await content.blob();
    signal?.throwIfAborted();
    size += blob.size;
    if (size > MAX_FILE_SIZE_BYTES) throw new Error('Combined file inputs exceed the 30MB limit.');
    if (!blob.size) throw new Error(`File "${entry.name}" is empty.`);
    const name = decodeURIComponent(content.headers.get('X-Agent-File-Name') ?? encodeURIComponent(entry.name));
    const sourceId = content.headers.get('X-Agent-Source-Id');
    if (sourceId !== entry.sourceId) throw new Error('The saved file source changed. Refresh and retry.');
    snapshot.files.push({ file: new File([blob], name, { type: blob.type }), sourceId,
      revision: content.headers.get('X-Agent-Source-Revision') ?? undefined });
    sources.add(sourceId);
  }
  return snapshot;
}