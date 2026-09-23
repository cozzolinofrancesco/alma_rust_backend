'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactFlow, {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  ConnectionLineType,
  Controls,
  MarkerType,
  updateEdge,
  useReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeTypes,
  type Node,
  type NodeChange,
  type NodeDragHandler,
  type NodeTypes,
  type OnConnect,
  type XYPosition,
} from 'reactflow';
import 'reactflow/dist/style.css';
import StepNode from '../../canvas-272/components/StepNode';
import SectionHeaderNode from '../../canvas-272/components/SectionHeaderNode';
import { getTagColor } from '../../components/StepReferenceSelector';
import OffsetEdge, { type OffsetEdgeData } from './OffsetEdge';
import CorpusNode from './CorpusNode';
import CorpusEdge from './CorpusEdge';
import StepPickerMenu, { type StepPickerChoice } from './StepPickerMenu';
import { separateOverlappingNodes } from '../lib/nodeSpacing';
import {
  exportAgentGraphImage,
  type ExportAgentGraphOptions,
} from '../lib/exportAgentGraphImage';
import { AGENTNODES_EXPORT_NO_ROOT } from '../lib/agentnodesExportCodes';
import type { AgentNodeData, CorpusConsumer, CorpusNodeData } from '../lib/types';
import type { Canvas272Layer } from '../../canvas-272/lib/types';
import { useLanguage } from '../../contexts/LanguageContext';
import { resolveLayerCorpusDisplayHint, resolveLayerCorpusId } from '../lib/corpus';
import {
  isAgentNodesGraphFilterActive,
  matchesAgentNodeGraphFilter,
  type AgentNodesGraphFilter,
} from '../lib/graphFilter';

function collectDirectDownstreamIds(sourceId: string, edgeList: Edge[]): Set<string> {
  const result = new Set<string>();
  for (const e of edgeList) {
    if (e.source === sourceId) result.add(e.target);
  }
  return result;
}

function collectDirectUpstreamIds(targetId: string, edgeList: Edge[]): Set<string> {
  const result = new Set<string>();
  for (const e of edgeList) {
    if (e.target === targetId) result.add(e.source);
  }
  return result;
}

function collectUpstreamNodeIds(targetId: string, edgeList: Edge[]): Set<string> {
  const ancestors = new Set<string>();
  const stack: string[] = [targetId];
  const seen = new Set<string>([targetId]);
  while (stack.length > 0) {
    const v = stack.pop()!;
    for (const e of edgeList) {
      if (e.target !== v) continue;
      const src = e.source;
      if (seen.has(src)) continue;
      seen.add(src);
      ancestors.add(src);
      stack.push(src);
    }
  }
  return ancestors;
}

const HIGHLIGHT_STROKE = '#6d28d9';
const RUNNING_STROKE = '#7c3aed';

const CORPUS_NODE_ID_PREFIX = '__rag_corpus__:';
const CORPUS_EDGE_ID_PREFIX = '__rag_corpus_edge__:';
const isVirtualCorpusNodeId = (id: string) => id.startsWith(CORPUS_NODE_ID_PREFIX);
const isVirtualCorpusEdgeId = (id: string) => id.startsWith(CORPUS_EDGE_ID_PREFIX);

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export interface AgentNodesDiagramHandle {
  addAt: (title: string) => string;
  fit: () => void;
  exportImage: (opts: ExportAgentGraphOptions) => Promise<{ ok: true } | { ok: false; error: string }>;
  captureFrame: () => Promise<string | null>;
}

interface AgentNodesDiagramProps {
  nodes: Node<AgentNodeData>[];
  edges: Edge[];
  setNodes: React.Dispatch<React.SetStateAction<Node<AgentNodeData>[]>>;
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
  addStepNode: (title: string, position: XYPosition) => string;
  onOpenNode: (id: string) => void;
  onOpenInWorkflow: (id: string) => void;
  onSetNodeTag?: (nodeId: string, tag: string | null) => void;
  agentId: string | null;
  edgeMode?: 'rigid' | 'smooth';
  runningLayerIds?: ReadonlySet<string>;
  completedLayerIds?: ReadonlySet<string>;
  failedLayerIds?: ReadonlySet<string>;
  isSimulating?: boolean;
  simulationPaused?: boolean;
  onPanDuringSimulation?: () => void;
  showCorpora?: boolean;
  corpusDisplayNameById?: ReadonlyMap<string, string>;
  allLayers?: Canvas272Layer[];
  graphFilter?: AgentNodesGraphFilter | null;
  onRemoveLayer?: (layerId: string) => void;
}

