'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarkerType, type Edge, type Node, type XYPosition } from 'reactflow';
import type { Canvas272Agent } from '../../canvas-272/lib/types';
import { resolveLayerCorpusId } from '../lib/corpus';
import { extractActiveSortedLayers } from '../../canvas-272/lib/sections';
import { buildBlankAgentStarterNode, buildInitialGraph } from '../lib/initialGraph';
import { findFreePosition } from '../lib/nodeSpacing';
import { clearGraph, readGraph, writeGraph } from '../lib/persistence';
import { validatePersistedGraphForAgent } from '../lib/validatePersistedAgentGraph';
import { agentnodesGraphServerSyncEnabled } from '../../lib/agentnodesApi/agentnodesV1Flags';
import type {
  AgentEdgeSerialised,
  AgentNodeData,
  AgentNodeSerialised,
  AgentNodesGraphV1,
} from '../lib/types';

interface Params {
  projectId: string | null;
  agent: Canvas272Agent | null;
  defaultStepTitle: string;
  onAddLayer?: (layerId: string, title: string) => void;
  onRemoveLayer?: (layerId: string) => void;
}

function toReactFlowNode(n: AgentNodeSerialised): Node<AgentNodeData> {
  return {
    id: n.id,
    type: n.type,
    position: n.position,
    data: n.data,
  };
}

function toReactFlowEdge(e: AgentEdgeSerialised): Edge {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? undefined,
    targetHandle: e.targetHandle ?? undefined,
    type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed, color: '#1a2b5b' },
    style: { stroke: '#1a2b5b', strokeWidth: 2 },
  };
}

function toSerialisedNode(n: Node<AgentNodeData>): AgentNodeSerialised {
  const { onClick: _drop, ...data } = n.data;
  void _drop;
  return {
    id: n.id,
    type: (n.type as AgentNodeSerialised['type']) ?? 'c272Step',
    position: n.position,
    data,
  };
}

function toSerialisedEdge(e: Edge): AgentEdgeSerialised {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? null,
    targetHandle: e.targetHandle ?? null,
  };
}

function inferGraphFlowDirection(nodes: Node<AgentNodeData>[]): 'LR' | 'TB' {
  for (const n of nodes) {
    if (n.type !== 'c272Step' && n.type !== 'c272Section') continue;
    const d = n.data.direction;
    if (d === 'TB' || d === 'LR') return d;
  }
  return 'LR';
}

function alignDependencyEdgeHandles(edges: Edge[], direction: 'LR' | 'TB'): Edge[] {
  const sourceHandle = direction === 'TB' ? 'bottom' : 'right';
  const targetHandle = direction === 'TB' ? 'top' : 'left';
  return edges.map((e) =>
    e.sourceHandle === sourceHandle && e.targetHandle === targetHandle
      ? e
      : { ...e, sourceHandle, targetHandle },
  );
}

function nextRunningIndex(nodes: Node<AgentNodeData>[]): number {
  return (
    nodes.reduce((max, n) => {
      const m = /(\d+)/.exec(n.data.indexLabel);
      const v = m ? parseInt(m[1], 10) : 0;
      return Number.isFinite(v) && v > max ? v : max;
    }, 0) + 1
  );
}

