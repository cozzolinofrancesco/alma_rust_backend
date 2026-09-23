'use client';

import type { AgentRunOutcome, AgentRunVersioning } from '../../ai-agents/hooks/useAgentRunVersioning';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Edge, Node } from 'reactflow';
import type { Canvas272Agent, Canvas272Layer } from '../../canvas-272/lib/types';
import type { AgentNodeData } from '../lib/types';
import { resolveLayerCorpusId, collectCorpusIdCandidatesFromLayer, collectLayerCorpusDisplayHints } from '../lib/corpus';
import { useAppBusyOptional } from '../../contexts/AppBusyContext';
import { resolveStepModel, isImageModel } from '../../lib/modelConfig';
import { buildStepMessagesPayload, buildStepImagePrompt, buildReferencedStepsContext, combineSkillsWithSystemInstruction, type StepPromptLayer } from '../../lib/stepPrompt';
import { generateStepImages, dataUrlToInlineData, type InlineImage } from '../../lib/imageGen';
import { getLayerImageUrls } from '../../canvas-272/lib/layerOutput';
import { resolveSubsetFilter } from '../../rag-optimization/lib/metadataFilter';
import { fetchCorpusDocsForFilter } from '../../rag-optimization/lib/corpusDocs';
import { isGalileoModel } from '../../lib/stepModels';
import { assertStepModelReady, getGalileoGenerationSettings, getStepEndpoint, getStepFailureDiagnostics, readStepRunResponse } from '../../lib/stepExecution';
import { hasAgentInputs, snapshotAgentInputMetadata, type AgentInputSnapshot } from '../../lib/agentInputs';
import { prepareAgentInputSnapshot } from '../../lib/agentFilesApi';
import { fetchWithAgentInputs, getLocalCorpusInputs, prepareAgentImagePrompt } from '../../lib/agentInputsClient';

interface LayerState {
  running: boolean;
  done: boolean;
  failed: boolean;
}

export interface GraphRunnerProgress {
  current: number;
  total: number;
  currentStepName: string;
}

function buildTopoOrder(
  agentLayers: Canvas272Layer[],
  nodes: Node<AgentNodeData>[],
  edges: Edge[],
): string[] {
  const layerIdByNodeId = new Map<string, string>();
  for (const n of nodes) {
    if (n.data.layerId) layerIdByNodeId.set(n.id, n.data.layerId);
  }

  const allIds = new Set(agentLayers.map((l) => l.id));
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const l of agentLayers) {
    inDeg.set(l.id, 0);
    adj.set(l.id, []);
  }

  for (const e of edges) {
    const src = layerIdByNodeId.get(e.source);
    const tgt = layerIdByNodeId.get(e.target);
    if (!src || !tgt || !allIds.has(src) || !allIds.has(tgt)) continue;
    adj.get(src)!.push(tgt);
    inDeg.set(tgt, (inDeg.get(tgt) ?? 0) + 1);
  }

  const queue: string[] = [];
  inDeg.forEach((d, id) => {
    if (d === 0) queue.push(id);
  });
  const order: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const nb of adj.get(cur) ?? []) {
      const nd = (inDeg.get(nb) ?? 0) - 1;
      inDeg.set(nb, nd);
      if (nd === 0) queue.push(nb);
    }
  }

  for (const l of agentLayers) {
    if (!order.includes(l.id)) order.push(l.id);
  }

  return order;
}

// Build the referenced-step context using the SAME formatting/cap as the form
// view, sourcing results from the in-run stepResults map.
function buildContextText(
  layer: Canvas272Layer,
  stepResults: Map<string, string>,
  allLayers: Canvas272Layer[],
): string {
  const layerMap = new Map(allLayers.map((l) => [l.id, l]));
  return buildReferencedStepsContext(layer.referencedSteps, {
    getName: (refId) => layerMap.get(refId)?.name,
    getResult: (refId) => stepResults.get(refId),
  }).text;
}

function readLayerRagKnowledge(layer: Canvas272Layer): unknown[] {
  const v = (layer as unknown as Record<string, unknown>).ragKnowledge;
  return Array.isArray(v) ? v : [];
}

function buildRequestBody(
  layer: Canvas272Layer,
  stepResults: Map<string, string>,
  allLayers: Canvas272Layer[],
  projectId: string | null,
  agentSkills: readonly string[],
): Record<string, unknown> {
  const contextText = buildContextText(layer, stepResults, allLayers);
  const { messages, systemInstruction } = buildStepMessagesPayload(layer as unknown as StepPromptLayer, contextText, agentSkills);

  const body: Record<string, unknown> = {
    messages,
    model: resolveStepModel(layer.selectedModel),
    ...getGalileoGenerationSettings(layer.selectedModel, layer),
    ragKnowledge: readLayerRagKnowledge(layer),
    // Reuse an explicit context cache for the stable system instruction across
    // re-runs. The server gates this (no tools, system block above the model's
    // minimum cacheable size) and primes the cache in the background.
    enablePromptCache: true,
  };

  if (systemInstruction) body.systemInstruction = systemInstruction;
  if (projectId) body.projectId = projectId;

  return body;
}

