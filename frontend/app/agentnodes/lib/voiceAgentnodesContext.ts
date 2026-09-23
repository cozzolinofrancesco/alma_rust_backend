
import type { Edge, Node } from 'reactflow';
import type { Canvas272Agent, Canvas272Layer } from '../../canvas-272/lib/types';
import { getLayerOutputText } from '../../canvas-272/lib/layerOutput';
import type { AgentNodeData } from './types';

export type VoiceAgentnodesLayerSummary = {
  id: string;
  name: string;
  order?: number;
  tag?: string;
  selectedModel?: string;
  userInstructionPreview: string;
  systemInstructionPreview: string;
  outputPreview: string;
};

export interface VoiceAgentnodesSnapshot {
  surface: 'agentnodes';
  urlAgentId: string | null;
  projectId: string | null;
  agent: {
    id: string;
    name: string;
    currentVersion?: string;
    metadata?: {
      description?: string;
      displayTitle?: string;
      created?: string;
      modified?: string;
    };
    layers: VoiceAgentnodesLayerSummary[];
  } | null;
  graph: {
    nodeCount: number;
    edgeCount: number;
    nodes: Array<{
      id: string;
      kind: string;
      layerId: string;
      title: string;
      indexLabel: string;
      tag?: string;
    }>;
    edges: Array<{ id: string; source: string; target: string }>;
  };
  execution: {
    graphRun: {
      isRunning: boolean;
      progress: { current: number; total: number; currentStepName: string };
      runningLayerIds: string[];
      completedLayerIds: string[];
      failedLayerIds: string[];
    };
    simulate: {
      isSimulating: boolean;
      isPaused: boolean;
      progress: { current: number; total: number; currentStepName: string };
      runningLayerIds: string[];
      completedLayerIds: string[];
    };
    isDemoSimulating: boolean;
  };
}

let snapshot: VoiceAgentnodesSnapshot | null = null;

function trunc(s: string | undefined, max: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

export function buildVoiceAgentnodesSnapshot(args: {
  urlAgentId: string | null;
  projectId: string | null;
  loadedAgent: Canvas272Agent | null;
  nodes: Node<AgentNodeData>[];
  edges: Edge[];
  isGraphRunning: boolean;
  runProgress: { current: number; total: number; currentStepName: string };
  runnerRunningIds: ReadonlySet<string>;
  runnerCompletedIds: ReadonlySet<string>;
  failedLayerIds: ReadonlySet<string>;
  isSimulating: boolean;
  simPaused: boolean;
  simProgress: { current: number; total: number; currentStepName: string };
  simRunningIds: ReadonlySet<string>;
  simCompletedIds: ReadonlySet<string>;
  isDemoSimulating: boolean;
}): VoiceAgentnodesSnapshot {
  const agent = args.loadedAgent;
  const layerSummaries: VoiceAgentnodesLayerSummary[] =
    agent?.layers?.map((l: Canvas272Layer) => {
      const sys = (l as { systemInstruction?: string }).systemInstruction;
      return {
        id: l.id,
        name: l.name,
        order: typeof l.order === 'number' ? l.order : undefined,
        tag: typeof l.tag === 'string' ? l.tag : undefined,
        selectedModel: typeof l.selectedModel === 'string' ? l.selectedModel : undefined,
        userInstructionPreview: trunc(l.userInstruction, 200),
        systemInstructionPreview: trunc(typeof sys === 'string' ? sys : '', 200),
        outputPreview: trunc(getLayerOutputText(l), 150),
      };
    }) ?? [];

  const nodesOut = args.nodes.slice(0, 48).map((n) => ({
    id: n.id,
    kind: String(n.data?.kind ?? 'unknown'),
    layerId: n.data?.layerId ?? '',
    title: trunc(n.data?.title, 120),
    indexLabel: n.data?.indexLabel ?? '',
    tag: typeof n.data?.tag === 'string' ? n.data.tag : undefined,
  }));

  const edgesOut = args.edges.slice(0, 72).map((e) => ({
    id: String(e.id ?? `${e.source}->${e.target}`),
    source: e.source,
    target: e.target,
  }));

  return {
    surface: 'agentnodes',
    urlAgentId: args.urlAgentId,
    projectId: args.projectId,
    agent: agent
      ? {
          id: agent.id,
          name: agent.name,
          currentVersion: agent.currentVersion,
          metadata: agent.metadata
            ? {
                description: trunc(agent.metadata.description, 200),
                displayTitle: agent.metadata.displayTitle,
                created: agent.metadata.created,
                modified: agent.metadata.modified,
              }
            : undefined,
          layers: layerSummaries,
        }
      : null,
    graph: {
      nodeCount: args.nodes.length,
      edgeCount: args.edges.length,
      nodes: nodesOut,
      edges: edgesOut,
    },
    execution: {
      graphRun: {
        isRunning: args.isGraphRunning,
        progress: args.runProgress,
        runningLayerIds: [...args.runnerRunningIds],
        completedLayerIds: [...args.runnerCompletedIds].slice(-30),
        failedLayerIds: [...args.failedLayerIds],
      },
      simulate: {
        isSimulating: args.isSimulating,
        isPaused: args.simPaused,
        progress: args.simProgress,
        runningLayerIds: [...args.simRunningIds],
        completedLayerIds: [...args.simCompletedIds].slice(-30),
      },
      isDemoSimulating: args.isDemoSimulating,
    },
  };
}

export function setVoiceAgentnodesContext(next: VoiceAgentnodesSnapshot | null): void {
  snapshot = next;
}

export function clearVoiceAgentnodesContext(): void {
  snapshot = null;
}

export function getVoiceAgentnodesApiDefaults(): { projectId: string | null; agentId: string | null } {
  if (!snapshot) return { projectId: null, agentId: null };
  const agentId = snapshot.urlAgentId ?? snapshot.agent?.id ?? null;
  const projectId =
    typeof snapshot.projectId === 'string' && snapshot.projectId.trim().length > 0
      ? snapshot.projectId.trim()
      : null;
  return {
    projectId,
    agentId: typeof agentId === 'string' && agentId.trim().length > 0 ? agentId.trim() : null,
  };
}

export function getVoiceAgentnodesContextString(maxLen = 3500): string {
  if (!snapshot) return '';
  try {
    const s = JSON.stringify(snapshot);
    if (s.length <= maxLen) return s;
    return `${s.slice(0, maxLen)}…`;
  } catch {
    return '';
  }
}