export function useAgentGraph({
  projectId,
  agent,
  defaultStepTitle,
  onAddLayer,
  onRemoveLayer: _onRemoveLayer,
}: Params) {
  const [nodes, setNodes] = useState<Node<AgentNodeData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loadedFromStorage, setLoadedFromStorage] = useState<boolean>(false);
  const [graphHydrationWarning, setGraphHydrationWarning] = useState<boolean>(false);

  const persistTimerRef = useRef<number | null>(null);
  const skipNextPersistRef = useRef<boolean>(true);
  const currentKeyRef = useRef<string | null>(null);
  const serverGraphUpdatedAtRef = useRef<string | null>(null);

  const serverGraphSync = useMemo(() => agentnodesGraphServerSyncEnabled(), []);

  const edgesRef = useRef<Edge[]>(edges);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

  const agentId = agent?.id ?? null;
  useEffect(() => {
    if (!agentId || !projectId) {
      setNodes([]);
      setEdges([]);
      currentKeyRef.current = null;
      setGraphHydrationWarning(false);
      return;
    }
    setGraphHydrationWarning(false);
    currentKeyRef.current = `${projectId}:${agentId}`;
    skipNextPersistRef.current = true;

    const currentAgent = agent!;
    let cancelled = false;

    (async () => {
      let graphDoc: AgentNodesGraphV1 | null = readGraph(projectId, agentId);
      let hydratedFromStore = Boolean(graphDoc);

      if (serverGraphSync) {
        try {
          const res = await fetch(
            `/api/v1/projects/${encodeURIComponent(projectId)}/agentnodes/agents/${encodeURIComponent(agentId)}/graph`,
            { credentials: 'include', cache: 'no-store' }
          );
          if (!cancelled && res.ok) {
            const j = (await res.json()) as { graph?: AgentNodesGraphV1 };
            const remote = j.graph;
            if (
              remote?.version === 1 &&
              Array.isArray(remote.nodes) &&
              Array.isArray(remote.edges)
            ) {
              if (validatePersistedGraphForAgent(remote, currentAgent).ok) {
                graphDoc = remote;
                serverGraphUpdatedAtRef.current = remote.updatedAt;
                writeGraph(projectId, remote);
                hydratedFromStore = true;
              } else {
                serverGraphUpdatedAtRef.current = null;
              }
            }
          } else if (!cancelled && res.status === 404) {
            serverGraphUpdatedAtRef.current = null;
          }
        } catch {
        }
      }

      if (cancelled) return;

      let rejectedSavedGraph = false;
      if (graphDoc) {
        const check = validatePersistedGraphForAgent(graphDoc, currentAgent);
        if (!check.ok) {
          clearGraph(projectId, agentId);
          graphDoc = null;
          hydratedFromStore = false;
          rejectedSavedGraph = true;
        }
      }

      let source = graphDoc ?? buildInitialGraph(currentAgent);
      const activeLayers = extractActiveSortedLayers(currentAgent.layers);
      if (!graphDoc && source.nodes.length === 0 && activeLayers.length === 0) {
        source = {
          ...source,
          nodes: [buildBlankAgentStarterNode(defaultStepTitle)],
        };
      }

      const layerById = new Map(currentAgent.layers.map((l) => [l.id, l]));

      const enrichedNodes = source.nodes.map((n) => {
        const layer = layerById.get(n.data.layerId);
        if (!layer) return toReactFlowNode(n);
        const corpusId = resolveLayerCorpusId(layer) || undefined;
        return toReactFlowNode({
          ...n,
          data: {
            ...n.data,
            title: layer.name ?? n.data.title,
            tag: layer.tag ?? undefined,
            headerTitle: n.data.kind === 'section' ? layer.name ?? n.data.headerTitle : n.data.headerTitle,
            corpusId,
          },
        });
      });

      const seedEdgesRaw = source.edges.map(toReactFlowEdge);
      const flowDir = inferGraphFlowDirection(enrichedNodes);
      const seedEdges = alignDependencyEdgeHandles(seedEdgesRaw, flowDir);

      if (rejectedSavedGraph) {
        const repaired: AgentNodesGraphV1 = {
          version: 1,
          agentId,
          agentName: currentAgent.name,
          updatedAt: new Date().toISOString(),
          nodes: enrichedNodes.map(toSerialisedNode),
          edges: seedEdges.map(toSerialisedEdge),
        };
        if (!cancelled) {
          writeGraph(projectId, repaired);
          if (serverGraphSync) {
            const base = serverGraphUpdatedAtRef.current;
            void fetch(
              `/api/v1/projects/${encodeURIComponent(projectId)}/agentnodes/agents/${encodeURIComponent(agentId)}/graph`,
              {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ graph: repaired, baseUpdatedAt: base ?? undefined }),
              },
            )
              .then(async (res) => {
                if (res.ok) {
                  const j = (await res.json()) as { graph?: AgentNodesGraphV1 };
                  if (j.graph?.updatedAt) serverGraphUpdatedAtRef.current = j.graph.updatedAt;
                }
              })
              .catch(() => {});
          }
        }
      }

      if (!cancelled) {
        setNodes(enrichedNodes);
        setEdges(seedEdges);
        setLoadedFromStorage(hydratedFromStore);
        setGraphHydrationWarning(rejectedSavedGraph);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, agentId, defaultStepTitle]);

  const agentName = agent?.name ?? '';
  useEffect(() => {
    if (!agentId || !projectId) return undefined;
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return undefined;
    }
    if (persistTimerRef.current) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(() => {
      const payload: AgentNodesGraphV1 = {
        version: 1,
        agentId,
        agentName,
        updatedAt: new Date().toISOString(),
        nodes: nodes.map(toSerialisedNode),
        edges: edges.map(toSerialisedEdge),
      };
      writeGraph(projectId, payload);
      if (serverGraphSync) {
        const base = serverGraphUpdatedAtRef.current;
        void fetch(
          `/api/v1/projects/${encodeURIComponent(projectId)}/agentnodes/agents/${encodeURIComponent(agentId)}/graph`,
          {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ graph: payload, baseUpdatedAt: base ?? undefined }),
          }
        )
          .then(async (res) => {
            if (res.ok) {
              const j = (await res.json()) as { graph?: AgentNodesGraphV1 };
              if (j.graph?.updatedAt) serverGraphUpdatedAtRef.current = j.graph.updatedAt;
            }
          })
          .catch(() => {});
      }
    }, 250);
    return () => {
      if (persistTimerRef.current) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [nodes, edges, agentId, agentName, projectId]);

  const addStepNode = useCallback(
    (title: string, position: XYPosition) => {
      const safeTitle = title.trim() || 'New step';
      const id = `user-step-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
      if (onAddLayer) {
        onAddLayer(id, safeTitle);
      }
      setNodes((prev) => {
        const freePos = findFreePosition(position, prev, edgesRef.current);
        const idx = nextRunningIndex(prev);
        const data: AgentNodeData = {
          kind: 'step',
          layerId: id,
          title: safeTitle,
          indexLabel: `Step ${idx}`,
          hasOutput: false,
          isEdited: false,
        };
        return prev.concat({ id, type: 'c272Step', position: freePos, data });
      });
      return id;
    },
    [onAddLayer],
  );

  // Create a node for a layer that ALREADY exists (e.g. a step added from the
  // form view), without creating a new layer. Idempotent: no-op if a node for
  // that layerId is already present.
  const addNodeForLayer = useCallback(
    (layerId: string, title: string, position?: XYPosition) => {
      setNodes((prev) => {
        if (prev.some((n) => n.data.layerId === layerId)) return prev;
        const freePos = findFreePosition(position ?? { x: 80, y: 80 }, prev, edgesRef.current);
        const idx = nextRunningIndex(prev);
        const data: AgentNodeData = {
          kind: 'step',
          layerId,
          title: title.trim() || 'New step',
          indexLabel: `Step ${idx}`,
          hasOutput: false,
          isEdited: false,
        };
        return prev.concat({ id: layerId, type: 'c272Step', position: freePos, data });
      });
    },
    [],
  );

  const renameNode = useCallback((id: string, title: string) => {
    const safe = title.trim();
    if (!safe) return;
    setNodes((prev) =>
      prev.map((n) =>
        n.id === id
          ? {
              ...n,
              data: {
                ...n.data,
                title: safe,
                headerTitle: n.data.kind === 'section' ? safe : n.data.headerTitle,
              },
            }
          : n,
      ),
    );
  }, []);

  const updateNotes = useCallback((id: string, notes: string) => {
    setNodes((prev) =>
      prev.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, notes, isEdited: notes.trim().length > 0 } }
          : n,
      ),
    );
  }, []);

  const patchNodeDataByLayerId = useCallback(
    (layerId: string, patch: Partial<AgentNodeData>) => {
      setNodes((prev) =>
        prev.map((n) =>
          n.data.layerId === layerId
            ? { ...n, data: { ...n.data, ...patch } }
            : n,
        ),
      );
    },
    [],
  );

  const agentRef = useRef(agent);
  agentRef.current = agent;

  const resetToInitial = useCallback((): boolean => {
    const cur = agentRef.current;
    if (!cur || !projectId) return false;
    const seeded = buildInitialGraph(cur);
    const activeCount = extractActiveSortedLayers(cur.layers).length;
    if (activeCount > 0 && seeded.nodes.length === 0) {
      console.warn('[useAgentGraph] resetToInitial: buildInitialGraph returned no nodes; keeping current graph.');
      return false;
    }
    clearGraph(projectId, cur.id);
    skipNextPersistRef.current = true;
    const rfNodes = seeded.nodes.map(toReactFlowNode);
    setNodes(rfNodes);
    setEdges(
      alignDependencyEdgeHandles(
        seeded.edges.map(toReactFlowEdge),
        inferGraphFlowDirection(rfNodes),
      ),
    );
    setLoadedFromStorage(false);
    setGraphHydrationWarning(false);
    if (serverGraphSync) {
      void fetch(
        `/api/v1/projects/${encodeURIComponent(projectId)}/agentnodes/agents/${encodeURIComponent(cur.id)}/graph/reset`,
        { method: 'POST', credentials: 'include' }
      )
        .then(async (r) => {
          if (r.ok) {
            const j = (await r.json()) as { graph?: AgentNodesGraphV1 };
            if (j.graph?.updatedAt) serverGraphUpdatedAtRef.current = j.graph.updatedAt;
          }
        })
        .catch(() => {});
    }
    return true;
  }, [projectId]);

  const nodeIds = useMemo(() => nodes.map((n) => n.id), [nodes]);

  return {
    nodes,
    edges,
    setNodes,
    setEdges,
    nodeIds,
    loadedFromStorage,
    graphHydrationWarning,
    addStepNode,
    addNodeForLayer,
    renameNode,
    updateNotes,
    patchNodeDataByLayerId,
    resetToInitial,
  };
}
