'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import ReactFlow, {
  addEdge,
  Background,
  Controls,
  MarkerType,
  updateEdge,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeDragHandler,
  type NodeTypes,
  type OnConnect,
  type XYPosition,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from 'reactflow';
import 'reactflow/dist/style.css';
import type { Canvas272Agent } from '../lib/types';
import { useLanguage } from '../../contexts/LanguageContext';
import { useDiagramModel } from '../hooks/useDiagramModel';
import StepNode from './StepNode';
import SectionHeaderNode from './SectionHeaderNode';

interface AgentDiagramProps {
  agent: Canvas272Agent;
  sidecarOutputs: Record<string, string>;
  onNodeClick: (layerId: string) => void;
  onOpenDebug: (layerId: string) => void;
}

function AgentDiagramInner({ agent, sidecarOutputs, onNodeClick, onOpenDebug }: AgentDiagramProps) {
  const { t } = useLanguage();
  const { nodes: modelNodes, edges: modelEdges, stepCount, sectionChildrenByHeaderId, direction } = useDiagramModel({
    agent,
    sidecarOutputs,
    onNodeClick,
    onOpenDebug,
  });

  const nodeTypes = useMemo<NodeTypes>(
    () => ({ c272Step: StepNode, c272Section: SectionHeaderNode }),
    [],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node['data']>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const nodesRef = useRef<Node[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

  const positionCacheRef = useRef<{
    agentId: string | null;
    direction: string | null;
    byId: Map<string, XYPosition>;
  }>({ agentId: null, direction: null, byId: new Map() });

  const edgesDirtyRef = useRef<boolean>(false);
  const lastSyncedAgentIdRef = useRef<string | null>(null);

  const markDirty = useCallback(() => {
    edgesDirtyRef.current = true;
  }, []);

  useEffect(() => {
    const cache = positionCacheRef.current;
    if (cache.agentId !== agent.id || cache.direction !== direction) {
      cache.agentId = agent.id;
      cache.direction = direction;
      cache.byId = new Map();
    }
    const merged = modelNodes.map((n) => {
      const override = cache.byId.get(n.id);
      return override ? { ...n, position: override } : n;
    });
    setNodes(merged);
  }, [agent.id, direction, modelNodes, setNodes]);

  useEffect(() => {
    if (lastSyncedAgentIdRef.current !== agent.id) {
      lastSyncedAgentIdRef.current = agent.id;
      edgesDirtyRef.current = false;
      setEdges(modelEdges);
      return;
    }
    if (!edgesDirtyRef.current) {
      setEdges(modelEdges);
    }
  }, [agent.id, modelEdges, setEdges]);

  const computeBottomDescendants = useCallback((rootId: string): Set<string> => {
    const children = sectionChildrenByHeaderId[rootId];
    return children ? new Set(children) : new Set<string>();
  }, [sectionChildrenByHeaderId]);

  type DragCtx = {
    id: string;
    base: XYPosition;
    descendants: Map<string, XYPosition>;
  };
  const dragCtxRef = useRef<DragCtx | null>(null);

  const onNodeDragStart = useCallback<NodeDragHandler>((_e, node) => {
    const descIds = computeBottomDescendants(node.id);
    const snapshot = new Map<string, XYPosition>();
    for (const n of nodesRef.current) {
      if (descIds.has(n.id)) snapshot.set(n.id, { ...n.position });
    }
    dragCtxRef.current = {
      id: node.id,
      base: { ...node.position },
      descendants: snapshot,
    };
  }, [computeBottomDescendants]);

  const onNodeDrag = useCallback<NodeDragHandler>((_e, node) => {
    const ctx = dragCtxRef.current;
    if (!ctx || ctx.id !== node.id || ctx.descendants.size === 0) return;
    const dx = node.position.x - ctx.base.x;
    const dy = node.position.y - ctx.base.y;
    setNodes((curr) => curr.map((n) => {
      const start = ctx.descendants.get(n.id);
      if (!start) return n;
      return { ...n, position: { x: start.x + dx, y: start.y + dy } };
    }));
  }, [setNodes]);

  const onNodeDragStop = useCallback<NodeDragHandler>((_e, node) => {
    const ctx = dragCtxRef.current;
    const cache = positionCacheRef.current.byId;
    cache.set(node.id, { ...node.position });
    if (ctx && ctx.id === node.id) {
      const dx = node.position.x - ctx.base.x;
      const dy = node.position.y - ctx.base.y;
      ctx.descendants.forEach((start, id) => {
        cache.set(id, { x: start.x + dx, y: start.y + dy });
      });
    }
    dragCtxRef.current = null;
  }, []);

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes);
      for (const change of changes) {
        if (change.type === 'position' && change.dragging === false && change.position) {
          positionCacheRef.current.byId.set(change.id, change.position);
        }
      }
    },
    [onNodesChange],
  );

  const styleForConnection = (_params: Connection | Edge) => ({
    type: 'smoothstep' as const,
    markerEnd: { type: MarkerType.ArrowClosed, color: '#1a2b5b' },
    style: { stroke: '#1a2b5b', strokeWidth: 2 },
  });

  const onConnect = useCallback<OnConnect>((params) => {
    if (!params.source || !params.target || params.source === params.target) return;
    const newEdge: Edge = {
      ...(params as Connection),
      id: `user-${params.source}-${params.target}-${Date.now()}`,
      source: params.source,
      sourceHandle: params.sourceHandle ?? (direction === 'TB' ? 'bottom' : 'right'),
      target: params.target,
      targetHandle: params.targetHandle ?? (direction === 'TB' ? 'top' : 'left'),
      ...styleForConnection(params),
    };
    setEdges((es) => addEdge(newEdge, es));
    markDirty();
  }, [direction, setEdges, markDirty]);

  const edgeReconnectValidRef = useRef<boolean>(true);

  const onEdgeUpdateStart = useCallback(() => {
    edgeReconnectValidRef.current = false;
  }, []);

  const onEdgeUpdate = useCallback(
    (oldEdge: Edge, newConnection: Connection) => {
      edgeReconnectValidRef.current = true;
      setEdges((es) => {
        const reconnected = updateEdge(oldEdge, newConnection, es);
        return reconnected.map((e) =>
          e.id === oldEdge.id ? { ...e, ...styleForConnection(newConnection) } : e,
        );
      });
      markDirty();
    },
    [setEdges, markDirty],
  );

  const onEdgeUpdateEnd = useCallback(
    (_e: MouseEvent | TouchEvent, edge: Edge) => {
      if (!edgeReconnectValidRef.current) {
        setEdges((es) => es.filter((ed) => ed.id !== edge.id));
        markDirty();
      }
      edgeReconnectValidRef.current = true;
    },
    [setEdges, markDirty],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      onEdgesChange(changes);
      for (const change of changes) {
        if (change.type === 'remove') {
          markDirty();
          break;
        }
      }
    },
    [onEdgesChange, markDirty],
  );

  const rf = useReactFlow();
  useEffect(() => {
    const id = requestAnimationFrame(() => rf.fitView({ padding: 0.22, duration: 300 }));
    return () => cancelAnimationFrame(id);
  }, [agent.id, stepCount, rf]);

  if (modelNodes.length === 0) {
    return (
      <div className="c272-empty">
        {t('canvas272Page.noActiveSteps')}
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={nodes as Node[]}
      edges={edges as Edge[]}
      nodeTypes={nodeTypes}
      onNodesChange={handleNodesChange}
      onEdgesChange={handleEdgesChange}
      onNodeDragStart={onNodeDragStart}
      onNodeDrag={onNodeDrag}
      onNodeDragStop={onNodeDragStop}
      onConnect={onConnect}
      onEdgeUpdate={onEdgeUpdate}
      onEdgeUpdateStart={onEdgeUpdateStart}
      onEdgeUpdateEnd={onEdgeUpdateEnd}
      fitView
      fitViewOptions={{ padding: 0.22, duration: 300 }}
      nodesDraggable
      nodesConnectable
      elementsSelectable
      edgesUpdatable
      deleteKeyCode={['Backspace', 'Delete']}
      minZoom={0.3}
      maxZoom={1.8}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} color="#c0bbeb" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

export default function AgentDiagram(props: AgentDiagramProps) {
  return (
    <ReactFlowProvider>
      <AgentDiagramInner {...props} />
    </ReactFlowProvider>
  );
}
