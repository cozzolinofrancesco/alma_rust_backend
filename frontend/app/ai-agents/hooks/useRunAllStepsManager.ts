'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useAppBusyOptional } from '../../contexts/AppBusyContext';
import type { AgentRunOutcome } from './useAgentRunVersioning';

export interface AgentLayer {
  id: string;
  name: string;
  userInstruction: string;
  referencedSteps: string[];
  result?: string;
}

export interface RunAllProgress {
  current: number;
  total: number;
  currentStepName: string;
  currentStepId: string;
  completedSteps: string[];
  failedSteps: { id: string; error: string }[];
  isRunning: boolean;
  isCancelled: boolean;
}

export interface RunAllCallbacks {
  runStep: (stepId: string, stepResults?: Map<string, string>) => Promise<string | undefined>;
  onProgress: (progress: RunAllProgress) => void;
  onComplete: (results: { successful: string[]; failed: { id: string; error: string }[] }) => void;
  onError: (error: string) => void;
}

export interface UseRunAllStepsManagerReturn {
  progress: RunAllProgress;
  runAllSteps: (layers: AgentLayer[]) => Promise<AgentRunOutcome>;
  cancelExecution: () => void;
  isRunning: boolean;
}

export const useRunAllStepsManager = (callbacks: RunAllCallbacks): UseRunAllStepsManagerReturn => {
  const cancelledRef = useRef(false);
  const runSequenceRef = useRef(0);
  useEffect(() => () => {
    cancelledRef.current = true;
    runSequenceRef.current += 1;
  }, []);
  const [progress, setProgress] = useState<RunAllProgress>({
    current: 0,
    total: 0,
    currentStepName: '',
    currentStepId: '',
    completedSteps: [],
    failedSteps: [],
    isRunning: false,
    isCancelled: false,
  });

  const { registerBusy, unregisterBusy } = useAppBusyOptional();
  useEffect(() => {
    const id = 'ai-agents-run-all';
    if (progress.isRunning) registerBusy(id);
    else unregisterBusy(id);
    return () => unregisterBusy(id);
  }, [progress.isRunning, registerBusy, unregisterBusy]);

  const validateSteps = (layers: AgentLayer[]): string[] => {
    const errors: string[] = [];
    
    layers.forEach((layer, index) => {
      if (!layer.userInstruction?.trim()) {
        errors.push(`Step ${index + 1} (${layer.name || 'Unnamed'}) is missing a user instruction`);
      }
    });

    return errors;
  };

  const detectCircularDependencies = (layers: AgentLayer[]): string[] => {
    const layerMap = new Map(layers.map(l => [l.id, l]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const errors: string[] = [];

    const dfs = (layerId: string, path: string[]) => {
      if (visiting.has(layerId)) {
        const cycleStart = path.indexOf(layerId);
        const cycle = path.slice(cycleStart).concat(layerId);
        errors.push(`Circular dependency detected: ${cycle.map(id => layerMap.get(id)?.name || id).join(' → ')}`);
        return;
      }

      if (visited.has(layerId)) {
        return;
      }

      visiting.add(layerId);
      const layer = layerMap.get(layerId);
      
      if (layer?.referencedSteps) {
        for (const refId of layer.referencedSteps) {
          if (layerMap.has(refId)) {
            dfs(refId, [...path, layerId]);
          }
        }
      }

      visiting.delete(layerId);
      visited.add(layerId);
    };

    layers.forEach(layer => {
      if (!visited.has(layer.id)) {
        dfs(layer.id, []);
      }
    });

    return errors;
  };

  const calculateExecutionOrder = (layers: AgentLayer[]): string[] => {
    const layerMap = new Map(layers.map(l => [l.id, l]));
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();
    
    layers.forEach(layer => {
      inDegree.set(layer.id, 0);
      adjList.set(layer.id, []);
    });

    layers.forEach(layer => {
      if (layer.referencedSteps) {
        layer.referencedSteps.forEach(refId => {
          if (layerMap.has(refId)) {
            adjList.get(refId)?.push(layer.id);
            inDegree.set(layer.id, (inDegree.get(layer.id) || 0) + 1);
          }
        });
      }
    });

    const queue: string[] = [];
    const result: string[] = [];

    inDegree.forEach((degree, nodeId) => {
      if (degree === 0) {
        queue.push(nodeId);
      }
    });

    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push(current);

      adjList.get(current)?.forEach(neighbor => {
        const newDegree = (inDegree.get(neighbor) || 0) - 1;
        inDegree.set(neighbor, newDegree);
        
        if (newDegree === 0) {
          queue.push(neighbor);
        }
      });
    }

    if (result.length !== layers.length) {
      console.error('Topological sort failed - circular dependencies detected');
      return layers.map(l => l.id);
    }

    return result;
  };

  const runAllSteps = useCallback(async (layers: AgentLayer[]): Promise<AgentRunOutcome> => {
    const outcome: AgentRunOutcome = { successful: [], failed: [], cancelled: false };
    const runSequence = ++runSequenceRef.current;
    cancelledRef.current = false;
    setProgress({
      current: 0,
      total: layers.length,
      currentStepName: '',
      currentStepId: '',
      completedSteps: [],
      failedSteps: [],
      isRunning: true,
      isCancelled: false,
    });

    try {
      const validationErrors = validateSteps(layers);
      if (validationErrors.length > 0) {
        callbacks.onError(`Validation failed:\n${validationErrors.join('\n')}`);
        setProgress(prev => ({ ...prev, isRunning: false }));
        outcome.failed = validationErrors.map(error => ({ id: 'validation', error }));
        return outcome;
      }

      const circularErrors = detectCircularDependencies(layers);
      if (circularErrors.length > 0) {
        callbacks.onError(`Dependency errors:\n${circularErrors.join('\n')}`);
        setProgress(prev => ({ ...prev, isRunning: false }));
        outcome.failed = circularErrors.map(error => ({ id: 'dependencies', error }));
        return outcome;
      }

      const executionOrder = calculateExecutionOrder(layers);
      const layerMap = new Map(layers.map(l => [l.id, l]));

      const stepResults = new Map<string, string>();

      for (let i = 0; i < executionOrder.length; i++) {
        const stepId = executionOrder[i];
        const layer = layerMap.get(stepId);
        
        if (!layer) continue;

        if (cancelledRef.current || runSequence !== runSequenceRef.current) {
          break;
        }

        const currentProgress: RunAllProgress = {
          current: i + 1,
          total: layers.length,
          currentStepName: layer.name,
          currentStepId: stepId,
          completedSteps: [...outcome.successful],
          failedSteps: [...outcome.failed],
          isRunning: true,
          isCancelled: false,
        };
        
        setProgress(currentProgress);
        callbacks.onProgress(currentProgress);

        try {
          const stepResult = await callbacks.runStep(stepId, stepResults);
          if (cancelledRef.current || runSequence !== runSequenceRef.current) return { ...outcome, cancelled: true };
          if (stepResult === undefined) throw new Error('Step did not complete.');
          
          if (stepResult) {
            stepResults.set(stepId, stepResult);
          }
          
          outcome.successful.push(stepId);
          setProgress(prev => ({
            ...prev,
            completedSteps: [...outcome.successful]
          }));

        } catch (error) {
          if (cancelledRef.current || runSequence !== runSequenceRef.current) return { ...outcome, cancelled: true };
          if (error instanceof Error && error.name === 'AbortError') {
            cancelledRef.current = true;
            setProgress(previous => ({ ...previous, isRunning: false, isCancelled: true }));
            return { ...outcome, cancelled: true };
          }
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          console.error(`Step ${layer.name} failed:`, error);
          outcome.failed.push({ id: stepId, error: errorMessage });
          
          setProgress(prev => ({
            ...prev,
            failedSteps: [...outcome.failed]
          }));

        }
      }

      if (cancelledRef.current || runSequence !== runSequenceRef.current) return { ...outcome, cancelled: true };
      const finalProgress = {
        current: layers.length,
        total: layers.length,
        currentStepName: '',
        currentStepId: '',
        completedSteps: [...outcome.successful],
        failedSteps: [...outcome.failed],
        isRunning: false,
        isCancelled: false,
      };
      
      setProgress(finalProgress);
      
      callbacks.onComplete({
        successful: finalProgress.completedSteps,
        failed: finalProgress.failedSteps,
      });
      return outcome;

    } catch (error) {
      if (cancelledRef.current || runSequence !== runSequenceRef.current) return { ...outcome, cancelled: true };
      const errorMessage = error instanceof Error ? error.message : 'Execution failed';
      callbacks.onError(errorMessage);
      setProgress(prev => ({ ...prev, isRunning: false }));
      outcome.failed.push({ id: 'run', error: errorMessage });
      return outcome;
    }
  }, [callbacks]);

  const cancelExecution = useCallback(() => {
    cancelledRef.current = true;
    runSequenceRef.current += 1;
    setProgress(prev => ({
      ...prev,
      isCancelled: true,
      isRunning: false,
    }));
  }, []);

  return {
    progress,
    runAllSteps,
    cancelExecution,
    isRunning: progress.isRunning,
  };
}; 