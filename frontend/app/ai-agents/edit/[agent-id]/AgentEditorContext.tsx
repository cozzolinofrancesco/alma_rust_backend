'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useProjectState } from '../../../components/ProjectStateContext';
import type { SelectedRag } from '../../../components/ListExtracts';
import type { BibliographyItem } from '../../../lib/types';
import type { Canvas272Agent } from '../../../canvas-272/lib/types';
import type { AnswerDebugInfo } from '../../../lib/answerDebug';
import { createDefaultLayer as makeDefaultLayer } from '../../../lib/agentLayer';
import { persistAgentSkillIds } from '../../../lib/agentSkillsPersistence';
import { persistAgentInputs } from '../../../lib/agentFilesApi';
import type { AgentCorpusRef, AgentInputMetadata } from '../../../lib/agentFiles';
import { appendAgentActivity, type ActivityEntry } from '../../../lib/agentActivityLog';
import { applyAgentLayerPatch, type AgentOutputVersion } from '../../../lib/agentOutputHistory';
import type { StepRunDiagnostics } from '../../../lib/stepExecution';
import type { AgentRunVersioning } from '../../hooks/useAgentRunVersioning';

export interface Layer {
  id: string;
  name: string;
  type: 'system' | 'user' | 'assistant' | 'function' | 'tool';
  isActive: boolean;
  order: number;

  pod: string;
  systemInstruction: string;
  userInstruction: string;
  assistantResponse: string;
  functionCall: string;
  toolCall: string;

  selectedModel: string;
  referencedSteps: string[];
  collection?: number;
  ragKnowledge?: SelectedRag[];
  userInput: string;
  result: string;
  imageUrls: string[];
  outputHistory?: AgentOutputVersion[];
  urlContent: string[];
  condition: string;
  isFrozen: boolean;
  keepMaster: boolean;
  outputType: 'basic' | 'code';
  image?: string | null;
  inputUrl: string;
  inputUrlType: 'webpage' | 'gdrive' | 'gdoc' | 'gsheet' | 'database' | '';

  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stopSequences?: string[];

  description?: string;
  tag?: string;
  tags?: string[];
  created?: string;
  modified?: string;
  author?: string;

  isExpanded?: boolean;
  isVisible?: boolean;

  isValid?: boolean;
  validationErrors?: string[];

  executionTime?: number;
  tokenCount?: number;
  cost?: number;

  dependencies?: string[];
  dependents?: string[];

  version?: string;
  changelog?: string;

  conditions?: {
    field: string;
    operator: 'equals' | 'contains' | 'startsWith' | 'endsWith' | 'regex';
    value: string;
  }[];

  inputTransform?: string;
  outputTransform?: string;

  cacheKey?: string;
  cacheTTL?: number;

  metrics?: {
    successRate: number;
    averageLatency: number;
    errorRate: number;
  };

  selectedPersona?: string;
  selectedPersonaIcon?: string;

  bibliography?: BibliographyItem[];

  corpusId?: string;
  corpusDisplayName?: string;
  corpusOwnerEmail?: string;
  documentSelections?: string[];

  debugInfo?: AnswerDebugInfo;
  lastRunDiagnostics?: StepRunDiagnostics;

  [key: string]: unknown;
}

export interface AgentData {
  version?: string;
  name: string;
  layers: Layer[];
  metadata?: {
    created: string;
    modified: string;
    description?: string;
    notes?: { username: string; text: string; timestamp: string }[];
    skillIds?: string[];
    fileIds?: string[];
    corpusRefs?: AgentCorpusRef[];
  };
}

export interface AgentEditorContextValue {
  agent: AgentData | null;
  setAgent: React.Dispatch<React.SetStateAction<AgentData | null>>;
  agentRef: React.MutableRefObject<AgentData | null>;
  runVersioningRef: React.MutableRefObject<AgentRunVersioning | null>;
  layers: Layer[];
  updateName: (name: string) => void;
  updateLayer: (layerId: string, patch: Partial<Layer>) => void;
  addLayer: (layerId: string, title: string, opts?: { silent?: boolean }) => void;
  removeLayer: (layerId: string) => void;
  updateSkillIds: (skillIds: string[]) => void;
  updateInputs: (metadata: AgentInputMetadata) => Promise<void>;
  // Activity-log hooks for surfaces (e.g. the Form pane) that mutate agent state
  // directly via setAgent instead of through the mutators above. Both funnel into
  // the same recording/persistence pipeline as the graph mutators.
  logActivity: (
    action: ActivityEntry['action'],
    target: string,
    opts?: { targetId?: string; detail?: string },
  ) => void;
  logStepEdit: (layerId: string, label: string) => void;
  agentId: string;
  projectId: string | null;
  graphAgent: Canvas272Agent | null;
}

