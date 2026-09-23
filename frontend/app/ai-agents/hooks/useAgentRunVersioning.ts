'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentData, AgentVersionSaveResult, VersionedAgentData } from '../../lib/versionUtils';

export interface AgentRunOutcome {
  successful: string[];
  failed: { id: string; error: string }[];
  cancelled: boolean;
}

export interface AgentVersionRun {
  scope: string;
  snapshot: AgentData;
  stepIds: string[];
  shouldBranch: boolean;
}

export interface AgentRunVersioning {
  scope: string;
  beginRun: (stepIds: string[]) => AgentVersionRun | null;
  isRunCurrent: (run: AgentVersionRun | null) => boolean;
  completeRun: (run: AgentVersionRun | null, outcome: AgentRunOutcome) => Promise<void>;
  invalidate: () => void;
  isSaving: boolean;
}

interface Options {
  scope: string;
  selectedVersion: string;
  latestVersion?: string;
  getDraft: () => AgentData | null;
  getBaseline: () => AgentData | null;
  hasInputEdits?: () => boolean;
  saveVersion: (snapshot: AgentData, shouldSave: () => boolean) => Promise<AgentVersionSaveResult>;
  onVersionSaved: (saved: VersionedAgentData, snapshot: AgentData) => void;
  onError: (error: Error) => void;
}

const outputFields = [
  'result', 'output', 'imageUrls', 'outputHistory', 'debugInfo', 'lastRunDiagnostics',
  'executionTime', 'tokenCount', 'cost',
];
const transientLayerFields = new Set([
  ...outputFields, 'created', 'modified', 'isExpanded', 'isVisible', 'isValid',
  'validationErrors', 'metrics', 'urlContent', 'corpusDisplayName', 'corpusOwnerEmail',
]);

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, entry]) => [key, canonicalValue(entry)]));
  }
  return value;
}

export function getAgentEditableSignature(agent: AgentData): string {
  return JSON.stringify(canonicalValue({
    name: agent.name,
    layers: agent.layers.map(layer => ({
      ...Object.fromEntries(Object.entries(layer).filter(([key]) => !transientLayerFields.has(key))),
      corpusId: layer.corpusId ?? '',
      documentSelections: layer.documentSelections ?? [],
    })),
    metadata: {
      description: agent.metadata?.description ?? '',
      notes: agent.metadata?.notes ?? [],
      skillIds: agent.metadata?.skillIds ?? [],
      skillRefs: agent.metadata?.skillRefs ?? [],
      fileIds: agent.metadata?.fileIds ?? [],
      corpusRefs: agent.metadata?.corpusRefs ?? [],
    },
  }));
}

export function useAgentRunVersioning(options: Options): AgentRunVersioning {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const activeRef = useRef<{ run: AgentVersionRun; finishing: boolean } | null>(null);
  const scopeRef = useRef(options.scope);
  if (scopeRef.current !== options.scope) {
    scopeRef.current = options.scope;
    activeRef.current = null;
  }
  const mountedRef = useRef(true);
  const savingRef = useRef(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRef.current = null;
    };
  }, []);

  const invalidate = useCallback(() => { activeRef.current = null; }, []);
  const isRunCurrent = useCallback((run: AgentVersionRun | null) => Boolean(
    run && mountedRef.current && activeRef.current?.run === run && run.scope === optionsRef.current.scope
  ), []);

  const beginRun = useCallback((stepIds: string[]): AgentVersionRun | null => {
    if (savingRef.current || activeRef.current || stepIds.length === 0) return null;
    const current = optionsRef.current;
    const draft = current.getDraft();
    if (!draft) return null;
    const baseline = current.getBaseline();
    const historical = Boolean(current.latestVersion && current.selectedVersion
      && current.selectedVersion !== current.latestVersion);
    const run = {
      scope: current.scope,
      snapshot: JSON.parse(JSON.stringify(draft)) as AgentData,
      stepIds: [...stepIds],
      shouldBranch: historical && Boolean(baseline && (
        getAgentEditableSignature(baseline) !== getAgentEditableSignature(draft) || current.hasInputEdits?.()
      )),
    };
    activeRef.current = { run, finishing: false };
    return run;
  }, []);

  const completeRun = useCallback(async (run: AgentVersionRun | null, outcome: AgentRunOutcome) => {
    if (!run || !isRunCurrent(run) || !activeRef.current || activeRef.current.finishing) return;
    activeRef.current.finishing = true;
    const succeeded = !outcome.cancelled && outcome.failed.length === 0
      && run.stepIds.every(stepId => outcome.successful.includes(stepId));
    if (!succeeded || !run.shouldBranch) {
      activeRef.current = null;
      return;
    }

    const current = optionsRef.current;
    const completed = current.getDraft();
    if (!completed) {
      activeRef.current = null;
      return;
    }
    const completedLayers = new Map(completed.layers.map(layer => [layer.id, layer]));
    const snapshot: AgentData = {
      ...run.snapshot,
      layers: run.snapshot.layers.map(layer => {
        const output = completedLayers.get(layer.id);
        if (!output || !outcome.successful.includes(layer.id)) return layer;
        return { ...layer, ...Object.fromEntries(outputFields.map(key => [key, output[key]])) };
      }),
    };

    savingRef.current = true;
    setIsSaving(true);
    try {
      const result = await current.saveVersion(snapshot, () => isRunCurrent(run));
      if (!isRunCurrent(run) || result.skipped) return;
      if (!result.success || !result.versionedAgent) throw new Error(result.error || 'Could not save the new version.');
      current.onVersionSaved(result.versionedAgent, snapshot);
    } catch (error) {
      if (isRunCurrent(run)) current.onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (activeRef.current?.run === run) activeRef.current = null;
      savingRef.current = false;
      if (mountedRef.current) setIsSaving(false);
    }
  }, [isRunCurrent]);

  return { scope: options.scope, beginRun, isRunCurrent, completeRun, invalidate, isSaving };
}