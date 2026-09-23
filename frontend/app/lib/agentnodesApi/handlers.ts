import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { drive_v3 } from 'googleapis';
import {
  createNewVersionedAgent,
  generateFileName,
  getCurrentVersionLayers,
  isVersionedAgent,
  addVersionToAgent,
  type VersionedAgentData,
} from '../versionUtils';
import { ensureAfFolder, isAgentSidecarFileName, listAfJsonFiles } from './afFolder';
import { readJsonFileById, writeJsonNamedFile } from './jsonFile';
import type { Canvas272Agent, Canvas272Layer } from '../../canvas-272/lib/types';
import { buildVoiceAgentnodesSnapshot } from '../../agentnodes/lib/voiceAgentnodesContext';
import { readGraphSidecar, writeGraphSidecar, deleteGraphSidecar } from './graphSidecar';
import { readOrCreateMeta, writeMeta, type AgentnodesMetaV1 } from './metaSidecar';
import {
  discoverCorpusesFromLayers,
  mergeDiscoveredCorpusLinks,
  layerReferencesCorpus,
  clearCorpusFromLayer,
  type DiscoveredCorpus,
} from './projectCorpusLinks';
import { createRefreshableAuth } from '../rag/auth';
import { listFileSearchStores } from '../rag/fileSearchStore';
import { corpusRegistryEntryLabel } from '../../agentnodes/lib/corpus';
import { upsertProjectCorpusLink } from './projectCorpusLinksStore';
import { findRunInProjectMetas, findSimulationInProjectMetas } from './metaScan';
import { RECIPES } from '../../canvas-272/lib/recipesCatalog';
import { buildInitialGraph } from '../../agentnodes/lib/initialGraph';
import type { AgentNodesGraphV1, AgentNodeSerialised, AgentEdgeSerialised, AgentNodeData } from '../../agentnodes/lib/types';
import { tidyLayout, type TidyMode, type TidyAxis } from '../../agentnodes/lib/tidyLayout';
import { serialisedEdgesToRf, serialisedNodesToRf, rfNodesToSerialised } from './reactFlowFromSerialised';
import type { Node } from 'reactflow';
import { agentInputMetadataSchema, normalizeAgentInputMetadata } from '../agentFiles';

