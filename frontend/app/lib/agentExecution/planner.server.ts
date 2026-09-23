import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getAgentVersionMetadata, getVersionLayers, isVersionedAgent } from '../versionUtils';
import { DEFAULT_MODEL, getModelInfo, isImageModel } from '../modelConfig';
import { isGalileoModel } from '../stepModels';
import { recordAgentOutput } from '../agentOutputHistory';
import { AgentExecutionError } from './errors';
import { hashValue } from './hash.server';
import { agentSchema, bundleSchema, checkpointSchema, planRequestSchema, planSchema,
  type ExecutionBundle, type ExecutionCheckpoint, type ExecutionPlan, type OutputVersion } from './schema';
import { validateExecutableLayer } from './validation';

export function normalizeAgent(raw: unknown, selectedVersion?: string) {
  if (isVersionedAgent(raw)) {
    const version = selectedVersion ?? raw.currentVersion;
    const selected = raw.versions.find(entry => entry.version === version);
    if (!selected || !Array.isArray(selected.layers)) throw new AgentExecutionError('VERSION_NOT_FOUND', 'The requested saved-agent version is unavailable.', 409);
    return agentSchema.parse({ id: typeof raw.id === 'string' ? raw.id : 'portable-agent', name: selected.name || raw.agentName,
      version, layers: getVersionLayers(raw, version), metadata: getAgentVersionMetadata(raw, version) });
  }
  const agent = agentSchema.parse(raw);
  const version = agent.version ?? agent.currentVersion;
  if (selectedVersion && selectedVersion !== version) throw new AgentExecutionError('VERSION_NOT_FOUND', 'The inline agent does not contain the requested version.', 409);
  return agent;
}

function normalizeBundle(raw: ExecutionBundle) {
  const bundle = bundleSchema.parse(raw);
  const agent = normalizeAgent(bundle.agent, bundle.version);
  agent.layers = agent.layers.map(layer => ({ ...layer, selectedModel: layer.selectedModel ?? DEFAULT_MODEL }));
  const layerIds = new Set(agent.layers.map(layer => layer.id));
  if (layerIds.size !== agent.layers.length) throw new AgentExecutionError('DUPLICATE_STEP', 'Step IDs must be unique.');
  const sources = new Map(bundle.sources.map(source => [source.sourceId, source]));
  if (sources.size !== bundle.sources.length) throw new AgentExecutionError('DUPLICATE_SOURCE', 'Source IDs must be unique.');
  for (const [stepId, sourceIds] of Object.entries(bundle.bindings)) {
    if (!layerIds.has(stepId) || sourceIds.some(sourceId => !sources.has(sourceId)) || new Set(sourceIds).size !== sourceIds.length) {
      throw new AgentExecutionError('INVALID_SOURCE_BINDING', `Invalid source bindings for ${stepId}.`);
    }
  }
  if (new Set(bundle.sharedSourceIds).size !== bundle.sharedSourceIds.length || bundle.sharedSourceIds.some(sourceId => !sources.has(sourceId))) throw new AgentExecutionError('INVALID_SOURCE_BINDING', 'Invalid shared source IDs.');
  if (agent.metadata.fileIds?.some(fileId => !bundle.sharedSourceIds.includes(fileId))) throw new AgentExecutionError('UNBOUND_FILE', 'Download shared Drive files and supply matching source IDs in sharedSourceIds.');
  const used = new Set([...bundle.sharedSourceIds, ...Object.values(bundle.bindings).flat()]);
  if (bundle.sources.some(source => !used.has(source.sourceId))) throw new AgentExecutionError('UNBOUND_SOURCE', 'Every source must be bound explicitly.');
  for (const layer of agent.layers) {
    const effectiveSources = new Set([...bundle.sharedSourceIds, ...(bundle.bindings[layer.id] ?? [])]);
    if (effectiveSources.size > 5) throw new AgentExecutionError('INPUT_TOO_LARGE', `Step ${layer.id} exceeds five combined files.`, 413);
    if (Array.isArray(layer.fileIds) && layer.fileIds.some(fileId => typeof fileId !== 'string' || !effectiveSources.has(fileId))) throw new AgentExecutionError('UNBOUND_FILE', `Bind files explicitly for ${layer.id}.`);
  }
  const skills = new Map(bundle.skills.map(skill => [skill.id, skill]));
  if (skills.size !== bundle.skills.length) throw new AgentExecutionError('DUPLICATE_SKILL', 'Skill IDs must be unique.');
  for (const skillId of agent.metadata.skillIds ?? []) {
    if (!skills.has(skillId)) throw new AgentExecutionError('UNRESOLVED_SKILL', `Supply resolved text for skill ${skillId}.`);
  }
  for (const reference of agent.metadata.skillRefs ?? []) {
    if (skills.get(reference.skillId)?.version !== String(reference.version)) throw new AgentExecutionError('UNRESOLVED_SKILL', `Supply the pinned version of skill ${reference.skillId}.`);
  }
  return { ...bundle, agent };
}