const AgentNodesDiagramInner = forwardRef<AgentNodesDiagramHandle, AgentNodesDiagramProps>(
  function AgentNodesDiagramInner(
    {
      nodes, edges, setNodes, setEdges, addStepNode,
      onOpenNode, onOpenInWorkflow, onSetNodeTag, agentId,
      edgeMode = 'smooth',
      runningLayerIds, completedLayerIds, failedLayerIds,
      isSimulating = false,
      simulationPaused = false,
      onPanDuringSimulation,
      showCorpora = false,
      corpusDisplayNameById,
      allLayers = [],
      graphFilter: graphFilterInput = null,
      onRemoveLayer,
    },
    ref,
  ) {
    const { t } = useLanguage();
    const graphFilter = graphFilterInput ?? null;
    const nodeTypes = useMemo<NodeTypes>(
      () => ({
        c272Step: StepNode,
        c272Section: SectionHeaderNode,
        c272Corpus: CorpusNode,
      }),
      [],
    );

    const edgeTypes = useMemo<EdgeTypes>(
      () => ({ anOffset: OffsetEdge, anCorpus: CorpusEdge }),
      [],
    );

    const fitViewOptions = useMemo(() => ({ padding: 0.22, duration: 300 }), []);
    const proOptions = useMemo(() => ({ hideAttribution: true }), []);
    const deleteKeyCode = useMemo(() => ['Backspace', 'Delete'], []);

    const rf = useReactFlow();
    const flowMountRef = useRef<HTMLDivElement | null>(null);

    const [hoverTargetId, setHoverTargetId] = useState<string | null>(null);
    const [hoverEdgeId, setHoverEdgeId] = useState<string | null>(null);
    const [ctrlHeld, setCtrlHeld] = useState(false);

    const nodesRef = useRef<Node<AgentNodeData>[]>([]);
    const edgesRef = useRef<Edge[]>([]);
    useEffect(() => { nodesRef.current = nodes; }, [nodes]);
    useEffect(() => { edgesRef.current = edges; }, [edges]);

    useEffect(() => {
      setHoverTargetId(null);
      setHoverEdgeId(null);
    }, [agentId]);

    useEffect(() => {
      const onDown = (e: KeyboardEvent) => {
        if (e.key === 'Control' || e.key === 'Meta') setCtrlHeld(true);
      };
      const onUp = (e: KeyboardEvent) => {
        if (e.key === 'Control' || e.key === 'Meta') setCtrlHeld(false);
      };
      const onBlur = () => setCtrlHeld(false);
      window.addEventListener('keydown', onDown);
      window.addEventListener('keyup', onUp);
      window.addEventListener('blur', onBlur);
      return () => {
        window.removeEventListener('keydown', onDown);
        window.removeEventListener('keyup', onUp);
        window.removeEventListener('blur', onBlur);
      };
    }, []);

    const layerIdByNodeId = useMemo(
      () => new Map(nodes.map((n) => [n.id, n.data.layerId])),
      [nodes],
    );

    const flowDirection = useMemo<'LR' | 'TB'>(() => {
      for (const n of nodes) {
        if (n.type !== 'c272Step' && n.type !== 'c272Section') continue;
        const d = n.data.direction;
        if (d === 'TB' || d === 'LR') return d;
      }
      return 'LR';
    }, [nodes]);

    const spacedEdges = useMemo<Edge[]>(() => {
      const posById = new Map(nodes.map((n) => [n.id, n.position]));
      const dimById = new Map(nodes.map((n) => [n.id, { w: n.width ?? 200, h: n.height ?? 60 }]));
      const isTB = flowDirection === 'TB';

      const bySource = new Map<string, Edge[]>();
      const byTarget = new Map<string, Edge[]>();

      for (const e of edges) {
        if (!bySource.has(e.source)) bySource.set(e.source, []);
        bySource.get(e.source)!.push(e);
        if (!byTarget.has(e.target)) byTarget.set(e.target, []);
        byTarget.get(e.target)!.push(e);
      }

      const crossVal = (pos: { x: number; y: number } | undefined) =>
        isTB ? (pos?.x ?? 0) : (pos?.y ?? 0);

      bySource.forEach((group) =>
        group.sort((a, b) => crossVal(posById.get(a.target)) - crossVal(posById.get(b.target))),
      );
      byTarget.forEach((group) =>
        group.sort((a, b) => crossVal(posById.get(a.source)) - crossVal(posById.get(b.source))),
      );

      const srcInfo = new Map<string, { idx: number; count: number }>();
      bySource.forEach((group) => {
        group.forEach((e, i) => srcInfo.set(e.id, { idx: i, count: group.length }));
      });
      const tgtInfo = new Map<string, { idx: number; count: number }>();
      byTarget.forEach((group) => {
        group.forEach((e, i) => tgtInfo.set(e.id, { idx: i, count: group.length }));
      });

      const MIN_CABLE_GAP = 16;

      function spreadToMinGap(vals: number[], minGap: number): number[] {
        const adj = [...vals];
        for (let i = 1; i < adj.length; i++) {
          if (adj[i] - adj[i - 1] < minGap) adj[i] = adj[i - 1] + minGap;
        }
        for (let i = adj.length - 2; i >= 0; i--) {
          if (adj[i + 1] - adj[i] < minGap) adj[i] = adj[i + 1] - minGap;
        }
        const origMid = (vals[0] + vals[vals.length - 1]) / 2;
        const adjMid  = (adj[0] + adj[adj.length - 1]) / 2;
        const shift   = origMid - adjMid;
        return adj.map((v, i) => v + shift - vals[i]);
      }

      const nodeCross = (id: string, side: 'src' | 'tgt') => {
        const pos = posById.get(id) ?? { x: 0, y: 0 };
        const dim = dimById.get(id) ?? { w: 200, h: 60 };
        return isTB
          ? pos.x + (side === 'src' ? dim.w / 2 : dim.w / 2)
          : pos.y + (side === 'src' ? dim.h / 2 : dim.h / 2);
      };

      const tgtBundleById = new Map<string, number>();
      bySource.forEach((group) => {
        if (group.length < 2) return;
        const vals = group.map((e) => nodeCross(e.target, 'tgt'));
        const offsets = spreadToMinGap(vals, MIN_CABLE_GAP);
        group.forEach((e, i) => tgtBundleById.set(e.id, offsets[i]));
      });

      const srcBundleById = new Map<string, number>();
      byTarget.forEach((group) => {
        if (group.length < 2) return;
        const vals = group.map((e) => nodeCross(e.source, 'src'));
        const offsets = spreadToMinGap(vals, MIN_CABLE_GAP);
        group.forEach((e, i) => srcBundleById.set(e.id, offsets[i]));
      });

      const smooth = edgeMode === 'smooth';
      return edges.map((e) => {
        const src = srcInfo.get(e.id) ?? { idx: 0, count: 1 };
        const tgt = tgtInfo.get(e.id) ?? { idx: 0, count: 1 };
        const data: OffsetEdgeData = {
          srcIdx: src.idx, srcCount: src.count,
          tgtIdx: tgt.idx, tgtCount: tgt.count,
          srcBundleOffset: srcBundleById.get(e.id) ?? 0,
          tgtBundleOffset: tgtBundleById.get(e.id) ?? 0,
          smooth,
        };
        return { ...e, type: 'anOffset', data };
      });
    }, [nodes, edges, edgeMode, flowDirection]);

    const nodesWithSize = useMemo<Node<AgentNodeData>[]>(() => {
      const inCount  = new Map<string, number>();
      const outCount = new Map<string, number>();
      for (const e of edges) {
        outCount.set(e.source, (outCount.get(e.source) ?? 0) + 1);
        inCount.set(e.target,  (inCount.get(e.target)  ?? 0) + 1);
      }
      return nodes.map((n) => {
        const maxSide = Math.max(inCount.get(n.id) ?? 0, outCount.get(n.id) ?? 0);
        if (maxSide <= 1) return n;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const style = { ...(n.style ?? {}), '--connections': maxSide } as any;
        return { ...n, style };
      });
    }, [nodes, edges]);

    const hasRunState =
      (runningLayerIds?.size ?? 0) > 0 ||
      (completedLayerIds?.size ?? 0) > 0 ||
      (failedLayerIds?.size ?? 0) > 0;

    const { displayNodes, displayEdges } = useMemo(() => {
      if (hasRunState) {
        const queuedLayerIds = new Set<string>();
        for (const e of spacedEdges) {
          const src = layerIdByNodeId.get(e.source);
          if (!src || !runningLayerIds?.has(src)) continue;
          const tgt = layerIdByNodeId.get(e.target);
          if (
            tgt &&
            !runningLayerIds?.has(tgt) &&
            !completedLayerIds?.has(tgt) &&
            !failedLayerIds?.has(tgt)
          ) {
            queuedLayerIds.add(tgt);
          }
        }

        const nextNodes = nodesWithSize.map((n) => {
          const lid = n.data.layerId;
          const cls = [
            runningLayerIds?.has(lid) ? 'an-rf-node--running' : '',
            completedLayerIds?.has(lid) ? 'an-rf-node--done' : '',
            failedLayerIds?.has(lid) ? 'an-rf-node--failed' : '',
            queuedLayerIds.has(lid) ? 'an-rf-node--queued' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return cls ? { ...n, className: cls } : n;
        });

        const nextEdges = spacedEdges.map((e) => {
          const srcId = layerIdByNodeId.get(e.source);
          if (srcId && runningLayerIds?.has(srcId)) {
            const prevStyle = (typeof e.style === 'object' && e.style) || {};
            return {
              ...e,
              className: [e.className, 'an-rf-edge--flowing'].filter(Boolean).join(' ') || undefined,
              zIndex: isSimulating ? 20 : 10,
              markerEnd: { type: MarkerType.ArrowClosed, color: RUNNING_STROKE },
              style: { ...prevStyle, stroke: RUNNING_STROKE, strokeWidth: isSimulating ? 2.25 : 5 },
            };
          }
          return e;
        });

        return { displayNodes: nextNodes, displayEdges: nextEdges };
      }

      if (ctrlHeld && hoverEdgeId) {
        const hEdge = spacedEdges.find((e) => e.id === hoverEdgeId);
        if (hEdge) {
          const endpointIds = new Set([hEdge.source, hEdge.target]);
          const nextNodes = nodesWithSize.map((n) => {
            if (n.id === hEdge.source) return { ...n, className: 'an-rf-node--sel-upstream' };
            if (n.id === hEdge.target) return { ...n, className: 'an-rf-node--downstream' };
            return { ...n, className: 'an-rf-node--dimmed' };
          });
          const nextEdges = spacedEdges.map((e) => {
            if (e.id !== hoverEdgeId) {
              return { ...e, className: 'an-rf-edge--dimmed', zIndex: 0 };
            }
            const prevStyle = (typeof e.style === 'object' && e.style) || {};
            return {
              ...e,
              className: undefined,
              markerEnd: { type: MarkerType.ArrowClosed, color: HIGHLIGHT_STROKE },
              style: { ...prevStyle, stroke: HIGHLIGHT_STROKE, strokeWidth: 2.5 },
              zIndex: 10,
            };
          });
          void endpointIds;
          return { displayNodes: nextNodes, displayEdges: nextEdges };
        }
      }

      const selectedNode = nodesWithSize.find((n) => n.selected);
      const selDownstreamIds = selectedNode
        ? collectDirectDownstreamIds(selectedNode.id, spacedEdges)
        : new Set<string>();
      const selUpstreamIds = selectedNode
        ? collectDirectUpstreamIds(selectedNode.id, spacedEdges)
        : new Set<string>();
      const hasSelection = selectedNode != null;

      const DOWNSTREAM_STROKE = '#059669';
      const UPSTREAM_SEL_STROKE = '#6d28d9';

      if (!hoverTargetId) {
        if (!hasSelection) return { displayNodes: nodesWithSize, displayEdges: spacedEdges };

        const DECORATION_RE = /an-rf-node--\S+/g;
        const nextNodes = nodesWithSize.map((n) => {
          if (n.id === selectedNode!.id) return { ...n, className: undefined };
          const isDown = selDownstreamIds.has(n.id);
          const isUp   = selUpstreamIds.has(n.id);
          const dim    = !isDown && !isUp;
          const base = (n.className ?? '').replace(DECORATION_RE, '').trim();
          const cls = [
            base,
            isDown ? 'an-rf-node--downstream' : '',
            isUp   ? 'an-rf-node--sel-upstream' : '',
            dim    ? 'an-rf-node--dimmed' : '',
          ].filter(Boolean).join(' ');
          return { ...n, className: cls || undefined };
        });

        const nextEdges = spacedEdges.map((e) => {
          if (e.source === selectedNode!.id) {
            const prevStyle = (typeof e.style === 'object' && e.style) || {};
            return {
              ...e,
              className: [e.className, 'an-rf-edge--outgoing'].filter(Boolean).join(' ') || undefined,
              markerEnd: { type: MarkerType.ArrowClosed, color: DOWNSTREAM_STROKE },
              style: { ...prevStyle, stroke: DOWNSTREAM_STROKE, strokeWidth: 2.5 },
              zIndex: 8,
            };
          }
          if (e.target === selectedNode!.id) {
            const prevStyle = (typeof e.style === 'object' && e.style) || {};
            return {
              ...e,
              className: [e.className, 'an-rf-edge--sel-incoming'].filter(Boolean).join(' ') || undefined,
              markerEnd: { type: MarkerType.ArrowClosed, color: UPSTREAM_SEL_STROKE },
              style: { ...prevStyle, stroke: UPSTREAM_SEL_STROKE, strokeWidth: 2.5 },
              zIndex: 8,
            };
          }
          return { ...e, className: [e.className, 'an-rf-edge--dimmed'].filter(Boolean).join(' ') || undefined, zIndex: 0 };
        });

        return { displayNodes: nextNodes, displayEdges: nextEdges };
      }

      const upstreamIds = collectUpstreamNodeIds(hoverTargetId, spacedEdges);
      const hoverDownstreamIds = collectDirectDownstreamIds(hoverTargetId, spacedEdges);

      const DECORATION_RE2 = /an-rf-node--\S+/g;
      const nextNodes = nodesWithSize.map((n) => {
        const isTarget   = n.id === hoverTargetId;
        const isUpstream = upstreamIds.has(n.id);
        const isDownSel  = selDownstreamIds.has(n.id);
        const isDownHover = hoverDownstreamIds.has(n.id);
        const isSelUp    = selUpstreamIds.has(n.id);
        const dim =
          !isTarget && !isUpstream && !isDownSel && !isDownHover && !isSelUp;
        const base = (n.className ?? '').replace(DECORATION_RE2, '').trim();
        const cls = [
          base,
          isTarget   ? 'an-rf-node--hover-target' : '',
          isUpstream ? 'an-rf-node--upstream' : '',
          isDownSel || isDownHover ? 'an-rf-node--downstream' : '',
          isSelUp    ? 'an-rf-node--sel-upstream' : '',
          dim        ? 'an-rf-node--dimmed' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return { ...n, className: cls || undefined };
      });

      const nextEdges = spacedEdges.map((e) => {
        const arrivesAtHover  = e.target === hoverTargetId;
        const leavesHover     = e.source === hoverTargetId;
        const leavesSelected  = selectedNode && e.source === selectedNode.id;
        const arrivesSelected = selectedNode && e.target === selectedNode.id;

        if (arrivesAtHover) {
          const prevMarker = e.markerEnd;
          const markerEnd =
            prevMarker && typeof prevMarker === 'object' && 'type' in prevMarker
              ? { ...prevMarker, color: HIGHLIGHT_STROKE }
              : prevMarker;
          const prevStyle = (typeof e.style === 'object' && e.style) || {};
          return {
            ...e,
            className: [e.className, 'an-rf-edge--incoming'].filter(Boolean).join(' ') || undefined,
            markerEnd,
            style: { ...prevStyle, stroke: HIGHLIGHT_STROKE, strokeWidth: 3 },
            zIndex: 10,
          };
        }
        if (leavesHover) {
          const prevStyle = (typeof e.style === 'object' && e.style) || {};
          return {
            ...e,
            className: [e.className, 'an-rf-edge--outgoing'].filter(Boolean).join(' ') || undefined,
            markerEnd: { type: MarkerType.ArrowClosed, color: DOWNSTREAM_STROKE },
            style: { ...prevStyle, stroke: DOWNSTREAM_STROKE, strokeWidth: 2.5 },
            zIndex: 8,
          };
        }
        if (leavesSelected) {
          const prevStyle = (typeof e.style === 'object' && e.style) || {};
          return {
            ...e,
            className: [e.className, 'an-rf-edge--outgoing'].filter(Boolean).join(' ') || undefined,
            markerEnd: { type: MarkerType.ArrowClosed, color: DOWNSTREAM_STROKE },
            style: { ...prevStyle, stroke: DOWNSTREAM_STROKE, strokeWidth: 2.5 },
            zIndex: 8,
          };
        }
        if (arrivesSelected) {
          const prevStyle = (typeof e.style === 'object' && e.style) || {};
          return {
            ...e,
            className: [e.className, 'an-rf-edge--sel-incoming'].filter(Boolean).join(' ') || undefined,
            markerEnd: { type: MarkerType.ArrowClosed, color: UPSTREAM_SEL_STROKE },
            style: { ...prevStyle, stroke: UPSTREAM_SEL_STROKE, strokeWidth: 2.5 },
            zIndex: 8,
          };
        }
        const cls = [e.className, 'an-rf-edge--dimmed'].filter(Boolean).join(' ');
        return { ...e, className: cls || undefined, zIndex: 0 };
      });

      return { displayNodes: nextNodes, displayEdges: nextEdges };
    }, [nodesWithSize, spacedEdges, hoverTargetId, hoverEdgeId, ctrlHeld, hasRunState, runningLayerIds, completedLayerIds, failedLayerIds, layerIdByNodeId, isSimulating]);

    const { sliceNodes, sliceEdges, visibleNodeIdsForCorpus } = useMemo(() => {
      if (!graphFilter || !isAgentNodesGraphFilterActive(graphFilter)) {
        return {
          sliceNodes: displayNodes,
          sliceEdges: displayEdges,
          visibleNodeIdsForCorpus: null as Set<string> | null,
        };
      }
      const visible = new Set<string>();
      for (const n of displayNodes) {
        if (matchesAgentNodeGraphFilter(n, graphFilter)) visible.add(n.id);
      }
      return {
        sliceNodes: displayNodes.filter((n) => visible.has(n.id)),
        sliceEdges: displayEdges.filter((e) => visible.has(e.source) && visible.has(e.target)),
        visibleNodeIdsForCorpus: visible,
      };
    }, [displayNodes, displayEdges, graphFilter]);

    const [inspectingCorpusId, setInspectingCorpusId] = useState<string | null>(null);
    const handleInspectCorpus = useCallback((corpusId: string) => {
      setInspectingCorpusId((prev) => (prev === corpusId ? null : corpusId));
    }, []);
    useEffect(() => { setInspectingCorpusId(null); }, [agentId]);

    const docSelectionsById = useMemo(() => {
      const m = new Map<string, string[]>();
      for (const l of allLayers) {
        const v = (l as unknown as Record<string, unknown>).documentSelections;
        m.set(l.id, Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string') : []);
      }
      return m;
    }, [allLayers]);

    const { virtualNodes, virtualEdges } = useMemo(() => {
      if (!showCorpora) return { virtualNodes: [] as Node[], virtualEdges: [] as Edge[] };

      const corpusIdByLayerId = new Map<string, string>();
      const corpusDisplayHintById = new Map<string, string>();
      for (const l of allLayers) {
        const cidRaw = resolveLayerCorpusId(l);
        const cid = cidRaw.trim();
        if (!cid) continue;
        corpusIdByLayerId.set(l.id, cid);
        // Prefer the display name captured at attach time — it survives cross-user
        // sharing where the viewer's registry can't resolve the corpus id.
        const persistedRaw = (l as { corpusDisplayName?: unknown }).corpusDisplayName;
        const persisted = typeof persistedRaw === 'string' ? persistedRaw.trim() : '';
        const hint = (persisted && persisted !== cid) ? persisted : resolveLayerCorpusDisplayHint(l);
        if (hint && !corpusDisplayHintById.has(cid)) corpusDisplayHintById.set(cid, hint);
      }

      type Group = { name: string; consumers: Node<AgentNodeData>[] };
      const byCorpus = new Map<string, Group>();
      for (const n of nodes) {
        if (visibleNodeIdsForCorpus && !visibleNodeIdsForCorpus.has(n.id)) continue;
        const cidRaw = n.data.corpusId || corpusIdByLayerId.get(n.data.layerId) || '';
        const cid = cidRaw.trim();
        if (!cid) continue;
        const display =
          corpusDisplayNameById?.get(cid) ?? corpusDisplayHintById.get(cid) ?? cid;
        if (!byCorpus.has(cid)) byCorpus.set(cid, { name: display, consumers: [] });
        byCorpus.get(cid)!.consumers.push(n);
      }
      if (byCorpus.size === 0) return { virtualNodes: [] as Node[], virtualEdges: [] as Edge[] };

      const CORPUS_WIDTH  = 200;
      const CORPUS_HEIGHT = 90;
      const VERTICAL_GAP  = 70;

      const vNodes: Node[] = [];
      const vEdges: Edge[] = [];

      const layout = Array.from(byCorpus.entries()).map(([cid, group]) => {
        const ys = group.consumers.map((c) => c.position.y);
        const xs = group.consumers.map((c) => c.position.x);
        const avgX = xs.reduce((s, x) => s + x, 0) / xs.length;
        const minY = Math.min(...ys);
        return { cid, group, x: avgX, y: minY - VERTICAL_GAP - CORPUS_HEIGHT };
      });
      layout.sort((a, b) => a.x - b.x);

      const HGAP = 12;
      for (let i = 1; i < layout.length; i++) {
        const prev = layout[i - 1];
        const cur  = layout[i];
        if (cur.x - prev.x < CORPUS_WIDTH + HGAP) {
          cur.x = prev.x + CORPUS_WIDTH + HGAP;
        }
      }

      for (const { cid, group, x, y } of layout) {
        const corpusNodeId = `${CORPUS_NODE_ID_PREFIX}${cid}`;

        const consumers: CorpusConsumer[] = group.consumers.map((consumerNode) => ({
          nodeId: consumerNode.id,
          layerId: consumerNode.data.layerId,
          stepName: consumerNode.data.title,
          documentSelections: docSelectionsById.get(consumerNode.data.layerId) ?? [],
        }));

        const data: CorpusNodeData = {
          corpusId: cid,
          name: group.name,
          consumers,
          onInspect: handleInspectCorpus,
        };

        vNodes.push({
          id: corpusNodeId,
          type: 'c272Corpus',
          position: { x, y },
          width: CORPUS_WIDTH,
          height: CORPUS_HEIGHT,
          data: data as unknown as Record<string, unknown>,
          draggable: false,
          selectable: false,
          connectable: false,
          focusable: false,
          className: 'an-rf-node--corpus',
        });

        for (const consumer of group.consumers) {
          vEdges.push({
            id: `${CORPUS_EDGE_ID_PREFIX}${cid}__${consumer.id}`,
            source: corpusNodeId,
            sourceHandle: 'bottom',
            target: consumer.id,
            targetHandle: 'top',
            type: 'anCorpus',
            markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8' },
            zIndex: 0,
            focusable: false,
            className: 'an-rf-edge--corpus',
          });
        }
      }

      return { virtualNodes: vNodes, virtualEdges: vEdges };
    }, [showCorpora, nodes, allLayers, corpusDisplayNameById, docSelectionsById, handleInspectCorpus, visibleNodeIdsForCorpus]);

    const inspectData = useMemo<{ name: string; consumers: CorpusConsumer[] } | null>(() => {
      if (!inspectingCorpusId) return null;
      const vNode = virtualNodes.find((n) => n.id === `${CORPUS_NODE_ID_PREFIX}${inspectingCorpusId}`);
      if (!vNode) return null;
      const d = vNode.data as unknown as CorpusNodeData;
      return { name: d.name, consumers: d.consumers };
    }, [inspectingCorpusId, virtualNodes]);

    const renderNodes = useMemo<Node[]>(
      () => (virtualNodes.length === 0 ? sliceNodes : [...sliceNodes, ...virtualNodes]),
      [sliceNodes, virtualNodes],
    );
    const renderEdges = useMemo<Edge[]>(
      () => (virtualEdges.length === 0 ? sliceEdges : [...sliceEdges, ...virtualEdges]),
      [sliceEdges, virtualEdges],
    );

    useEffect(() => {
      const id = requestAnimationFrame(() =>
        rf.fitView({ padding: 0.22, duration: 300 }),
      );
      return () => cancelAnimationFrame(id);
    }, [agentId, rf]);

    const prevIsSimulatingRef = useRef(false);
    useEffect(() => {
      if (prevIsSimulatingRef.current && !isSimulating) {
        const id = requestAnimationFrame(() =>
          rf.fitView({ padding: 0.22, duration: 400 }),
        );
        prevIsSimulatingRef.current = false;
        return () => cancelAnimationFrame(id);
      }
      prevIsSimulatingRef.current = isSimulating;
    }, [isSimulating, rf]);

    useEffect(() => {
      if (!isSimulating || simulationPaused || !runningLayerIds?.size) return;
      const firstRunningId = [...runningLayerIds][0];
      const runningNode =
        nodesRef.current.find(
          (n) => n.data.layerId && runningLayerIds.has(n.data.layerId),
        ) ??
        nodesRef.current.find(
          (n) =>
            firstRunningId &&
            (n.id === firstRunningId ||
              n.id === `step-${firstRunningId}` ||
              n.id === `section-${firstRunningId}` ||
              n.id === `substep-${firstRunningId}`),
        );
      if (!runningNode) return;
      const nodeW = runningNode.width  ?? 220;
      const nodeH = runningNode.height ?? 80;
      const cx = runningNode.position.x + nodeW / 2;
      const cy = runningNode.position.y + nodeH / 2;
      const id = requestAnimationFrame(() => {
        const viewport  = rf.getViewport();
        const container = flowMountRef.current;
        const cw = container?.clientWidth  ?? 800;
        const ch = container?.clientHeight ?? 600;
        const zoom = Math.max(viewport.zoom, 0.45);
        const vx = cw * 0.25 - cx * zoom;
        const vy = ch * 0.50 - cy * zoom;
        rf.setViewport({ x: vx, y: vy, zoom }, { duration: 600 });
      });
      return () => cancelAnimationFrame(id);
    }, [runningLayerIds, isSimulating, simulationPaused, rf]);

    type DragCtx = {
      id: string;
      base: XYPosition;
      descendants: Map<string, XYPosition>;
    };
    const dragCtxRef = useRef<DragCtx | null>(null);

    const computeBottomDescendants = useCallback((_rootId: string): Set<string> => {
      return new Set<string>();
    }, []);

    const onNodeDragStart = useCallback<NodeDragHandler>(
      (_e, node) => {
        setHoverTargetId(null);
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
      },
      [computeBottomDescendants],
    );

    const onNodeDrag = useCallback<NodeDragHandler>(
      (_e, node) => {
        const ctx = dragCtxRef.current;
        if (!ctx || ctx.id !== node.id || ctx.descendants.size === 0) return;
        const dx = node.position.x - ctx.base.x;
        const dy = node.position.y - ctx.base.y;
        setNodes((curr) =>
          curr.map((n) => {
            const start = ctx.descendants.get(n.id);
            if (!start) return n;
            return { ...n, position: { x: start.x + dx, y: start.y + dy } };
          }),
        );
      },
      [setNodes],
    );

    const onNodeDragStop = useCallback<NodeDragHandler>(() => {
      dragCtxRef.current = null;
      setNodes((prev) => {
        const next = separateOverlappingNodes(prev, 20, 160, 4);
        return next === prev ? prev : next;
      });
    }, [setNodes]);

    const edgeModeRef = useRef(edgeMode);
    useEffect(() => { edgeModeRef.current = edgeMode; }, [edgeMode]);

    const newEdgeProps = useCallback(
      (source: string, target: string, id: string): Edge => {
        const sourceHandle = flowDirection === 'TB' ? 'bottom' : 'right';
        const targetHandle = flowDirection === 'TB' ? 'top' : 'left';
        return {
          id,
          source,
          sourceHandle,
          target,
          targetHandle,
          type: 'anOffset' as const,
          markerEnd: { type: MarkerType.ArrowClosed, color: '#1a2b5b' },
          style: { stroke: '#1a2b5b', strokeWidth: 2 },
          data: { smooth: edgeModeRef.current === 'smooth' } as OffsetEdgeData,
        };
      },
      [flowDirection],
    );

    const onConnect = useCallback<OnConnect>(
      (params) => {
        if (!params.source || !params.target || params.source === params.target) return;
        const sourceHandle =
          params.sourceHandle ?? (flowDirection === 'TB' ? 'bottom' : 'right');
        const targetHandle =
          params.targetHandle ?? (flowDirection === 'TB' ? 'top' : 'left');
        const id = `user-${params.source}-${params.target}-${Date.now()}`;
        setEdges((es) =>
          addEdge(
            {
              ...newEdgeProps(params.source!, params.target!, id),
              sourceHandle,
              targetHandle,
            },
            es,
          ),
        );
      },
      [setEdges, newEdgeProps, flowDirection],
    );

    type PickerState =
      | { context: 'drag'; menuX: number; menuY: number; sourceId: string; flowPos: XYPosition }
      | { context: 'edge'; menuX: number; menuY: number; edge: Edge }
      | { context: 'canvas'; menuX: number; menuY: number; flowPos: XYPosition };

    const [picker, setPicker] = useState<PickerState | null>(null);
    const closePicker = useCallback(() => setPicker(null), []);

    const handlePickerSelect = useCallback(
      (choice: StepPickerChoice) => {
        if (!picker) return;
        closePicker();

        if (picker.context === 'drag') {
          const name =
            choice === 'audit'
              ? t('agentnodesPage.diagram.defaultAuditStepTitle')
              : t('agentnodesPage.diagram.defaultNewStepTitle');
          const newId = addStepNode(name, picker.flowPos);
          const ts = Date.now();
          setEdges((es) =>
            addEdge(newEdgeProps(picker.sourceId, newId, `user-${picker.sourceId}-${newId}-${ts}`), es),
          );
        } else if (picker.context === 'canvas') {
          const name =
            choice === 'audit'
              ? t('agentnodesPage.diagram.defaultAuditStepTitle')
              : t('agentnodesPage.diagram.defaultNewStepTitle');
          addStepNode(name, picker.flowPos);
        } else {
          const { edge } = picker;
          const name =
            choice === 'audit'
              ? t('agentnodesPage.diagram.defaultAuditStepTitle')
              : t('agentnodesPage.diagram.defaultNewStepTitle');
          const srcNode = nodesRef.current.find((n) => n.id === edge.source);
          const tgtNode = nodesRef.current.find((n) => n.id === edge.target);
          const midX = ((srcNode?.position.x ?? 0) + (tgtNode?.position.x ?? 0)) / 2;
          const midY = ((srcNode?.position.y ?? 0) + (tgtNode?.position.y ?? 0)) / 2;
          const newId = addStepNode(name, { x: midX, y: midY });
          const ts = Date.now();
          setEdges((es) => {
            const without = es.filter((e) => e.id !== edge.id);
            return addEdge(
              newEdgeProps(newId, edge.target, `user-${newId}-${edge.target}-${ts}`),
              addEdge(newEdgeProps(edge.source, newId, `user-${edge.source}-${newId}-${ts}`), without),
            );
          });
        }
      },
      [picker, closePicker, addStepNode, setEdges, newEdgeProps, t],
    );

    const connectSourceRef = useRef<string | null>(null);
    const connectModifierRef = useRef(false);
    const pickerJustOpenedRef = useRef(false);

    const onConnectStart = useCallback(
      (e: React.MouseEvent | React.TouchEvent, { nodeId }: { nodeId: string | null }) => {
        connectSourceRef.current = nodeId;
        connectModifierRef.current =
          'metaKey' in e ? (e as React.MouseEvent).metaKey || (e as React.MouseEvent).ctrlKey : false;
      },
      [],
    );

    const onConnectEnd = useCallback(
      (event: MouseEvent | TouchEvent) => {
        const sourceId = connectSourceRef.current;
        const withModifier = connectModifierRef.current;
        connectSourceRef.current = null;
        connectModifierRef.current = false;
        if (!sourceId) return;

        const target = event.target as Element;
        if (target.closest('.react-flow__handle')) return;
        if (target.closest('.react-flow__node')) return;

        const clientX = 'clientX' in event ? event.clientX : (event as TouchEvent).changedTouches[0].clientX;
        const clientY = 'clientY' in event ? event.clientY : (event as TouchEvent).changedTouches[0].clientY;

        const flowPos = rf.screenToFlowPosition
          ? rf.screenToFlowPosition({ x: clientX, y: clientY })
          : rf.project({ x: clientX, y: clientY });

        const position: XYPosition = { x: flowPos.x - 100, y: flowPos.y - 30 };

        void withModifier;
        pickerJustOpenedRef.current = true;
        setPicker({ context: 'drag', menuX: clientX, menuY: clientY, sourceId, flowPos: position });
        setTimeout(() => { pickerJustOpenedRef.current = false; }, 100);
      },
      [rf],
    );

    const onEdgeClick = useCallback(
      (e: React.MouseEvent, edge: Edge) => {
        if (isVirtualCorpusEdgeId(edge.id)) return;
        e.stopPropagation();
        const menuW = 220;
        const menuH = 260;
        const x = e.clientX + menuW > window.innerWidth  ? e.clientX - menuW : e.clientX;
        const y = e.clientY + menuH > window.innerHeight ? e.clientY - menuH : e.clientY;
        setPicker({ context: 'edge', menuX: x, menuY: y, edge });
      },
      [],
    );

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
            e.id === oldEdge.id
              ? { ...e, type: 'anOffset' as const, data: { smooth: edgeModeRef.current === 'smooth' } as OffsetEdgeData }
              : e,
          );
        });
      },
      [setEdges],
    );
    const onEdgeUpdateEnd = useCallback(
      (_e: MouseEvent | TouchEvent, edge: Edge) => {
        if (!edgeReconnectValidRef.current) {
          setEdges((es) => es.filter((ed) => ed.id !== edge.id));
        }
        edgeReconnectValidRef.current = true;
      },
      [setEdges],
    );

    const onNodesChange = useCallback(
      (changes: NodeChange[]) => {
        for (const change of changes) {
          if (change.type === 'remove') {
            const node = nodesRef.current.find((n) => n.id === change.id);
            const layerId = node?.data?.layerId;
            if (layerId && onRemoveLayer) {
              onRemoveLayer(layerId);
            }
          }
        }
        setNodes((prev) => applyNodeChanges(changes, prev));
      },
      [setNodes, onRemoveLayer],
    );

    const onEdgesChange = useCallback(
      (changes: EdgeChange[]) => {
        setEdges((prev) => applyEdgeChanges(changes, prev));
      },
      [setEdges],
    );

    const onNodeClick = useCallback(
      (e: React.MouseEvent, node: Node) => {
        if (isVirtualCorpusNodeId(node.id)) return;
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          const menuW = 240;
          const menuH = 240;
          const x = e.clientX + menuW > window.innerWidth ? e.clientX - menuW : e.clientX;
          const y = e.clientY + menuH > window.innerHeight ? e.clientY - menuH : e.clientY;
          setCtxMenu({ x, y, nodeId: node.id });
          return;
        }
        onOpenNode(node.id);
      },
      [onOpenNode],
    );

    const onNodeDoubleClick = useCallback(
      (_e: React.MouseEvent, node: Node) => {
        if (isVirtualCorpusNodeId(node.id)) return;
        onOpenInWorkflow(node.id);
      },
      [onOpenInWorkflow],
    );

    const onNodeMouseEnter = useCallback((_e: React.MouseEvent, node: Node) => {
      if (isVirtualCorpusNodeId(node.id)) return;
      setHoverTargetId(node.id);
    }, []);

    const onNodeMouseLeave = useCallback((_e: React.MouseEvent, node: Node) => {
      if (isVirtualCorpusNodeId(node.id)) return;
      setHoverTargetId((id) => (id === node.id ? null : id));
    }, []);

    const onEdgeMouseEnter = useCallback((_e: React.MouseEvent, edge: Edge) => {
      if (isVirtualCorpusEdgeId(edge.id)) return;
      setHoverEdgeId(edge.id);
    }, []);

    const onEdgeMouseLeave = useCallback((_e: React.MouseEvent, edge: Edge) => {
      if (isVirtualCorpusEdgeId(edge.id)) return;
      setHoverEdgeId((id) => (id === edge.id ? null : id));
    }, []);

    type CtxMenu = { x: number; y: number; nodeId: string };
    const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
    const [editingNewTag, setEditingNewTag] = useState(false);
    const [newTagDraft, setNewTagDraft] = useState('');

    const onNodeContextMenu = useCallback(
      (e: React.MouseEvent, node: Node) => {
        if (isVirtualCorpusNodeId(node.id)) {
          return;
        }
        e.preventDefault();
        const menuW = 240;
        const menuH = 240;
        const x = e.clientX + menuW > window.innerWidth ? e.clientX - menuW : e.clientX;
        const y = e.clientY + menuH > window.innerHeight ? e.clientY - menuH : e.clientY;
        setCtxMenu({ x, y, nodeId: node.id });
      },
      [],
    );

    const closeCtxMenu = useCallback(() => {
      setCtxMenu(null);
      setEditingNewTag(false);
      setNewTagDraft('');
    }, []);

    const onMoveStart = useCallback(() => {
      if (isSimulating && !simulationPaused) {
        onPanDuringSimulation?.();
      }
    }, [isSimulating, simulationPaused, onPanDuringSimulation]);

    const onPaneClick = useCallback(
      (e: React.MouseEvent) => {
        closeCtxMenu();
        setInspectingCorpusId(null);
        if (!pickerJustOpenedRef.current) closePicker();

        const modifier = e.metaKey || e.ctrlKey;
        if (
          !modifier
          || connectSourceRef.current
          || pickerJustOpenedRef.current
        ) {
          return;
        }

        const flowPos = rf.screenToFlowPosition
          ? rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
          : rf.project({ x: e.clientX, y: e.clientY });
        const position: XYPosition = { x: flowPos.x - 100, y: flowPos.y - 30 };
        pickerJustOpenedRef.current = true;
        setPicker({ context: 'canvas', menuX: e.clientX, menuY: e.clientY, flowPos: position });
        setTimeout(() => {
          pickerJustOpenedRef.current = false;
        }, 100);
      },
      [closeCtxMenu, closePicker, rf, setPicker],
    );

    useEffect(() => {
      if (!ctxMenu) return undefined;
      const handler = (e: KeyboardEvent) => {
        if (isTypingTarget(e.target)) return;
        if (e.key === 'Escape') setCtxMenu(null);
      };
      document.addEventListener('keydown', handler);
      return () => document.removeEventListener('keydown', handler);
    }, [ctxMenu]);

    const deleteNodeById = useCallback(
      (nodeId: string) => {
        const node = nodes.find((n) => n.id === nodeId);
        const layerId = node?.data?.layerId;
        setNodes((ns) => ns.filter((n) => n.id !== nodeId));
        setEdges((es) => es.filter((e) => e.source !== nodeId && e.target !== nodeId));
        setCtxMenu(null);
        if (layerId && onRemoveLayer) {
          onRemoveLayer(layerId);
        }
      },
      [setNodes, setEdges, nodes, onRemoveLayer],
    );

    useEffect(() => {
      const handler = (e: KeyboardEvent) => {
        if (isTypingTarget(e.target)) return;
        if (e.key !== 'Enter') return;
        const selected = nodesRef.current.find((n) => n.selected);
        if (selected) onOpenNode(selected.id);
      };
      document.addEventListener('keydown', handler);
      return () => document.removeEventListener('keydown', handler);
    }, [onOpenNode]);

    useImperativeHandle(
      ref,
      () => ({
        addAt(title) {
          const viewport = rf.getViewport();
          const { innerWidth: w, innerHeight: h } = window;
          const flow = rf.project
            ? rf.project({ x: w / 2, y: h / 2 })
            : {
                x: (-viewport.x + w / 2) / viewport.zoom,
                y: (-viewport.y + h / 2) / viewport.zoom,
              };
          return addStepNode(title, flow);
        },
        fit() {
          rf.fitView({ padding: 0.22, duration: 300 });
        },
        exportImage(opts: ExportAgentGraphOptions) {
          const root = flowMountRef.current?.querySelector('.react-flow') as HTMLElement | null;
          if (!root) {
            return Promise.resolve({ ok: false as const, error: AGENTNODES_EXPORT_NO_ROOT });
          }
          const base = agentId ? `agent-nodes-${agentId}` : 'agent-nodes';
          return exportAgentGraphImage(root, base, opts);
        },
        async captureFrame() {
          const root = flowMountRef.current?.querySelector('.react-flow') as HTMLElement | null;
          if (!root) return null;
          try {
            const { toPng } = await import('html-to-image');
            return await toPng(root, {
              cacheBust: true,
              backgroundColor: '#f8f8f8',
              pixelRatio: 1,
              skipFonts: true,
              filter: (node: HTMLElement) => {
                const cls = node.classList;
                return (
                  !cls?.contains('react-flow__controls') &&
                  !cls?.contains('react-flow__minimap') &&
                  !cls?.contains('react-flow__attribution')
                );
              },
            });
          } catch {
            return null;
          }
        },
      }),
      [rf, addStepNode, agentId],
    );

    if (nodes.length === 0) {
      return (
        <div className="c272-empty">
          {t('agentnodesPage.diagram.noStepsTitle')}
          <div className="an-empty-hint">
            {t('agentnodesPage.diagram.noStepsHint')}
          </div>
        </div>
      );
    }

    return (
      <>
        <div
          ref={flowMountRef}
          className={[
            'an-react-flow-mount',
            isSimulating ? 'an-simulating' : '',
            isSimulating && simulationPaused ? 'an-simulation-paused' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <ReactFlow
            nodes={renderNodes}
            edges={renderEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            onNodeMouseEnter={onNodeMouseEnter}
            onNodeMouseLeave={onNodeMouseLeave}
            onEdgeMouseEnter={onEdgeMouseEnter}
            onEdgeMouseLeave={onEdgeMouseLeave}
            onNodeContextMenu={onNodeContextMenu}
            onEdgeClick={onEdgeClick}
            onPaneClick={onPaneClick}
            onMoveStart={onMoveStart}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            onEdgeUpdate={onEdgeUpdate}
            onEdgeUpdateStart={onEdgeUpdateStart}
            onEdgeUpdateEnd={onEdgeUpdateEnd}
            connectionLineType={edgeMode === 'smooth' ? ConnectionLineType.Bezier : ConnectionLineType.SmoothStep}
            fitView
            fitViewOptions={fitViewOptions}
            nodesDraggable={!isSimulating}
            nodesConnectable={!isSimulating}
            elementsSelectable
            edgesUpdatable={!isSimulating}
            deleteKeyCode={deleteKeyCode}
            minZoom={0.3}
            maxZoom={1.8}
            proOptions={proOptions}
          >
            <Background gap={20} color="#c0bbeb" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        {ctxMenu && (() => {
          const ctxNode = nodes.find((n) => n.id === ctxMenu.nodeId);
          const currentTag = ctxNode?.data.tag ?? null;
          const existingTags = Array.from(
            new Set(
              nodes
                .map((n) => n.data.tag)
                .filter((t): t is string => Boolean(t)),
            ),
          ).sort();
          const setTag = (tag: string | null) => {
            onSetNodeTag?.(ctxMenu.nodeId, tag);
            closeCtxMenu();
          };
          const commitNewTag = () => {
            const trimmed = newTagDraft.trim();
            if (!trimmed) {
              setEditingNewTag(false);
              setNewTagDraft('');
              return;
            }
            setTag(trimmed);
          };
          return (
            <>
              {}
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 998 }}
                onClick={closeCtxMenu}
                onContextMenu={(e) => { e.preventDefault(); closeCtxMenu(); }}
              />
              <div
                className="an-ctx-menu"
                style={{ position: 'fixed', top: ctxMenu.y, left: ctxMenu.x, zIndex: 999 }}
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className="an-ctx-menu__item"
                  onClick={() => { onOpenNode(ctxMenu.nodeId); closeCtxMenu(); }}
                >
                  {t('agentnodesPage.diagram.editStep')}
                </button>

                {onSetNodeTag && (
                  <>
                    <div className="an-ctx-menu__sep" />
                    <div className="an-ctx-menu__section-label">{t('agentnodesPage.diagram.tagSectionLabel')}</div>

                    {editingNewTag ? (
                      <div className="an-ctx-menu__tag-input-row">
                        <input
                          type="text"
                          autoFocus
                          className="an-ctx-menu__tag-input"
                          placeholder={t('agentnodesPage.diagram.tagPlaceholder')}
                          value={newTagDraft}
                          onChange={(e) => setNewTagDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              commitNewTag();
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              setEditingNewTag(false);
                              setNewTagDraft('');
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="an-ctx-menu__tag-input-confirm"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={commitNewTag}
                        >
                          {t('agentnodesPage.diagram.tagAdd')}
                        </button>
                      </div>
                    ) : (
                      <>
                        {existingTags.length > 0 && (
                          <div className="an-ctx-menu__tag-row">
                            {existingTags.map((tagName) => {
                              const tc = getTagColor(tagName);
                              const active = currentTag === tagName;
                              return (
                                <button
                                  key={tagName}
                                  type="button"
                                  className={`an-ctx-menu__tag-pill${active ? ' an-ctx-menu__tag-pill--active' : ''}`}
                                  style={{
                                    background: tc.border,
                                    borderColor: tc.border,
                                    color: '#fff',
                                  }}
                                  onClick={() => setTag(tagName)}
                                >
                                  {tagName}
                                </button>
                              );
                            })}
                          </div>
                        )}
                        <button
                          className="an-ctx-menu__item an-ctx-menu__item--small"
                          onClick={() => { setNewTagDraft(''); setEditingNewTag(true); }}
                        >
                          {t('agentnodesPage.diagram.newTag')}
                        </button>
                        {currentTag && (
                          <button
                            className="an-ctx-menu__item an-ctx-menu__item--small"
                            onClick={() => setTag(null)}
                          >
                            {t('agentnodesPage.diagram.clearTag')}
                          </button>
                        )}
                      </>
                    )}
                  </>
                )}

                <div className="an-ctx-menu__sep" />
                <button
                  className="an-ctx-menu__item an-ctx-menu__item--danger"
                  onClick={() => deleteNodeById(ctxMenu.nodeId)}
                >
                  {t('agentnodesPage.diagram.deleteNode')}
                </button>
              </div>
            </>
          );
        })()}

        {picker && (
          <StepPickerMenu
            x={picker.menuX}
            y={picker.menuY}
            context={picker.context}
            onSelect={handlePickerSelect}
            onClose={closePicker}
          />
        )}

        {}
        {inspectData && (
          <>
            {}
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 1998 }}
              onClick={() => setInspectingCorpusId(null)}
            />
            <div
              className="an-corpus-inspect"
              role="dialog"
              aria-modal="false"
              aria-label={t('agentnodesPage.diagram.corpusInspectAria', { name: inspectData.name })}
              style={{ position: 'fixed', top: 80, right: 16, zIndex: 1999 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="an-corpus-inspect__header">
                <span className="an-corpus-inspect__icon" aria-hidden>⛁</span>
                <div className="an-corpus-inspect__heading">
                  <div className="an-corpus-inspect__label">{t('agentnodesPage.diagram.ragCorpusLabel')}</div>
                  <div className="an-corpus-inspect__name" title={inspectData.name}>
                    {inspectData.name}
                  </div>
                </div>
                <button
                  type="button"
                  className="an-corpus-inspect__close"
                  aria-label={t('agentnodesPage.diagram.closeAria')}
                  onClick={() => setInspectingCorpusId(null)}
                >
                  ×
                </button>
              </div>

              <div className="an-corpus-inspect__body">
                {inspectData.consumers.length === 0 ? (
                  <div className="an-corpus-inspect__empty">{t('agentnodesPage.diagram.corpusInspectEmpty')}</div>
                ) : (
                  inspectData.consumers.map((c) => (
                    <div key={c.layerId} className="an-corpus-inspect__consumer">
                      <div className="an-corpus-inspect__consumer-name">
                        {c.stepName}
                      </div>
                      {c.documentSelections.length === 0 ? (
                        <div className="an-corpus-inspect__docs-note">
                          {t('agentnodesPage.diagram.fullCorpusNoFilter')}
                        </div>
                      ) : (
                        <ul className="an-corpus-inspect__docs">
                          {c.documentSelections.map((doc) => (
                            <li key={doc} className="an-corpus-inspect__doc">
                              <span className="an-corpus-inspect__doc-icon" aria-hidden>📄</span>
                              <span className="an-corpus-inspect__doc-name" title={doc}>
                                {doc.split(/[/\\]/).pop() ?? doc}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        )}
      </>
    );
  },
);

const AgentNodesDiagram = forwardRef<AgentNodesDiagramHandle, AgentNodesDiagramProps>(
  function AgentNodesDiagram(props, ref) {
    return (
      <ReactFlowProvider>
        <AgentNodesDiagramInner {...props} ref={ref} />
      </ReactFlowProvider>
    );
  },
);

export default AgentNodesDiagram;