const AgentEditorContext = createContext<AgentEditorContextValue | null>(null);

export function useAgentEditor(): AgentEditorContextValue {
  const ctx = useContext(AgentEditorContext);
  if (!ctx) {
    throw new Error('useAgentEditor must be used within an AgentEditorProvider');
  }
  return ctx;
}

export function useOptionalAgentEditor(): AgentEditorContextValue | null {
  return useContext(AgentEditorContext);
}

export function AgentEditorProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { projectFolder } = useProjectState();
  const agentId = decodeURIComponent((pathname ?? '').split('/').filter(Boolean).pop() || '');
  const projectId = projectFolder?.projectId ?? null;
  const inputScopeRef = useRef('');
  inputScopeRef.current = `${projectId}:${agentId}`;

  const [agent, setAgentState] = useState<AgentData | null>(null);

  const agentRef = useRef<AgentData | null>(null);
  const setAgent = useCallback((update: React.SetStateAction<AgentData | null>) => {
    const next = typeof update === 'function' ? update(agentRef.current) : update;
    agentRef.current = next;
    setAgentState(next);
  }, []);
  const runVersioningRef = useRef<AgentRunVersioning | null>(null);

  const { data: session } = useSession();
  const currentUserEmail = session?.user?.email ?? '';

  // Append-only activity log, persisted to a dedicated sidecar file (debounced,
  // batched). Server-side concat means concurrent editors never clobber each
  // other; the Log view reads the sidecar directly.
  const pendingRef = useRef<ActivityEntry[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const flushActivity = useCallback(() => {
    const entries = pendingRef.current;
    pendingRef.current = [];
    flushTimerRef.current = null;
    if (!projectId || !agentId || entries.length === 0) return;
    appendAgentActivity(projectId, agentId, entries).catch(err => {
      console.error('Failed to persist activity log:', err);
    });
  }, [projectId, agentId]);

  const recordActivity = useCallback(
    (
      action: ActivityEntry['action'],
      target: string,
      opts?: { targetId?: string; detail?: string },
    ) => {
      const entry: ActivityEntry = {
        username: currentUserEmail || 'unknown',
        action,
        target,
        targetId: opts?.targetId,
        detail: opts?.detail,
        timestamp: new Date().toISOString(),
      };
      pendingRef.current.push(entry);
      // Short debounce: batches the burst of mutator calls from a single action
      // but persists promptly so the log survives a quick reload / tab switch.
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      flushTimerRef.current = setTimeout(flushActivity, 300);
    },
    [currentUserEmail, flushActivity],
  );

  // Coalesce a burst of content edits on one step into a single "edited" entry.
  const recordEditDebounced = useCallback(
    (layerId: string, label: string) => {
      const timers = editTimersRef.current;
      if (timers[layerId]) clearTimeout(timers[layerId]);
      timers[layerId] = setTimeout(() => {
        delete timers[layerId];
        recordActivity('edit_step', label, { targetId: layerId });
      }, 2000);
    },
    [recordActivity],
  );

  // Flush immediately when the page is being hidden/unloaded (reload, tab close,
  // navigation) so a pending entry isn't lost. keepalive on the POST carries it
  // through unload. visibilitychange/pagehide are more reliable than unmount.
  useEffect(() => {
    const flushNow = () => {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      flushActivity();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushNow();
    };
    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', onVisibility);
    const editTimers = editTimersRef.current;
    return () => {
      window.removeEventListener('pagehide', flushNow);
      document.removeEventListener('visibilitychange', onVisibility);
      Object.values(editTimers).forEach(clearTimeout);
      flushNow();
    };
  }, [flushActivity]);

  const updateName = useCallback((name: string) => {
    setAgent(prev => {
      if (!prev) return prev;
      const next = { ...prev, name };
      agentRef.current = next;
      return next;
    });
  }, []);

  const updateLayer = useCallback((layerId: string, patch: Partial<Layer>) => {
    const existing = agentRef.current?.layers.find(l => l.id === layerId);
    const timestamp = new Date().toISOString();
    setAgent(prev => {
      if (!prev) return prev;
      const next = {
        ...prev,
        layers: prev.layers.map(layer => layer.id === layerId ? applyAgentLayerPatch(layer, patch, timestamp) : layer),
      };
      agentRef.current = next;
      return next;
    });
    if (typeof patch.result === 'string' || Array.isArray(patch.imageUrls)) return;
    const label = patch.name ?? existing?.name ?? layerId;
    if ('corpusId' in patch || 'corpusDisplayName' in patch) {
      const detail = patch.corpusDisplayName ?? patch.corpusId ?? '';
      recordActivity(patch.corpusId ? 'link_corpus' : 'unlink_corpus', label, {
        targetId: layerId,
        detail,
      });
    } else {
      recordEditDebounced(layerId, label);
    }
  }, [recordActivity, recordEditDebounced]);

  const addLayer = useCallback((layerId: string, title: string, opts?: { silent?: boolean }) => {
    setAgent(prev => {
      if (!prev) return prev;
      const next = {
        ...prev,
        layers: prev.layers.concat(makeDefaultLayer(layerId, title, prev.layers.length)),
      };
      agentRef.current = next;
      return next;
    });
    // silent = reconciliation (e.g. materializing an orphan graph node on load),
    // not a user action — don't fabricate a log entry.
    if (!opts?.silent) recordActivity('add_step', title || layerId, { targetId: layerId });
  }, [recordActivity]);

  const removeLayer = useCallback((layerId: string) => {
    const removed = agentRef.current?.layers.find(l => l.id === layerId);
    setAgent(prev => {
      if (!prev) return prev;
      const next = {
        ...prev,
        layers: prev.layers
          .filter(l => l.id !== layerId)
          .map(l => ({
            ...l,
            referencedSteps: (l.referencedSteps ?? []).filter(id => id !== layerId),
          })),
      };
      agentRef.current = next;
      return next;
    });
    recordActivity('remove_step', removed?.name || layerId, { targetId: layerId });
  }, [recordActivity]);

  const updateSkillIds = useCallback((skillIds: string[]) => {
    setAgent(prev => {
      if (!prev) return prev;
      const created = prev.metadata?.created ?? new Date().toISOString();
      const modified = new Date().toISOString();
      const next = { ...prev, metadata: { ...prev.metadata, created, modified, skillIds } };
      agentRef.current = next;
      return next;
    });
    if (projectId && agentId) {
      persistAgentSkillIds(projectId, agentId, skillIds).catch(err => {
        console.error('Failed to persist agent skills:', err);
      });
    }
  }, [projectId, agentId]);

  const updateInputs = useCallback(async (metadata: AgentInputMetadata) => {
    if (!projectId || !agentId) throw new Error('Select a saved agent and project first.');
    const scope = `${projectId}:${agentId}`;
    await persistAgentInputs(projectId, agentId, metadata);
    if (inputScopeRef.current !== scope) return;
    setAgent(prev => {
      if (!prev) return prev;
      const now = new Date().toISOString();
      const next = { ...prev, metadata: { ...prev.metadata, created: prev.metadata?.created ?? now, modified: now, ...metadata } };
      agentRef.current = next;
      return next;
    });
  }, [projectId, agentId]);

  const layers = agent?.layers ?? [];

  const graphAgent = useMemo<Canvas272Agent | null>(
    () => (agent ? ({ ...agent, id: agentId } as unknown as Canvas272Agent) : null),
    [agent, agentId],
  );

  const value = useMemo<AgentEditorContextValue>(
    () => ({ agent, setAgent, agentRef, runVersioningRef, layers, updateName, updateLayer, addLayer, removeLayer, updateSkillIds, updateInputs, logActivity: recordActivity, logStepEdit: recordEditDebounced, agentId, projectId, graphAgent }),
    [agent, layers, updateName, updateLayer, addLayer, removeLayer, updateSkillIds, updateInputs, recordActivity, recordEditDebounced, agentId, projectId, graphAgent],
  );

  return <AgentEditorContext.Provider value={value}>{children}</AgentEditorContext.Provider>;
}