function jsonErr(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export function rawToRuntimeAgent(agentId: string, raw: unknown): Canvas272Agent | null {
  if (!raw || typeof raw !== 'object') return null;
  if (isVersionedAgent(raw)) {
    const v = raw as VersionedAgentData;
    const layers = getCurrentVersionLayers(v) as Canvas272Layer[];
    return {
      id: agentId,
      name: v.agentName,
      layers,
      currentVersion: v.currentVersion,
      versions: v.versions.map((x) => x.version),
      metadata: v.metadata as Canvas272Agent['metadata'],
    };
  }
  const leg = raw as { name?: string; layers?: Canvas272Layer[] };
  if (Array.isArray(leg.layers)) {
    return { id: agentId, name: String(leg.name ?? 'Untitled'), layers: leg.layers };
  }
  return null;
}

async function updateAgentFileJson(
  drive: drive_v3.Drive,
  fileId: string,
  payload: unknown
): Promise<void> {
  const body = JSON.stringify(payload, null, 2);
  await drive.files.update({
    fileId,
    media: { mimeType: 'application/json', body },
    supportsAllDrives: true,
  });
}

export async function handleListAgents(drive: drive_v3.Drive, projectId: string) {
  const af = await ensureAfFolder(drive, projectId);
  const files = await listAfJsonFiles(drive, af);
  const agents = files.filter((f) => f.name && /\.json$/i.test(f.name) && !isAgentSidecarFileName(f.name));
  return NextResponse.json({ agents });
}

export async function handleCreateAgent(drive: drive_v3.Drive, projectId: string, request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { name?: string };
  const name = String(body.name ?? '').trim();
  if (!name) return jsonErr('name is required', 400);
  const ts = new Date().toISOString();
  const versioned = await createNewVersionedAgent(name, { name, layers: [], metadata: { created: ts, modified: ts } }, ts);
  const af = await ensureAfFolder(drive, projectId);
  const fileName = await generateFileName(name, ts);
  const { fileId } = await writeJsonNamedFile(drive, af, fileName, versioned);
  return NextResponse.json({ fileId, agent: versioned }, { status: 201 });
}

export async function handleGetAgent(drive: drive_v3.Drive, agentId: string) {
  const raw = await readJsonFileById<unknown>(drive, agentId);
  if (!raw) return jsonErr('Not found', 404);
  return NextResponse.json({ fileId: agentId, content: raw });
}

export async function handlePatchAgent(drive: drive_v3.Drive, agentId: string, request: NextRequest) {
  const raw = await readJsonFileById<VersionedAgentData | Record<string, unknown>>(drive, agentId);
  if (!raw) return jsonErr('Not found', 404);
  const patch = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const inputPatch = agentInputMetadataSchema.safeParse(patch.metadata ?? {});
  if (!inputPatch.success) return jsonErr('Invalid shared file or corpus selections', 400);
  if (isVersionedAgent(raw)) {
    const v = { ...raw };
    if (typeof patch.agentName === 'string' && patch.agentName.trim()) v.agentName = patch.agentName.trim();
    if (patch.metadata && typeof patch.metadata === 'object') {
      v.metadata = { ...(v.metadata ?? {}), ...(patch.metadata as object) };
      if (Object.keys(inputPatch.data).length) {
        v.versions = v.versions.map(version => version.version === v.currentVersion
          ? { ...version, metadata: { ...version.metadata, ...normalizeAgentInputMetadata(inputPatch.data) } }
          : version);
      }
    }
    v.metadata = { ...v.metadata, lastModified: new Date().toISOString() };
    await updateAgentFileJson(drive, agentId, v);
    return NextResponse.json({ ok: true, content: v });
  }
  const merged = { ...raw, ...patch, ...(patch.metadata && typeof patch.metadata === 'object'
    ? { metadata: { ...(raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {}), ...patch.metadata } } : {}) };
  await updateAgentFileJson(drive, agentId, merged);
  return NextResponse.json({ ok: true, content: merged });
}

export async function handlePutAgent(drive: drive_v3.Drive, agentId: string, request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonErr('JSON body required', 400);
  await updateAgentFileJson(drive, agentId, body);
  return NextResponse.json({ ok: true });
}

export async function handleDeleteAgent(drive: drive_v3.Drive, agentId: string) {
  try {
    await drive.files.delete({ fileId: agentId, supportsAllDrives: true });
    return new NextResponse(null, { status: 204 });
  } catch {
    return jsonErr('Delete failed', 500);
  }
}

export async function handleAgentSummary(drive: drive_v3.Drive, agentId: string) {
  const raw = await readJsonFileById<unknown>(drive, agentId);
  const agent = rawToRuntimeAgent(agentId, raw);
  if (!agent) return jsonErr('Not found', 404);
  const tags = new Set<string>();
  for (const l of agent.layers) {
    if (typeof l.tag === 'string' && l.tag) tags.add(l.tag);
  }
  return NextResponse.json({
    id: agent.id,
    name: agent.name,
    stepCount: agent.layers.length,
    tags: [...tags],
  });
}

export async function handleListVersions(drive: drive_v3.Drive, agentId: string) {
  const raw = await readJsonFileById<VersionedAgentData>(drive, agentId);
  if (!raw || !isVersionedAgent(raw)) return jsonErr('Not a versioned agent', 400);
  return NextResponse.json({ versions: raw.versions.map((x) => x.version), current: raw.currentVersion });
}

export async function handlePostNewVersion(drive: drive_v3.Drive, agentId: string, request: NextRequest) {
  const raw = await readJsonFileById<VersionedAgentData>(drive, agentId);
  if (!raw || !isVersionedAgent(raw)) return jsonErr('Not a versioned agent', 400);
  const body = (await request.json().catch(() => ({}))) as { layers?: Canvas272Layer[]; name?: string; metadata?: Canvas272Agent['metadata'] };
  const agentName = body.name?.trim() || raw.agentName;
  const layers = body.layers ?? getCurrentVersionLayers(raw);
  const ts = new Date().toISOString();
  const inputs = agentInputMetadataSchema.safeParse(body.metadata ?? {});
  if (!inputs.success) return jsonErr('Invalid shared file or corpus selections', 400);
  const next = await addVersionToAgent(raw, { name: agentName, layers,
    metadata: { ...normalizeAgentInputMetadata(raw.metadata), ...inputs.data } }, agentName, ts);
  await updateAgentFileJson(drive, agentId, next);
  return NextResponse.json({ ok: true, currentVersion: next.currentVersion });
}

export async function handleGetVersion(drive: drive_v3.Drive, agentId: string, version: string) {
  const raw = await readJsonFileById<VersionedAgentData>(drive, agentId);
  if (!raw || !isVersionedAgent(raw)) return jsonErr('Not a versioned agent', 400);
  const ver = raw.versions.find((v) => v.version === version);
  if (!ver) return jsonErr('Version not found', 404);
  return NextResponse.json({ version: ver });
}

export async function handleCloneAgent(drive: drive_v3.Drive, projectId: string, agentId: string, request: NextRequest) {
  const raw = await readJsonFileById<unknown>(drive, agentId);
  if (!raw) return jsonErr('Not found', 404);
  const body = (await request.json().catch(() => ({}))) as { name?: string };
  const newName = String(body.name ?? 'Copy').trim() || 'Copy';
  const ts = new Date().toISOString();
  if (isVersionedAgent(raw)) {
    const v = raw as VersionedAgentData;
    const layers = getCurrentVersionLayers(v);
    const fresh = await createNewVersionedAgent(newName, { name: newName, layers: JSON.parse(JSON.stringify(layers)) as Canvas272Layer[], metadata: { created: ts, modified: ts } }, ts);
    const af = await ensureAfFolder(drive, projectId);
    const cloneFileName = await generateFileName(newName, ts);
    const { fileId } = await writeJsonNamedFile(drive, af, cloneFileName, fresh);
    return NextResponse.json({ fileId });
  }
  return jsonErr('Unsupported agent format', 400);
}

export async function handleVoiceContext(drive: drive_v3.Drive, projectId: string, agentId: string) {
  const raw = await readJsonFileById<unknown>(drive, agentId);
  const agent = rawToRuntimeAgent(agentId, raw);
  const graphDoc = await readGraphSidecar(drive, projectId, agentId);
  if (!agent) return jsonErr('Not found', 404);
  const nodes = graphDoc?.graph.nodes ?? [];
  const edges = graphDoc?.graph.edges ?? [];
  const snap = buildVoiceAgentnodesSnapshot({
    urlAgentId: agentId,
    projectId,
    loadedAgent: agent,
    nodes: serialisedNodesToRf(nodes),
    edges: serialisedEdgesToRf(edges),
    isGraphRunning: false,
    runProgress: { current: 0, total: 0, currentStepName: '' },
    runnerRunningIds: new Set(),
    runnerCompletedIds: new Set(),
    failedLayerIds: new Set(),
    isSimulating: false,
    simPaused: false,
    simProgress: { current: 0, total: 0, currentStepName: '' },
    simRunningIds: new Set(),
    simCompletedIds: new Set(),
    isDemoSimulating: false,
  });
  const s = JSON.stringify(snap);
  return NextResponse.json({ voiceContextJson: s.length > 8000 ? `${s.slice(0, 8000)}…` : s });
}

export async function handleGraphDocument(
  drive: drive_v3.Drive,
  projectId: string,
  agentId: string,
  method: string,
  request: NextRequest
) {
  if (method === 'GET') {
    const got = await readGraphSidecar(drive, projectId, agentId);
    if (!got) return jsonErr('Not found', 404);
    return NextResponse.json({ graph: got.graph, fileId: got.fileId });
  }
  if (method === 'PUT') {
    const body = (await request.json()) as { graph?: AgentNodesGraphV1; baseUpdatedAt?: string };
    if (!body?.graph || body.graph.version !== 1) return jsonErr('Invalid graph', 400);
    if (body.graph.agentId !== agentId) return jsonErr('graph.agentId mismatch', 400);
    const existing = await readGraphSidecar(drive, projectId, agentId);
    if (existing && body.baseUpdatedAt && existing.graph.updatedAt !== body.baseUpdatedAt) {
      return jsonErr('stale_graph', 409, { graph: existing.graph });
    }
    body.graph.updatedAt = new Date().toISOString();
    await writeGraphSidecar(drive, projectId, body.graph);
    return NextResponse.json({ ok: true, graph: body.graph });
  }
  if (method === 'DELETE') {
    await deleteGraphSidecar(drive, projectId, agentId);
    return new NextResponse(null, { status: 204 });
  }
  return jsonErr('Method not allowed', 405);
}

export async function handleGraphValidate(drive: drive_v3.Drive, projectId: string, agentId: string) {
  const got = await readGraphSidecar(drive, projectId, agentId);
  const raw = await readJsonFileById<unknown>(drive, agentId);
  const agent = rawToRuntimeAgent(agentId, raw);
  if (!got || !agent) return jsonErr('graph or agent missing', 400);
  const layerIds = new Set(agent.layers.map((l) => l.id));
  const nodeIds = new Set(got.graph.nodes.map((n) => n.id));
  const issues: string[] = [];
  for (const n of got.graph.nodes) {
    if (!layerIds.has(n.data.layerId)) issues.push(`node ${n.id} references unknown layer ${n.data.layerId}`);
  }
  for (const e of got.graph.edges) {
    if (!nodeIds.has(e.source)) issues.push(`edge ${e.id} bad source`);
    if (!nodeIds.has(e.target)) issues.push(`edge ${e.id} bad target`);
  }
  return NextResponse.json({ ok: issues.length === 0, issues });
}

export async function handleGraphReset(drive: drive_v3.Drive, projectId: string, agentId: string) {
  const raw = await readJsonFileById<unknown>(drive, agentId);
  const agent = rawToRuntimeAgent(agentId, raw);
  if (!agent) return jsonErr('Not found', 404);
  const seeded = buildInitialGraph(agent);
  const graph: AgentNodesGraphV1 = {
    version: 1,
    agentId,
    agentName: agent.name,
    updatedAt: new Date().toISOString(),
    nodes: seeded.nodes,
    edges: seeded.edges,
  };
  await writeGraphSidecar(drive, projectId, graph);
  return NextResponse.json({ graph });
}

export async function handleGraphTopology(drive: drive_v3.Drive, projectId: string, agentId: string) {
  const got = await readGraphSidecar(drive, projectId, agentId);
  if (!got) return jsonErr('Not found', 404);
  const { nodes, edges } = got.graph;
  const indegree = new Map<string, number>();
  for (const n of nodes) indegree.set(n.id, 0);
  for (const e of edges) {
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  }
  const queue = [...nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id)];
  const order: string[] = [];
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const t of adj.get(id) ?? []) {
      const d = (indegree.get(t) ?? 0) - 1;
      indegree.set(t, d);
      if (d === 0) queue.push(t);
    }
  }
  return NextResponse.json({ nodeOrder: order, nodeCount: nodes.length, edgeCount: edges.length });
}