// Compose the text prompt for an image step, reusing the same message assembly
// as text steps (user instruction + referenced-step context + skills).
function buildImagePrompt(
  layer: Canvas272Layer,
  stepResults: Map<string, string>,
  allLayers: Canvas272Layer[],
  agentSkills: readonly string[],
): string {
  const contextText = buildContextText(layer, stepResults, allLayers);
  const { messages, systemInstruction } = buildStepMessagesPayload(layer as unknown as StepPromptLayer, contextText, agentSkills);
  return buildStepImagePrompt(messages, systemInstruction);
}

// Base image for image-to-image: the first generated image among the step's
// referenced upstream steps (uploads are editor-only; Run All has no file input).
function firstReferencedImage(
  layer: Canvas272Layer,
  layerMap: Map<string, Canvas272Layer>,
): InlineImage | null {
  for (const refId of layer.referencedSteps ?? []) {
    const ref = layerMap.get(refId);
    const url = ref ? getLayerImageUrls(ref)[0] : undefined;
    if (url) {
      const inline = dataUrlToInlineData(url);
      if (inline) return inline;
    }
  }
  return null;
}

async function buildRagRequestBody(
  layer: Canvas272Layer,
  stepResults: Map<string, string>,
  allLayers: Canvas272Layer[],
  corpusId: string,
  projectId: string | null,
  agentSkills: readonly string[],
): Promise<{ corpusId: string; corpusIds: string[]; corpusDisplayHints: string[]; messages: unknown[]; systemInstruction?: string; model: string; metadataFilter?: string; projectId?: string }> {
  const contextText = buildContextText(layer, stepResults, allLayers);
  const { messages } = buildStepMessagesPayload(layer as unknown as StepPromptLayer, contextText, agentSkills);

  const sysInstructionParts: string[] = [];
  if (layer.userInstruction?.trim()) sysInstructionParts.push(layer.userInstruction.trim());
  const layerSysInstruction = (layer as { systemInstruction?: string }).systemInstruction?.trim();
  if (layerSysInstruction) sysInstructionParts.push(layerSysInstruction);
  if (contextText.trim()) sysInstructionParts.push(contextText.trim());
  const systemInstruction = combineSkillsWithSystemInstruction(sysInstructionParts.join('\n\n'), agentSkills) || undefined;

  const documentSelections = (() => {
    const v = (layer as unknown as Record<string, unknown>).documentSelections;
    return Array.isArray(v) ? (v.filter((x) => typeof x === 'string') as string[]) : [];
  })();
  // Resolve the subset to a stable file_id filter (pdf_name fallback for old corpora).
  // If we can't fetch the doc list, search the whole corpus rather than risk a dead filter.
  let metadataFilter: string | undefined;
  if (documentSelections.length > 0) {
    const allDocs = await fetchCorpusDocsForFilter(corpusId);
    if (allDocs.length > 0) {
      const subset = resolveSubsetFilter(documentSelections, allDocs);
      if (subset.action === 'block') {
        throw new Error('Selected documents are not in this corpus (metadata mismatch). Re-select the documents, or open the RAG Knowledge Manager to Verify and self-heal this corpus.');
      }
      metadataFilter = subset.filter;
    }
  }

  // Send every corpus id the layer could refer to, not just the single
  // `resolveLayerCorpusId` pick. A stale/legacy primary id fails
  // `getCorpusById` and 404s the step; the query route resolves each candidate
  // and keeps the ones that exist. Mirrors the editor's corpus resolution.
  const candidateCorpusIds = collectCorpusIdCandidatesFromLayer(layer);
  const corpusIds = candidateCorpusIds.length > 0 ? candidateCorpusIds : [corpusId];

  return {
    corpusId,
    corpusIds,
    // Cross-user resolution hint: lets a project member run corpora created by
    // other users when the id can't be resolved via their own registry. Mirrors
    // the editor run path (see /api/rag/query).
    corpusDisplayHints: collectLayerCorpusDisplayHints(layer),
    messages,
    systemInstruction,
    model: resolveStepModel(layer.selectedModel),
    ...getGalileoGenerationSettings(layer.selectedModel, layer),
    metadataFilter,
    ...(projectId ? { projectId } : {}),
  };
}