export function createExecutionPlan(raw: unknown, identity?: { runId: string; createdAt: string }): ExecutionPlan {
  const parsed = planRequestSchema.parse(raw);
  const bundle = normalizeBundle(parsed.bundle);
  const { agent } = bundle;
  const layers = [...agent.layers].sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
  const layerIds = new Set(layers.map(layer => layer.id));
  const dependencies = Object.fromEntries(layers.map(layer => [layer.id, [...new Set(layer.referencedSteps)]]));
  for (const layer of layers) {
    if (layer.referencedSteps.some(reference => !layerIds.has(reference))) throw new AgentExecutionError('DANGLING_REFERENCE', `Step ${layer.id} references a missing step.`);
  }
  if (bundle.graph) {
    const nodes = new Map(bundle.graph.nodes.map(node => [node.id, node.data.layerId]));
    if (nodes.size !== bundle.graph.nodes.length) throw new AgentExecutionError('INVALID_GRAPH', 'Graph node IDs must be unique.');
    const mapped = bundle.graph.nodes.flatMap(node => node.data.layerId ? [node.data.layerId] : []);
    if (mapped.some(stepId => !layerIds.has(stepId)) || new Set(mapped).size !== mapped.length) throw new AgentExecutionError('INVALID_GRAPH', 'Graph step mappings must be unique and refer to existing steps.');
    for (const edge of bundle.graph.edges) {
      const source = nodes.get(edge.source);
      const target = nodes.get(edge.target);
      if (!source || !target) throw new AgentExecutionError('UNSUPPORTED_GRAPH_EDGE', 'Execution edges must connect mapped steps; bind source nodes explicitly as inputs.');
      if (!dependencies[target].includes(source)) dependencies[target].push(source);
    }
  }
  const pending = new Set(layers.map(layer => layer.id));
  const ordered: string[] = [];
  while (pending.size) {
    const next = layers.find(layer => pending.has(layer.id) && dependencies[layer.id].every(reference => !pending.has(reference)));
    if (!next) throw new AgentExecutionError('CYCLIC_DEPENDENCY', 'Step references and graph edges contain a cycle.');
    ordered.push(next.id);
    pending.delete(next.id);
  }
  if (Object.keys(parsed.previousOutputs).some(stepId => !layerIds.has(stepId))) throw new AgentExecutionError('INVALID_PINNED_OUTPUT', 'Pinned outputs must belong to an existing step.');
  if (parsed.stepId && (!layerIds.has(parsed.stepId) || parsed.previousOutputs[parsed.stepId])) throw new AgentExecutionError('INVALID_STEP_SELECTION', 'Select an existing step that is not also pinned.');
  const selected = layers.filter(layer => parsed.stepId ? layer.id === parsed.stepId : layer.isActive !== false && !layer.isFrozen && !parsed.previousOutputs[layer.id]);
  const selectedIds = new Set(selected.map(layer => layer.id));
  for (const layer of selected) {
    validateExecutableLayer(layer);
    const model = layer.selectedModel ?? DEFAULT_MODEL;
    if (!isGalileoModel(model) && !isImageModel(model) && !getModelInfo(model)?.maxInputTokens) throw new AgentExecutionError('UNSUPPORTED_MODEL', `Step ${layer.id} has no supported model with known input limits.`);
    if (dependencies[layer.id].some(reference => !selectedIds.has(reference) && !parsed.previousOutputs[reference])) throw new AgentExecutionError('MISSING_PREREQUISITE', `Step ${layer.id} needs a pinned output for an inactive, frozen or unselected prerequisite.`);
  }
  const content = {
    schemaVersion: 1 as const, runId: identity?.runId ?? randomUUID(), createdAt: identity?.createdAt ?? new Date().toISOString(),
    request: { ...parsed, bundle }, order: ordered.filter(stepId => selectedIds.has(stepId)), dependencies,
  };
  return planSchema.parse({ ...content, planHash: hashValue(content) });
}