export async function handleGraphDiff(_drive: drive_v3.Drive, _projectId: string, _agentId: string, request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { a?: unknown; b?: unknown };
  return NextResponse.json({ diff: 'not_implemented', receivedKeys: Object.keys(body) });
}

export async function handleGraphImport(_drive: drive_v3.Drive, _projectId: string, _agentId: string, request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { format?: string; payload?: unknown };
  return NextResponse.json({ imported: false, note: 'Provide AgentNodesGraphV1 in payload.graph to extend import', format: body.format });
}

export async function handleGraphExport() {
  return NextResponse.json({ error: 'PNG/SVG export requires browser canvas; use client export' }, { status: 501 });
}

export async function handleGraphPreferences(
  drive: drive_v3.Drive,
  projectId: string,
  agentId: string,
  method: string,
  request: NextRequest
) {
  const { meta, fileId } = await readOrCreateMeta(drive, projectId, agentId);
  const prefs = meta.graphPrefs ?? {};
  if (method === 'GET') {
    return NextResponse.json({ preferences: prefs, metaFileId: fileId });
  }
  if (method === 'PATCH') {
    const patch = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const nextMeta: AgentnodesMetaV1 = {
      ...meta,
      graphPrefs: { ...prefs, ...patch },
    };
    await writeMeta(drive, projectId, nextMeta);
    return NextResponse.json({ preferences: nextMeta.graphPrefs });
  }
  return jsonErr('Method not allowed', 405);
}

export async function handleGraphLayout(
  drive: drive_v3.Drive,
  projectId: string,
  agentId: string,
  request: NextRequest,
  mode: TidyMode,
  axis: TidyAxis | 'both',
  persist: boolean
) {
  const got = await readGraphSidecar(drive, projectId, agentId);
  if (!got) return jsonErr('Graph not found', 404);
  const rfNodes = serialisedNodesToRf(got.graph.nodes);
  const rfEdges = serialisedEdgesToRf(got.graph.edges);
  const { nodes: laidOut } = tidyLayout(rfNodes, rfEdges, mode, axis);
  if (!persist) {
    return NextResponse.json({
      nodes: rfNodesToSerialised(laidOut as Node<AgentNodeData>[]),
      edges: got.graph.edges,
    });
  }
  const next: AgentNodesGraphV1 = {
    ...got.graph,
    updatedAt: new Date().toISOString(),
    nodes: rfNodesToSerialised(laidOut as Node<AgentNodeData>[]),
  };
  await writeGraphSidecar(drive, projectId, next);
  return NextResponse.json({ graph: next });
}

export async function handleListGraphNodes(drive: drive_v3.Drive, projectId: string, agentId: string) {
  const got = await readGraphSidecar(drive, projectId, agentId);
  if (!got) return jsonErr('Not found', 404);
  return NextResponse.json({ nodes: got.graph.nodes });
}

export async function handlePostGraphNode(
  drive: drive_v3.Drive,
  projectId: string,
  agentId: string,
  request: NextRequest
) {
  const got = await readGraphSidecar(drive, projectId, agentId);
  if (!got) return jsonErr('Graph not found', 404);
  const body = (await request.json()) as { node: AgentNodeSerialised };
  if (!body?.node?.id) return jsonErr('node required', 400);
  const nodes = [...got.graph.nodes, body.node];
  const next: AgentNodesGraphV1 = { ...got.graph, nodes, updatedAt: new Date().toISOString() };
  await writeGraphSidecar(drive, projectId, next);
  return NextResponse.json({ graph: next }, { status: 201 });
}

export async function handleGetGraphNode(drive: drive_v3.Drive, projectId: string, agentId: string, nodeId: string) {
  const got = await readGraphSidecar(drive, projectId, agentId);
  if (!got) return jsonErr('Not found', 404);
  const n = got.graph.nodes.find((x) => x.id === nodeId);
  if (!n) return jsonErr('Node not found', 404);
  return NextResponse.json({ node: n });
}

async function patchLayerWithObject(
  drive: drive_v3.Drive,
  agentId: string,
  layerId: string,
  patch: Partial<Canvas272Layer>
): Promise<NextResponse> {
  const raw = await readJsonFileById<VersionedAgentData>(drive, agentId);
  if (!raw || !isVersionedAgent(raw)) return jsonErr('Versioned agent required', 400);
  const layers = getCurrentVersionLayers(raw).map((l) =>
    l.id === layerId ? ({ ...l, ...patch } as Canvas272Layer) : l
  );
  const ts = new Date().toISOString();
  const nextAgent = await addVersionToAgent(raw, { name: raw.agentName, layers, metadata: {} }, raw.agentName, ts);
  await updateAgentFileJson(drive, agentId, nextAgent);
  return NextResponse.json({ ok: true, layer: layers.find((l) => l.id === layerId) });
}

export async function handlePatchGraphNode(
  drive: drive_v3.Drive,
  projectId: string,
  agentId: string,
  nodeId: string,
  request: NextRequest
) {
  const got = await readGraphSidecar(drive, projectId, agentId);
  if (!got) return jsonErr('Not found', 404);
  const patch = (await request.json().catch(() => ({}))) as Partial<AgentNodeSerialised>;
  const nodes = got.graph.nodes.map((n) => {
    if (n.id !== nodeId) return n;
    return {
      ...n,
      type: patch.type ?? n.type,
      position: patch.position !== undefined ? patch.position : n.position,
      data: patch.data !== undefined ? { ...n.data, ...patch.data } : n.data,
    };
  });
  const next: AgentNodesGraphV1 = { ...got.graph, nodes, updatedAt: new Date().toISOString() };
  await writeGraphSidecar(drive, projectId, next);
  return NextResponse.json({ graph: next });
}

export async function handlePatchGraphNodePosition(
  drive: drive_v3.Drive,
  projectId: string,
  agentId: string,
  nodeId: string,
  request: NextRequest
) {
  const got = await readGraphSidecar(drive, projectId, agentId);
  if (!got) return jsonErr('Not found', 404);
  const body = (await request.json().catch(() => ({}))) as { x?: number; y?: number };
  const nodes = got.graph.nodes.map((n) =>
    n.id === nodeId
      ? { ...n, position: { x: Number(body.x ?? n.position.x), y: Number(body.y ?? n.position.y) } }
      : n
  );
  const next: AgentNodesGraphV1 = { ...got.graph, nodes, updatedAt: new Date().toISOString() };
  await writeGraphSidecar(drive, projectId, next);
  return NextResponse.json({ graph: next });
}