export function useGraphRunner({
  agent,
  nodes,
  edges,
  projectId,
  agentSkillTexts,
  inputScopeKey,
  runVersioning,
  onLayerResult,
}: {
  agent: Canvas272Agent | null;
  nodes: Node<AgentNodeData>[];
  edges: Edge[];
  projectId: string | null;
  agentSkillTexts?: readonly string[];
  inputScopeKey?: string;
  runVersioning?: AgentRunVersioning | null;
  /**
    * Persist every completed output back to its layer. Optional for back-compat.
   */
  onLayerResult?: (layerId: string, patch: Partial<Canvas272Layer>) => void;
}) {
  const [stateMap, setStateMap] = useState<Map<string, LayerState>>(new Map());
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<GraphRunnerProgress>({
    current: 0,
    total: 0,
    currentStepName: '',
  });
  const cancelRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const runSequenceRef = useRef(0);

  useEffect(() => {
    setIsRunning(false);
    setError(null);
    return () => {
      runSequenceRef.current += 1;
      abortRef.current?.abort();
    };
  }, [agent?.id, projectId, inputScopeKey]);

  const runningLayerIds = useMemo<ReadonlySet<string>>(() => {
    const s = new Set<string>();
    stateMap.forEach((v, k) => {
      if (v.running) s.add(k);
    });
    return s;
  }, [stateMap]);

  const completedLayerIds = useMemo<ReadonlySet<string>>(() => {
    const s = new Set<string>();
    stateMap.forEach((v, k) => {
      if (v.done) s.add(k);
    });
    return s;
  }, [stateMap]);

  const failedLayerIds = useMemo<ReadonlySet<string>>(() => {
    const s = new Set<string>();
    stateMap.forEach((v, k) => {
      if (v.failed) s.add(k);
    });
    return s;
  }, [stateMap]);

  const runAll = useCallback(async (): Promise<AgentRunOutcome> => {
    const outcome: AgentRunOutcome = { successful: [], failed: [], cancelled: false };
    if (!agent || isRunning) return outcome;

    const layers = agent.layers;
    if (!layers.length) return outcome;

    const order = buildTopoOrder(layers, nodes, edges);
    const versionRun = runVersioning?.beginRun(layers.map(layer => layer.id));
    if (runVersioning && !versionRun) return outcome;
    const runLayers = (versionRun?.snapshot.layers ?? layers) as Canvas272Layer[];
    const layerMap = new Map(runLayers.map(layer => [layer.id, layer]));
    const isRunCurrent = () => !runVersioning || runVersioning.isRunCurrent(versionRun ?? null);
    const skillTexts = agentSkillTexts ?? [];
    const selection = snapshotAgentInputMetadata(agent.metadata);
    const useSharedInputs = hasAgentInputs(selection);
    let sharedSnapshot: AgentInputSnapshot | undefined;

    const runSequence = ++runSequenceRef.current;
    cancelRef.current = false;
    setIsRunning(true);
    setError(null);
    setStateMap(new Map());
    setProgress({ current: 0, total: order.length, currentStepName: '' });

    const stepResults = new Map<string, string>();

    for (let i = 0; i < order.length; i++) {
      if (cancelRef.current || runSequence !== runSequenceRef.current || !isRunCurrent()) break;

      const layerId = order[i];
      const layer = layerMap.get(layerId);
      if (!layer) continue;

      const startedAt = new Date().toISOString();
      const model = resolveStepModel(layer.selectedModel);
      const controller = new AbortController();
      abortRef.current = controller;
      if (layer.lastRunDiagnostics) onLayerResult?.(layerId, { lastRunDiagnostics: undefined });
      setStateMap((prev) => new Map(prev).set(layerId, { running: true, done: false, failed: false }));
      setProgress({ current: i + 1, total: order.length, currentStepName: layer.name });

      try {
        if (isGalileoModel(model)) await assertStepModelReady(model, controller.signal);
        if (useSharedInputs && !sharedSnapshot) sharedSnapshot = await prepareAgentInputSnapshot(selection, controller.signal);
        if (controller.signal.aborted || runSequence !== runSequenceRef.current || !isRunCurrent()) break;
        const localCorpora = getLocalCorpusInputs(resolveLayerCorpusId(layer), layer.documentSelections, projectId);
        if (isImageModel(layer.selectedModel)) {
          const prompt = sharedSnapshot
            ? await prepareAgentImagePrompt(sharedSnapshot, buildRequestBody(layer, stepResults, layers, projectId, skillTexts), [], localCorpora, controller.signal)
            : buildImagePrompt(layer, stepResults, layers, skillTexts);
          const base = firstReferencedImage(layer, layerMap);
          const { imageUrls, text } = await generateStepImages({ prompt, model, base });
          if (controller.signal.aborted || runSequence !== runSequenceRef.current || !isRunCurrent()) break;
          stepResults.set(layerId, text ?? '');
          onLayerResult?.(layerId, { result: text ?? '', imageUrls });
          outcome.successful.push(layerId);
          setStateMap((prev) => new Map(prev).set(layerId, { running: false, done: true, failed: false }));
          continue;
        }

        const corpusId = resolveLayerCorpusId(layer);
        let res: Response;

        if (sharedSnapshot) {
          res = await fetchWithAgentInputs(sharedSnapshot, buildRequestBody(layer, stepResults, layers, projectId, skillTexts), [], localCorpora, controller.signal);
        } else if (corpusId) {
          const ragBody = await buildRagRequestBody(layer, stepResults, layers, corpusId, projectId, skillTexts);
          const documentSelections = (() => {
            const v = (layer as unknown as Record<string, unknown>).documentSelections;
            return Array.isArray(v) ? (v as unknown[]).filter((x) => typeof x === 'string') : [];
          })();
          console.log(
            `[GraphRunner][Corpus] step="${layer.name}" corpusId=${corpusId}` +
            ` docs=${documentSelections.length} filter=${ragBody.metadataFilter ?? 'none'}`,
          );
          res = await fetch(getStepEndpoint(model, true), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ragBody),
            credentials: 'include',
            signal: controller.signal,
          });
        } else {
          res = await fetch(getStepEndpoint(model), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildRequestBody(layer, stepResults, layers, projectId, skillTexts)),
            signal: controller.signal,
          });
        }

        const data = await readStepRunResponse(res, false, model);
        if (controller.signal.aborted || runSequence !== runSequenceRef.current || !isRunCurrent()) break;
        const result = data.response?.trim() ?? '';
        stepResults.set(layerId, result);
        onLayerResult?.(layerId, { result, imageUrls: [], ...(data.runDiagnostics ? { lastRunDiagnostics: data.runDiagnostics } : {}) });
        outcome.successful.push(layerId);

        setStateMap((prev) => new Map(prev).set(layerId, { running: false, done: true, failed: false }));
      } catch (err) {
        if (runSequence !== runSequenceRef.current || !isRunCurrent()) break;
        const diagnostics = getStepFailureDiagnostics(err, model, startedAt);
        if (diagnostics) onLayerResult?.(layerId, { lastRunDiagnostics: diagnostics });
        // User cancel aborts the in-flight query — stop cleanly, don't mark failed.
        if (err instanceof Error && err.name === 'AbortError') {
          outcome.cancelled = true;
          setStateMap((prev) => new Map(prev).set(layerId, { running: false, done: false, failed: false }));
          break;
        }
        console.error(`[GraphRunner] Step "${layer.name}" failed:`, err);
        outcome.failed.push({ id: layerId, error: err instanceof Error ? err.message : 'Step input processing failed.' });
        setError(err instanceof Error ? err.message : 'Step input processing failed.');
        setStateMap((prev) => new Map(prev).set(layerId, { running: false, done: false, failed: true }));
        if (useSharedInputs && !sharedSnapshot) break;
      }
    }

    outcome.cancelled = outcome.cancelled || cancelRef.current || runSequence !== runSequenceRef.current
      || Boolean(abortRef.current?.signal.aborted) || !isRunCurrent();
    await runVersioning?.completeRun(versionRun ?? null, outcome);
    if (runSequence !== runSequenceRef.current) return outcome;
    abortRef.current = null;
    setIsRunning(false);
    setProgress((prev) => ({ ...prev, currentStepName: '' }));
    return outcome;
  }, [agent, isRunning, nodes, edges, projectId, agentSkillTexts, onLayerResult, runVersioning]);

  const cancelRun = useCallback(() => {
    cancelRef.current = true;
    abortRef.current?.abort();
    setIsRunning(false);
    setStateMap((prev) => {
      const next = new Map(prev);
      next.forEach((v, k) => {
        if (v.running) next.set(k, { running: false, done: false, failed: true });
      });
      return next;
    });
    setProgress((prev) => ({ ...prev, currentStepName: '' }));
  }, []);

  const resetRunState = useCallback(() => {
    setStateMap(new Map());
    setProgress({ current: 0, total: 0, currentStepName: '' });
  }, []);

  const clearLayerRunState = useCallback((layerId: string) => {
    setStateMap(previous => {
      const next = new Map(previous);
      next.delete(layerId);
      return next;
    });
  }, []);

  const { registerBusy, unregisterBusy } = useAppBusyOptional();
  useEffect(() => {
    const busyId = 'agentnodes-graph-run';
    if (isRunning) registerBusy(busyId);
    else unregisterBusy(busyId);
    return () => unregisterBusy(busyId);
  }, [isRunning, registerBusy, unregisterBusy]);

  return {
    runAll,
    cancelRun,
    resetRunState,
    clearLayerRunState,
    isRunning,
    error,
    progress,
    runningLayerIds,
    completedLayerIds,
    failedLayerIds,
  };
}