export function verifyExecutionPlan(raw: unknown) {
  const plan = planSchema.parse(raw);
  const expected = createExecutionPlan(plan.request, plan);
  if (hashValue(plan) !== hashValue(expected)) throw new AgentExecutionError('PLAN_CONFLICT', 'The frozen plan was changed. Create a new plan for changed configuration.', 409);
  return plan;
}

export function createCheckpoint(plan: ExecutionPlan): ExecutionCheckpoint {
  return { schemaVersion: 1, runId: plan.runId, planHash: plan.planHash, revision: 0,
    status: plan.order.length ? 'ready' : 'completed', completed: [], attempts: [] };
}

export function checkpointOutputs(plan: ExecutionPlan, checkpoint: ExecutionCheckpoint): Record<string, OutputVersion> {
  return { ...plan.request.previousOutputs, ...Object.fromEntries(checkpoint.completed.map(receipt => [receipt.stepId, receipt.output])) };
}

export function verifyCheckpoint(raw: unknown, plan: ExecutionPlan) {
  const checkpoint = checkpointSchema.parse(raw);
  if (checkpoint.runId !== plan.runId || checkpoint.planHash !== plan.planHash || checkpoint.revision !== checkpoint.attempts.length) throw new AgentExecutionError('CHECKPOINT_CONFLICT', 'The checkpoint does not match this plan.', 409);
  const agent = normalizeAgent(plan.request.bundle.agent);
  const completedAttempts = checkpoint.attempts.filter(attempt => attempt.status === 'succeeded');
  if (checkpoint.completed.length > plan.order.length || completedAttempts.length !== checkpoint.completed.length || new Set(checkpoint.attempts.map(attempt => attempt.attemptId)).size !== checkpoint.attempts.length) throw new AgentExecutionError('CHECKPOINT_CONFLICT', 'Checkpoint attempts are inconsistent.', 409);
  let completionIndex = 0;
  for (const attempt of checkpoint.attempts) {
    if (attempt.stepId !== plan.order[completionIndex]) throw new AgentExecutionError('CHECKPOINT_CONFLICT', 'Checkpoint attempts are out of execution order.', 409);
    if (attempt.status === 'succeeded') completionIndex += 1;
  }
  checkpoint.completed.forEach((receipt, index) => {
    if (receipt.stepId !== plan.order[index] || receipt.attemptId !== completedAttempts[index].attemptId) throw new AgentExecutionError('CHECKPOINT_CONFLICT', 'Completed steps must be an ordered prefix of the plan.', 409);
    const layer = agent.layers.find(entry => entry.id === receipt.stepId)!;
    const updated = recordAgentOutput(layer, receipt.output, receipt.output.timestamp);
    if (updated.outputHistory.at(-1)?.version !== receipt.output.version) throw new AgentExecutionError('CHECKPOINT_CONFLICT', 'Output history version does not match the frozen step.', 409);
  });
  const expectedStatus = checkpoint.completed.length === plan.order.length ? 'completed' : checkpoint.attempts.at(-1)?.status === 'failed' ? 'failed' : 'ready';
  if (checkpoint.status !== expectedStatus) throw new AgentExecutionError('CHECKPOINT_CONFLICT', 'Checkpoint status does not match its completed steps.', 409);
  return checkpoint;
}

export function materializeAgent(plan: ExecutionPlan, checkpoint: ExecutionCheckpoint) {
  const agent = normalizeAgent(plan.request.bundle.agent);
  const outputs = checkpointOutputs(plan, checkpoint);
  return { ...agent, layers: agent.layers.map(layer => {
    const output = outputs[layer.id];
    if (!output) return layer;
    if (checkpoint.completed.some(receipt => receipt.stepId === layer.id)) return recordAgentOutput(layer, output, output.timestamp);
    return { ...layer, result: output.result, imageUrls: output.imageUrls };
  }) };
}

export function nextStepInputs(plan: ExecutionPlan, checkpoint: ExecutionCheckpoint) {
  const stepId = plan.order[checkpoint.completed.length];
  if (!stepId) return null;
  const sourceIds = new Set([...plan.request.bundle.sharedSourceIds, ...(plan.request.bundle.bindings[stepId] ?? [])]);
  return { stepId, sources: plan.request.bundle.sources.filter(source => sourceIds.has(source.sourceId)) };
}

export const advanceSchema = z.object({ plan: planSchema, checkpoint: checkpointSchema,
  attemptId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/).optional(), retryFailed: z.boolean().default(false) }).strict();