export async function handlePatchGraphNodeData(
  drive: drive_v3.Drive,
  projectId: string,
  agentId: string,
  nodeId: string,
  request: NextRequest
) {
  const got = await readGraphSidecar(drive, projectId, agentId);
  if (!got) return jsonErr('Not found', 404);
  const dataPatch = (await request.json().catch(() => ({}))) as Partial<AgentNodeData>;
  const nodes = got.graph.nodes.map((n) =>
    n.id === nodeId ? { ...n, data: { ...n.data, ...dataPatch } } : n
  );
  const next: AgentNodesGraphV1 = { ...got.graph, nodes, updatedAt: new Date().toISOString() };
  await writeGraphSidecar(drive, projectId, next);
  return NextResponse.json({ graph: next });
}

async function graphNodeBackingLayerId(
  drive: drive_v3.Drive,
  projectId: string,
  agentId: string,
  nodeId: string
): Promise<{ layerId: string } | { error: ReturnType<typeof jsonErr> }> {
  const got = await readGraphSidecar(drive, projectId, agentId);
  if (!got) return { error: jsonErr('Not found', 404) };
  const n = got.graph.nodes.find((x) => x.id === nodeId);
  if (!n?.data.layerId) return { error: jsonErr('Node not found', 404) };
  return { layerId: n.data.layerId };
}

export async function handleGraphNodeTag(
  drive: drive_v3.Drive,
  projectId: string,
  agentId: string,
  nodeId: string,
  request: NextRequest
) {
  const idRes = await graphNodeBackingLayerId(drive, projectId, agentId, nodeId);
  if ('error' in idRes) return idRes.error;
  const { tag } = (await request.json().catch(() => ({}))) as { tag?: string | null };
  const lr = await patchLayerWithObject(drive, agentId, idRes.layerId, { tag: tag ?? undefined });
  if (lr.status >= 400) return lr;
  const got = await readGraphSidecar(drive, projectId, agentId);
  if (!got) return lr;
  const nodes = got.graph.nodes.map((n) =>
    n.id === nodeId ? { ...n, data: { ...n.data, tag: tag ?? undefined } } : n
  );
  const next: AgentNodesGraphV1 = { ...got.graph, nodes, updatedAt: new Date().toISOString() };
  await writeGraphSidecar(drive, projectId, next);
  return NextResponse.json({ graph: next });
}

export async function handleGraphNodeCorpusPatch(
  drive: drive_v3.Drive,
  projectId: string,
  agentId: string,
  nodeId: string,
  request: NextRequest
) {
  const idRes = await graphNodeBackingLayerId(drive, projectId, agentId, nodeId);
  if ('error' in idRes) return idRes.error;
  const { corpusId } = (await request.json().catch(() => ({}))) as { corpusId?: string };
  const lr = await patchLayerWithObject(drive, agentId, idRes.layerId, { corpusId });
  if (lr.status >= 400) return lr;
  const got = await readGraphSidecar(drive, projectId, agentId);
  if (!got) return lr;
  const nodes = got.graph.nodes.map((n) =>
    n.id === nodeId ? { ...n, data: { ...n.data, corpusId: corpusId || undefined } } : n
  );
  const next: AgentNodesGraphV1 = { ...got.graph, nodes, updatedAt: new Date().toISOString() };
  await writeGraphSidecar(drive, projectId, next);
  return NextResponse.json({ graph: next });
}

export async function handleGraphNodeCorpusDelete(
  drive: drive_v3.Drive,
  projectId: string,
  agentId: string,
  nodeId: string
) {
  const idRes = await graphNodeBackingLayerId(drive, projectId, agentId, nodeId);
  if ('error' in idRes) return idRes.error;
  const lr = await patchLayerWithObject(drive, agentId, idRes.layerId, { corpusId: undefined, ragKnowledge: [] });
  if (lr.status >= 400) return lr;
  const got = await readGraphSidecar(drive, projectId, agentId);
  if (!got) return lr;
  const nodes = got.graph.nodes.map((n) =>
    n.id === nodeId ? { ...n, data: { ...n.data, corpusId: undefined } } : n
  );
  const next: AgentNodesGraphV1 = { ...got.graph, nodes, updatedAt: new Date().toISOString() };
  await writeGraphSidecar(drive, projectId, next);
  return NextResponse.json({ graph: next });
}

export async function handleGraphNodeDocuments(
  drive: drive_v3.Drive,
  projectId: string,
  agentId: string,
  nodeId: string,
  request: NextRequest
) {
  const idRes = await graphNodeBackingLayerId(drive, projectId, agentId, nodeId);
  if ('error' in idRes) return idRes.error;
  const { documentSelections } = (await request.json().catch(() => ({}))) as { documentSelections?: string[] };
  return patchLayerWithObject(drive, agentId, idRes.layerId, { documentSelections: documentSelections ?? [] });
}

export async function handleGraphNodeModel(
  drive: drive_v3.Drive,
  projectId: string,
  agentId: string,
  nodeId: string,
  request: NextRequest
) {
  const idRes = await graphNodeBackingLayerId(drive, projectId, agentId, nodeId);
  if ('error' in idRes) return idRes.error;
  const { selectedModel } = (await request.json().catch(() => ({}))) as { selectedModel?: string };
  return patchLayerWithObject(drive, agentId, idRes.layerId, { selectedModel });
}

