'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Edge, Node } from 'reactflow';
import type { Canvas272Agent } from '../../canvas-272/lib/types';
import type { AgentNodeData } from '../lib/types';
import type { GraphRunnerProgress } from './useGraphRunner';
import { useAppBusyOptional } from '../../contexts/AppBusyContext';

export const STEP_DURATION_MS = 1800;

function buildTopoOrder(
  agentLayers: { id: string }[],
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
  inDeg.forEach((d, id) => { if (d === 0) queue.push(id); });

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

export function useSimulateRun({
  agent,
  nodes,
  edges,
}: {
  agent: Canvas272Agent | null;
  nodes: Node<AgentNodeData>[];
  edges: Edge[];
}) {
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [isSimulating, setIsSimulating] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [progress, setProgress] = useState<GraphRunnerProgress>({
    current: 0,
    total: 0,
    currentStepName: '',
  });

  const cancelRef = useRef(false);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const orderRef = useRef<string[]>([]);
  const layerMapRef = useRef<Map<string, Canvas272Agent['layers'][number]>>(new Map());
  const completedRef = useRef<Set<string>>(new Set());
  const currentStepIndexRef = useRef(0);
  const stepStartedAtRef = useRef(0);
  const runStepRef = useRef<(stepIndex: number) => void>(() => {});

  const clearTimer = useCallback(() => {
    if (pendingTimerRef.current !== null) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
  }, []);

  const simulateAll = useCallback(() => {
    if (!agent || isSimulating) return;
    const layers = agent.layers;
    if (!layers.length) return;

    const order = buildTopoOrder(layers, nodes, edges);
    const layerMap = new Map(layers.map((l) => [l.id, l]));

    cancelRef.current = false;
    setIsPaused(false);
    setIsSimulating(true);
    setRunningIds(new Set());
    completedRef.current = new Set();
    setCompletedIds(new Set());
    setProgress({ current: 0, total: order.length, currentStepName: '' });

    orderRef.current = order;
    layerMapRef.current = layerMap;

    const runStep = (stepIndex: number) => {
      if (cancelRef.current || stepIndex >= order.length) {
        clearTimer();
        setRunningIds(new Set());
        setIsSimulating(false);
        setIsPaused(false);
        setProgress((prev) => ({ ...prev, currentStepName: '' }));
        return;
      }

      const layerId = order[stepIndex];
      const layer = layerMap.get(layerId);

      if (!layer) {
        runStep(stepIndex + 1);
        return;
      }

      currentStepIndexRef.current = stepIndex;
      stepStartedAtRef.current = Date.now();
      setRunningIds(new Set([layerId]));
      setProgress({ current: stepIndex + 1, total: order.length, currentStepName: layer.name });

      pendingTimerRef.current = setTimeout(() => {
        if (cancelRef.current) return;
        completedRef.current.add(layerId);
        setCompletedIds(new Set(completedRef.current));
        runStep(stepIndex + 1);
      }, STEP_DURATION_MS);
    };

    runStepRef.current = runStep;
    runStep(0);
  }, [agent, isSimulating, nodes, edges, clearTimer]);

  const pauseSimulate = useCallback(() => {
    if (!isSimulating || isPaused) return;
    setIsPaused(true);
    clearTimer();
  }, [isSimulating, isPaused, clearTimer]);

  const resumeSimulate = useCallback(() => {
    if (!isSimulating || !isPaused) return;
    setIsPaused(false);

    const order = orderRef.current;
    const layerMap = layerMapRef.current;
    const idx = currentStepIndexRef.current;
    const layerId = order[idx];
    const layer = layerId ? layerMap.get(layerId) : undefined;

    const runStep = runStepRef.current;
    const remaining = Math.max(
      0,
      STEP_DURATION_MS - (Date.now() - stepStartedAtRef.current),
    );

    const finishAndAdvance = () => {
      if (cancelRef.current) return;
      if (layer) {
        completedRef.current.add(layer.id);
        setCompletedIds(new Set(completedRef.current));
      }
      runStep(idx + 1);
    };

    if (!layer) {
      runStep(idx + 1);
      return;
    }

    if (remaining <= 0) {
      finishAndAdvance();
      return;
    }

    pendingTimerRef.current = setTimeout(finishAndAdvance, remaining);
  }, [isSimulating, isPaused]);

  const cancelSimulate = useCallback(() => {
    cancelRef.current = true;
    clearTimer();
    setRunningIds(new Set());
    setIsSimulating(false);
    setIsPaused(false);
    setProgress((prev) => ({ ...prev, currentStepName: '' }));
  }, [clearTimer]);

  const resetSimulateState = useCallback(() => {
    setRunningIds(new Set());
    setCompletedIds(new Set());
    setIsPaused(false);
    setProgress({ current: 0, total: 0, currentStepName: '' });
  }, []);

  const runningLayerIds = useMemo<ReadonlySet<string>>(() => runningIds, [runningIds]);
  const completedLayerIds = useMemo<ReadonlySet<string>>(() => completedIds, [completedIds]);

  const { registerBusy, unregisterBusy } = useAppBusyOptional();
  useEffect(() => {
    const busyId = 'agentnodes-simulate';
    if (isSimulating) registerBusy(busyId);
    else unregisterBusy(busyId);
    return () => unregisterBusy(busyId);
  }, [isSimulating, registerBusy, unregisterBusy]);

  return {
    simulateAll,
    pauseSimulate,
    resumeSimulate,
    cancelSimulate,
    resetSimulateState,
    isSimulating,
    isPaused,
    progress,
    runningLayerIds,
    completedLayerIds,
  };
}