export async function handlePostGraphNodeDuplicate(
  drive: drive_v3.Drive,
  projectId: string,
  agentId: string,
  nodeId: string
) {
  const got = await readGraphSidecar(drive, projectId, agentId);
  if (!got) return jsonErr('Not found', 404);
  const src = got.graph.nodes.find((n) => n.id === nodeId);
  if (!src) return jsonErr('Node not found', 404);
  const newId = `dup-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  const copy: AgentNodeSerialised = {
    ...JSON.parse(JSON.stringify(src)) as AgentNodeSerialised,
    id: newId,
    position: { x: src.position.x + 24, y: src.position.y + 24 },
  };
  const nodes = [...got.graph.nodes, copy];
  const next: AgentNodesGraphV1 = { ...got.graph, nodes, updatedAt: new Date().toISOString() };
  await writeGraphSidecar(drive, projectId, next);
  return NextResponse.json({ node: copy, graph: next }, { status: 201 });
}

export async function handleDeleteGraphNode(drive: drive_v3.Drive, projectId: string, agentId: string, nodeId: string) {
  const got = await readGraphSidecar(drive, projectId, agentId);
  if (!got) return jsonErr('Not found', 404);
  const nodes = got.graph.nodes.filter((n) => n.id !== nodeId);
  const edges = got.graph.edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
  const next: AgentNodesGraphV1 = { ...got.graph, nodes, edges, updatedAt: new Date().toISOString() };
  await writeGraphSidecar(drive, projectId, next);
  return new NextResponse(null, { status: 204 });
}

export async function handleBulkDeleteNodes(
  drive: drive_v3.Drive,
  projectId: string,
  agentId: string,
  request: NextRequest
) {
  const got = await readGraphSidecar(drive, projectId, agentId);
  if (!got) return jsonErr('Not found', 404);
  const body = (await request.json()) as { ids?: string[] };
  const drop = new Set(body.ids ?? []);
  const nodes = got.graph.nodes.filter((n) => !drop.has(n.id));
  const edges = got.graph.edges.filter((e) => !drop.has(e.source) && !drop.has(e.target));
  const next: AgentNodesGraphV1 = { ...got.graph, nodes, edges, updatedAt: new Date().toISOString() };
  await writeGraphSidecar(drive, projectId, next);
  return NextResponse.json({ graph: next });
}

export async function handleListEdges(drive: drive_v3.Drive, projectId: string, agentId: string) {
  const got = await readGraphSidecar(drive, projectId, agentId);
  if (!got) return jsonErr('Not found', 404);
  return NextResponse.json({ edges: got.graph.edges });
}

export async function handlePostEdge(
  drive: drive_v3.Drive,
  projectId: string,
  agentId: string,
  request: NextRequest
) {
  const got = await readGraphSidecar(drive, projectId, agentId);
  if (!got) return jsonErr('Not found', 404);
  const body = (await request.json()) as { edge: AgentEdgeSerialised };
  if (!body?.edge?.id) return jsonErr('edge required', 400);
  const edges = [...got.graph.edges, body.edge];
  const next: AgentNodesGraphV1 = { ...got.graph, edges, updatedAt: new Date().toISOString() };
  await writeGraphSidecar(drive, projectId, next);
  return NextResponse.json({ graph: next }, { status: 201 });
}

export async function handleGetEdge(drive: drive_v3.Drive, projectId: string, agentId: string, edgeId: string) {
  const got = await readGraphSidecar(drive, projectId, agentId);
  if (!got) return jsonErr('Not found', 404);
  const e = got.graph.edges.find((x) => x.id === edgeId);
  if (!e) return jsonErr('Edge not found', 404);
  return NextResponse.json({ edge: e });
}

export async function handlePatchEdge(
  drive: drive_v3.Drive,
  projectId: string,
  agentId: string,
  edgeId: string,
  request: NextRequest
) {
  const got = await readGraphSidecar(drive, projectId, agentId);
  if (!got) return jsonErr('Not found', 404);
  const patch = (await request.json()) as Partial<AgentEdgeSerialised>;
  const edges = got.graph.edges.map((e) => (e.id === edgeId ? { ...e, ...patch } : e));
  const next: AgentNodesGraphV1 = { ...got.graph, edges, updatedAt: new Date().toISOString() };
  await writeGraphSidecar(drive, projectId, next);
  return NextResponse.json({ graph: next });
}

export async function handleDeleteEdge(drive: drive_v3.Drive, projectId: string, agentId: string, edgeId: string) {
  const got = await readGraphSidecar(drive, projectId, agentId);
  if (!got) return jsonErr('Not found', 404);
  const edges = got.graph.edges.filter((e) => e.id !== edgeId);
  const next: AgentNodesGraphV1 = { ...got.graph, edges, updatedAt: new Date().toISOString() };
  await writeGraphSidecar(drive, projectId, next);
  return new NextResponse(null, { status: 204 });
}

export async function handleBulkEdges(
  drive: drive_v3.Drive,
  projectId: string,
  agentId: string,
  method: string,
  request: NextRequest
) {
  const got = await readGraphSidecar(drive, projectId, agentId);
  if (!got) return jsonErr('Not found', 404);
  if (method === 'POST') {
    const body = (await request.json()) as { edges?: AgentEdgeSerialised[] };
    const edges = [...got.graph.edges, ...(body.edges ?? [])];
    const next: AgentNodesGraphV1 = { ...got.graph, edges, updatedAt: new Date().toISOString() };
    await writeGraphSidecar(drive, projectId, next);
    return NextResponse.json({ graph: next });
  }
  if (method === 'DELETE') {
    const body = (await request.json()) as { ids?: string[] };
    const drop = new Set(body.ids ?? []);
    const edges = got.graph.edges.filter((e) => !drop.has(e.id));
    const next: AgentNodesGraphV1 = { ...got.graph, edges, updatedAt: new Date().toISOString() };
    await writeGraphSidecar(drive, projectId, next);
    return NextResponse.json({ graph: next });
  }
  return jsonErr('Method not allowed', 405);
}

export async function handleEdgesValidate(drive: drive_v3.Drive, projectId: string, agentId: string) {
  return handleGraphValidate(drive, projectId, agentId);
}

export async function handleListLayers(drive: drive_v3.Drive, agentId: string) {
  const raw = await readJsonFileById<unknown>(drive, agentId);
  const agent = rawToRuntimeAgent(agentId, raw);
  if (!agent) return jsonErr('Not found', 404);
  return NextResponse.json({ layers: agent.layers });
}

export async function handlePostLayer(drive: drive_v3.Drive, agentId: string, request: NextRequest) {
  const raw = await readJsonFileById<VersionedAgentData>(drive, agentId);
  if (!raw || !isVersionedAgent(raw)) return jsonErr('Versioned agent required', 400);
  const body = (await request.json().catch(() => ({}))) as { layer?: Partial<Canvas272Layer> };
  const layers = getCurrentVersionLayers(raw);
  const id = `layer-${Date.now()}`;
  const newLayer: Canvas272Layer = {
    id,
    name: String(body.layer?.name ?? 'New step'),
    type: 'user',
    isActive: true,
    order: layers.length,
    ...body.layer,
  } as Canvas272Layer;
  const ts = new Date().toISOString();
  const nextAgent = await addVersionToAgent(
    raw,
    { name: raw.agentName, layers: [...layers, newLayer], metadata: {} },
    raw.agentName,
    ts
  );
  await updateAgentFileJson(drive, agentId, nextAgent);
  return NextResponse.json({ layer: newLayer }, { status: 201 });
}

export async function handleGetLayer(drive: drive_v3.Drive, agentId: string, layerId: string) {
  const raw = await readJsonFileById<unknown>(drive, agentId);
  const agent = rawToRuntimeAgent(agentId, raw);
  const layer = agent?.layers.find((l) => l.id === layerId);
  if (!layer) return jsonErr('Not found', 404);
  return NextResponse.json({ layer });
}

export async function handlePatchLayer(drive: drive_v3.Drive, agentId: string, layerId: string, request: NextRequest) {
  const patch = (await request.json().catch(() => ({}))) as Partial<Canvas272Layer>;
  return patchLayerWithObject(drive, agentId, layerId, patch);
}

export async function handlePutLayer(drive: drive_v3.Drive, agentId: string, layerId: string, request: NextRequest) {
  const raw = await readJsonFileById<VersionedAgentData>(drive, agentId);
  if (!raw || !isVersionedAgent(raw)) return jsonErr('Versioned agent required', 400);
  const body = (await request.json().catch(() => null)) as { layer?: Canvas272Layer } | null;
  if (!body?.layer) return jsonErr('layer object required', 400);
  if (body.layer.id !== layerId) return jsonErr('layer.id mismatch', 400);
  const layers = getCurrentVersionLayers(raw).map((l) => (l.id === layerId ? body.layer! : l));
  const ts = new Date().toISOString();
  const nextAgent = await addVersionToAgent(raw, { name: raw.agentName, layers, metadata: {} }, raw.agentName, ts);
  await updateAgentFileJson(drive, agentId, nextAgent);
  return NextResponse.json({ ok: true, layer: body.layer });
}

export async function handleDeleteLayer(drive: drive_v3.Drive, agentId: string, layerId: string) {
  const raw = await readJsonFileById<VersionedAgentData>(drive, agentId);
  if (!raw || !isVersionedAgent(raw)) return jsonErr('Versioned agent required', 400);
  const layers = getCurrentVersionLayers(raw).filter((l) => l.id !== layerId);
  const ts = new Date().toISOString();
  const nextAgent = await addVersionToAgent(raw, { name: raw.agentName, layers, metadata: {} }, raw.agentName, ts);
  await updateAgentFileJson(drive, agentId, nextAgent);
  return new NextResponse(null, { status: 204 });
}

export async function handleReorderLayers(drive: drive_v3.Drive, agentId: string, request: NextRequest) {
  const raw = await readJsonFileById<VersionedAgentData>(drive, agentId);
  if (!raw || !isVersionedAgent(raw)) return jsonErr('Versioned agent required', 400);
  const body = (await request.json()) as { order?: string[] };
  const order = body.order ?? [];
  const layerMap = new Map(getCurrentVersionLayers(raw).map((l) => [l.id, l]));
  const layers = order.map((id, i) => {
    const l = layerMap.get(id);
    if (!l) return null;
    return { ...l, order: i } as Canvas272Layer;
  }).filter(Boolean) as Canvas272Layer[];
  const ts = new Date().toISOString();
  const nextAgent = await addVersionToAgent(raw, { name: raw.agentName, layers, metadata: {} }, raw.agentName, ts);
  await updateAgentFileJson(drive, agentId, nextAgent);
  return NextResponse.json({ ok: true });
}

export async function handleDuplicateLayer(drive: drive_v3.Drive, agentId: string, layerId: string) {
  const raw = await readJsonFileById<VersionedAgentData>(drive, agentId);
  if (!raw || !isVersionedAgent(raw)) return jsonErr('Versioned agent required', 400);
  const layers = getCurrentVersionLayers(raw);
  const src = layers.find((l) => l.id === layerId);
  if (!src) return jsonErr('Not found', 404);
  const copy = { ...JSON.parse(JSON.stringify(src)) as Canvas272Layer, id: `layer-${Date.now()}`, name: `${src.name} copy` };
  const ts = new Date().toISOString();
  const nextAgent = await addVersionToAgent(raw, { name: raw.agentName, layers: [...layers, copy], metadata: {} }, raw.agentName, ts);
  await updateAgentFileJson(drive, agentId, nextAgent);
  return NextResponse.json({ layer: copy });
}

export async function handleLayerTag(drive: drive_v3.Drive, agentId: string, layerId: string, request: NextRequest) {
  const patch = (await request.json().catch(() => ({}))) as { tag?: string | null };
  return patchLayerWithObject(drive, agentId, layerId, { tag: patch.tag ?? undefined });
}

export async function handleLayerCorpusPatch(drive: drive_v3.Drive, agentId: string, layerId: string, request: NextRequest) {
  const patch = (await request.json().catch(() => ({}))) as { corpusId?: string };
  return patchLayerWithObject(drive, agentId, layerId, { corpusId: patch.corpusId });
}

export async function handleLayerCorpusDelete(drive: drive_v3.Drive, agentId: string, layerId: string) {
  return patchLayerWithObject(drive, agentId, layerId, { corpusId: undefined, ragKnowledge: [] });
}

export async function handleLayerDocuments(drive: drive_v3.Drive, agentId: string, layerId: string, request: NextRequest) {
  const patch = (await request.json().catch(() => ({}))) as { documentSelections?: string[] };
  return patchLayerWithObject(drive, agentId, layerId, { documentSelections: patch.documentSelections ?? [] });
}

export async function handleLayerModel(drive: drive_v3.Drive, agentId: string, layerId: string, request: NextRequest) {
  const patch = (await request.json().catch(() => ({}))) as { selectedModel?: string };
  return patchLayerWithObject(drive, agentId, layerId, { selectedModel: patch.selectedModel });
}

export async function handleLayerValidate() {
  return unsupportedLegacyOperation('Layer verification', '/api/v1/agentnodes/runs/plan');
}

export async function handleRunsList(drive: drive_v3.Drive, projectId: string, agentId: string) {
  const { meta } = await readOrCreateMeta(drive, projectId, agentId);
  return NextResponse.json({ runs: meta.runs });
}

function unsupportedLegacyExecution() {
  return NextResponse.json({
    error: 'This legacy endpoint does not execute or manage model runs. Use the portable execution API with caller-owned checkpoints.',
    code: 'EXECUTION_NOT_IMPLEMENTED', executionApi: '/api/v1/agentnodes',
  }, { status: 501, headers: { 'Cache-Control': 'no-store' } });
}

function unsupportedLegacyOperation(operation: string, replacement?: string) {
  return NextResponse.json({
    error: `${operation} is not implemented by this legacy endpoint.`,
    code: 'OPERATION_NOT_IMPLEMENTED', ...(replacement ? { replacement } : {}),
  }, { status: 501, headers: { 'Cache-Control': 'no-store' } });
}

export async function handleRunsPost(_drive: drive_v3.Drive, _projectId: string, _agentId: string) {
  return unsupportedLegacyExecution();
}

export async function handleRunPreview() {
  return unsupportedLegacyExecution();
}

export async function handleRunById(drive: drive_v3.Drive, projectId: string, runId: string, method: string) {
  const found = await findRunInProjectMetas(drive, projectId, runId);
  if (!found) return jsonErr('Not found', 404);
  if (method === 'GET') {
    return NextResponse.json({ run: found.run });
  }
  if (method === 'DELETE') {
    found.meta.runs = found.meta.runs.filter((r) => r.id !== runId);
    await writeMeta(drive, projectId, found.meta);
    return new NextResponse(null, { status: 204 });
  }
  return jsonErr('Method not allowed', 405);
}

export async function handleSimulationsPost(_drive: drive_v3.Drive, _projectId: string, _agentId: string) {
  return unsupportedLegacyOperation('Server simulation', '/api/v1/agentnodes/runs/plan');
}

export async function handleSimulationById(
  drive: drive_v3.Drive,
  projectId: string,
  simulationId: string,
  method: string,
  request: NextRequest
) {
  const found = await findSimulationInProjectMetas(drive, projectId, simulationId);
  if (!found) return jsonErr('Not found', 404);
  const { meta, fileId, sim } = found;
  void fileId;
  if (method === 'GET') return NextResponse.json({ simulation: sim });
  if (method === 'PATCH') {
    const p = (await request.json().catch(() => ({}))) as { paused?: boolean; status?: string };
    if (typeof p.paused === 'boolean') sim.paused = p.paused;
    if (typeof p.status === 'string') sim.status = p.status;
    await writeMeta(drive, projectId, meta);
    return NextResponse.json({ simulation: sim });
  }
  if (method === 'DELETE') {
    meta.simulations = meta.simulations.filter((s) => s.id !== simulationId);
    await writeMeta(drive, projectId, meta);
    return new NextResponse(null, { status: 204 });
  }
  return jsonErr('Method not allowed', 405);
}

export async function handleSimulationReset(drive: drive_v3.Drive, projectId: string, simulationId: string) {
  const found = await findSimulationInProjectMetas(drive, projectId, simulationId);
  if (!found) return jsonErr('Not found', 404);
  const { meta, sim } = found;
  sim.status = 'idle';
  sim.paused = false;
  await writeMeta(drive, projectId, meta);
  return NextResponse.json({ simulation: sim });
}

export async function handleRecipesList() {
  return NextResponse.json({
    recipes: RECIPES.map((r) => ({ id: r.id, name: r.name, description: r.description })),
  });
}

export async function handleRecipeGet(rid: string) {
  const r = RECIPES.find((x) => x.id === rid);
  if (!r) return jsonErr('Not found', 404);
  return NextResponse.json({ recipe: r });
}

export async function handleRecipeApply() {
  return NextResponse.json({ applied: false, note: 'Apply recipe on server not implemented; use client graph builder' }, { status: 501 });
}

export async function handleSnapshots(
  drive: drive_v3.Drive,
  projectId: string,
  agentId: string,
  method: string,
  request: NextRequest,
  tail: string[]
) {
  const { meta } = await readOrCreateMeta(drive, projectId, agentId);
  if (tail.length === 0) {
    if (method === 'GET') return NextResponse.json({ snapshots: meta.snapshots });
    if (method === 'POST') {
      const got = await readGraphSidecar(drive, projectId, agentId);
      const body = (await request.json().catch(() => ({}))) as { label?: string };
      const id = `snap-${Date.now()}`;
      meta.snapshots.push({ id, label: body.label, createdAt: new Date().toISOString(), graph: got?.graph ?? null });
      await writeMeta(drive, projectId, meta);
      return NextResponse.json({ id }, { status: 201 });
    }
    return jsonErr('Method not allowed', 405);
  }
  const sid = tail[0];
  const snap = meta.snapshots.find((s) => s.id === sid);
  if (!snap) return jsonErr('Not found', 404);
  if (tail.length === 1) {
    if (method === 'GET') return NextResponse.json({ snapshot: snap });
    if (method === 'DELETE') {
      meta.snapshots = meta.snapshots.filter((s) => s.id !== sid);
      await writeMeta(drive, projectId, meta);
      return new NextResponse(null, { status: 204 });
    }
    return jsonErr('Method not allowed', 405);
  }
  if (tail[1] === 'restore' && method === 'POST') {
    if (!snap.graph) return jsonErr('Snapshot has no graph', 400);
    await writeGraphSidecar(drive, projectId, snap.graph as AgentNodesGraphV1);
    return NextResponse.json({ ok: true });
  }
  return jsonErr('Not found', 404);
}

export async function handleCorpusBindings(drive: drive_v3.Drive, agentId: string) {
  const raw = await readJsonFileById<unknown>(drive, agentId);
  const agent = rawToRuntimeAgent(agentId, raw);
  if (!agent) return jsonErr('Not found', 404);
  const { resolveLayerCorpusId } = await import('../../agentnodes/lib/corpus');
  const bindings = agent.layers.map((l) => ({ layerId: l.id, corpusId: resolveLayerCorpusId(l) || null }));
  return NextResponse.json({ bindings });
}

export async function handleCorpusVerify() {
  return unsupportedLegacyOperation('Corpus binding verification', '/api/rag/corpora');
}

export async function handleCorporaRegistry() {
  return NextResponse.json({ corpora: [], note: 'Use existing RAG registry endpoints in app' }, { status: 501 });
}

export async function handleExportsPost() {
  return unsupportedLegacyOperation('Export jobs', '/api/v1/agentnodes/documents/assemble');
}

export async function handleExportGet(_eid: string) {
  return unsupportedLegacyOperation('Export job results', '/api/v1/agentnodes/exports/json');
}

export async function handleExportDelete() {
  return unsupportedLegacyOperation('Export job deletion');
}

export async function handleExportPackage() {
  return NextResponse.json({ error: 'Use client export wizard' }, { status: 501 });
}

export async function handleExportStructured() {
  return unsupportedLegacyOperation('Structured export jobs', '/api/v1/agentnodes/documents/assemble');
}

export async function handleReviewFromGraph() {
  return NextResponse.json({ error: 'Use POST /api/agentnodes/review' }, { status: 501 });
}

const PROJECT_WEBHOOK_SCOPE = '_project';

export async function handleWebhooksList(drive: drive_v3.Drive, projectId: string) {
  const { meta } = await readOrCreateMeta(drive, projectId, PROJECT_WEBHOOK_SCOPE);
  return NextResponse.json({ subscriptions: meta.webhooks });
}

export async function handleWebhooksPost(drive: drive_v3.Drive, projectId: string, request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { url?: string; events?: string[] };
  const { meta } = await readOrCreateMeta(drive, projectId, PROJECT_WEBHOOK_SCOPE);
  const id = `hook-${Date.now()}`;
  meta.webhooks.push({
    id,
    url: String(body.url ?? ''),
    events: body.events ?? [],
    createdAt: new Date().toISOString(),
  });
  await writeMeta(drive, projectId, meta);
  return NextResponse.json({ id }, { status: 201 });
}

export async function handleWebhooksDelete(drive: drive_v3.Drive, projectId: string, hid: string) {
  const { meta } = await readOrCreateMeta(drive, projectId, PROJECT_WEBHOOK_SCOPE);
  meta.webhooks = meta.webhooks.filter((h) => h.id !== hid);
  await writeMeta(drive, projectId, meta);
  return new NextResponse(null, { status: 204 });
}

export async function handleWebhooksTest() {
  return NextResponse.json({ ok: true, delivered: false });
}

// ── Project ↔ corpus links ────────────────────────────────────────────────
// A project accumulates the corpuses attached to any of its steps (or added
// directly from the corpus manager). Stored in the project-scoped meta sidecar.

type ProjectCorpusLink = NonNullable<AgentnodesMetaV1['corpusLinks']>[number];

export async function handleProjectCorpusLinksList(drive: drive_v3.Drive, projectId: string) {
  const { meta } = await readOrCreateMeta(drive, projectId, PROJECT_WEBHOOK_SCOPE);
  return NextResponse.json({ corpusLinks: meta.corpusLinks ?? [] });
}

export async function handleProjectCorpusLinksAdd(
  drive: drive_v3.Drive,
  projectId: string,
  request: NextRequest,
  callerEmail: string,
) {
  const body = (await request.json().catch(() => ({}))) as {
    corpusId?: string;
    storeName?: string;
    displayName?: string;
    ownerEmail?: string;
  };
  const corpusId = typeof body.corpusId === 'string' ? body.corpusId.trim() : '';
  if (!corpusId) return jsonErr('corpusId is required', 400);

  await upsertProjectCorpusLink(drive, projectId, {
    corpusId,
    storeName: body.storeName,
    displayName: body.displayName,
    ownerEmail: body.ownerEmail,
    addedBy: callerEmail,
  });
  const { meta } = await readOrCreateMeta(drive, projectId, PROJECT_WEBHOOK_SCOPE);
  return NextResponse.json({ corpusLinks: meta.corpusLinks ?? [] }, { status: 201 });
}

// List the (non-sidecar) agent document file ids in a project's AF folder.
async function listProjectAgentFileIds(drive: drive_v3.Drive, projectId: string): Promise<string[]> {
  const af = await ensureAfFolder(drive, projectId);
  const files = await listAfJsonFiles(drive, af);
  return files
    .filter((f) => f.id && f.name && /\.json$/i.test(f.name) && !isAgentSidecarFileName(f.name))
    .map((f) => f.id as string);
}

// Retroactive scan: read every agent in the project, discover corpuses attached to any
// step, and backfill them into the project link list. Idempotent; persists only if changed.
// Build id/corpusId → human name AND id → Gemini store path from the caller's RAG registry
// (one read, best-effort). Lets the scan backfill both the name and the usable store path.
async function buildCorpusNameMap(
  accessToken: string,
  refreshToken: string,
): Promise<{ nameById: Map<string, string>; storeById: Map<string, string> }> {
  const nameById = new Map<string, string>();
  const storeById = new Map<string, string>();
  if (!accessToken) return { nameById, storeById };
  try {
    const auth = createRefreshableAuth(accessToken, refreshToken || undefined);
    const rows = await listFileSearchStores(auth);
    for (const row of rows) {
      const name = corpusRegistryEntryLabel(row);
      const store = typeof row.corpusId === 'string' ? row.corpusId : '';
      if (name) {
        if (row.id) nameById.set(row.id, name);
        if (store) nameById.set(store, name);
      }
      if (store) {
        if (row.id) storeById.set(row.id, store);
        storeById.set(store, store);
      }
    }
  } catch (err) {
    console.warn('[corpus-links/scan] Could not read caller registry for names:', err);
  }
  return { nameById, storeById };
}

export async function handleProjectCorpusLinksScan(
  drive: drive_v3.Drive,
  projectId: string,
  callerEmail: string,
  accessToken = '',
  refreshToken = '',
) {
  const [fileIds, maps] = await Promise.all([
    listProjectAgentFileIds(drive, projectId),
    buildCorpusNameMap(accessToken, refreshToken),
  ]);
  const { nameById, storeById } = maps;
  const discovered: DiscoveredCorpus[] = [];
  const byId = new Map<string, DiscoveredCorpus>();
  for (const fileId of fileIds) {
    const raw = await readJsonFileById<unknown>(drive, fileId);
    const agent = rawToRuntimeAgent(fileId, raw);
    if (!agent) continue;
    for (const d of discoverCorpusesFromLayers(agent.layers)) {
      const existing = byId.get(d.corpusId);
      if (!existing) {
        // Prefer the name on the layer; else resolve from the caller's registry.
        const resolved = d.displayName || nameById.get(d.corpusId);
        const store = d.storeName || storeById.get(d.corpusId);
        byId.set(d.corpusId, { ...d, displayName: resolved || undefined, storeName: store || undefined });
        discovered.push(byId.get(d.corpusId)!);
      } else {
        if (!existing.displayName && (d.displayName || nameById.get(d.corpusId))) {
          existing.displayName = d.displayName || nameById.get(d.corpusId);
        }
        if (!existing.storeName && (d.storeName || storeById.get(d.corpusId))) {
          existing.storeName = d.storeName || storeById.get(d.corpusId);
        }
        if (!existing.ownerEmail && d.ownerEmail) existing.ownerEmail = d.ownerEmail;
      }
    }
  }
  const { meta } = await readOrCreateMeta(drive, projectId, PROJECT_WEBHOOK_SCOPE);
  const now = new Date().toISOString();
  const { links, changed } = mergeDiscoveredCorpusLinks(meta.corpusLinks ?? [], discovered, callerEmail, now);
  if (changed) {
    meta.corpusLinks = links;
    await writeMeta(drive, projectId, meta);
  }
  return NextResponse.json({ corpusLinks: links });
}

// Detach a corpus from every step in every agent of the project (true "remove from project").
// Matches a layer against any of `corpusIds` (registry id or Gemini store name).
export async function detachCorpusFromProjectAgents(
  drive: drive_v3.Drive,
  projectId: string,
  corpusIds: string[],
): Promise<void> {
  const ids = corpusIds.filter(Boolean);
  if (ids.length === 0) return;
  const fileIds = await listProjectAgentFileIds(drive, projectId);
  for (const fileId of fileIds) {
    const raw = await readJsonFileById<unknown>(drive, fileId);
    if (!raw) continue;
    if (isVersionedAgent(raw)) {
      const current = getCurrentVersionLayers(raw);
      let changed = false;
      const layers = current.map((l) => {
        if (!layerReferencesCorpus(l, ids)) return l;
        changed = true;
        return clearCorpusFromLayer(l, ids);
      });
      if (changed) {
        const ts = new Date().toISOString();
        const next = await addVersionToAgent(
          raw,
          { name: raw.agentName, layers, metadata: {} },
          raw.agentName,
          ts,
        );
        await updateAgentFileJson(drive, fileId, next);
      }
    } else if (raw && typeof raw === 'object' && Array.isArray((raw as { layers?: unknown }).layers)) {
      const obj = raw as { layers: Canvas272Layer[]; [k: string]: unknown };
      let changed = false;
      const layers = obj.layers.map((l) => {
        if (!layerReferencesCorpus(l, ids)) return l;
        changed = true;
        return clearCorpusFromLayer(l, ids);
      });
      if (changed) await updateAgentFileJson(drive, fileId, { ...obj, layers });
    }
  }
}

export async function handleProjectCorpusLinksRemove(
  drive: drive_v3.Drive,
  projectId: string,
  corpusId: string,
  callerEmail: string,
) {
  const { meta } = await readOrCreateMeta(drive, projectId, PROJECT_WEBHOOK_SCOPE);
  const links = meta.corpusLinks ?? [];
  const target = links.find((l) => l.corpusId === corpusId || (l.storeName ? l.storeName === corpusId : false));
  if (!target) return jsonErr('Corpus link not found', 404);
  // Only the corpus owner may unlink it from the project (empty owner = anyone).
  const caller = callerEmail.trim().toLowerCase();
  const owner = (target.ownerEmail || '').trim().toLowerCase();
  if (owner && caller && owner !== caller) {
    return jsonErr('Only the corpus owner can remove this corpus from the project', 403);
  }
  // True removal: detach the corpus (by id AND store name) from every step, then drop the link.
  const matchIds = [target.corpusId, target.storeName].filter((x): x is string => Boolean(x));
  await detachCorpusFromProjectAgents(drive, projectId, matchIds);
  meta.corpusLinks = links.filter((l: ProjectCorpusLink) => !matchIds.includes(l.corpusId) && !(l.storeName && matchIds.includes(l.storeName)));
  await writeMeta(drive, projectId, meta);
  return NextResponse.json({ corpusLinks: meta.corpusLinks });
}

export async function handleServerSimulate() {
  return NextResponse.json({ ok: true, steps: [] });
}

export async function handleSimPresets() {
  return NextResponse.json({ presets: ['linear', 'branch'] });
}

export async function handleRunCancel() {
  return unsupportedLegacyExecution();
}

export async function handleRunSteps() {
  return unsupportedLegacyExecution();
}

export async function handleRunStepDetail() {
  return unsupportedLegacyExecution();
}
