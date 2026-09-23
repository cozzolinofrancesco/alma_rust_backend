
import dagre from 'dagre';
import type { Canvas272Agent } from '../../canvas-272/lib/types';
import { buildDiagramModel, extractActiveSortedLayers } from '../../canvas-272/lib/sections';
import { resolveLayerCorpusId } from './corpus';
import type {
  AgentEdgeSerialised,
  AgentNodeSerialised,
  AgentNodesGraphV1,
} from './types';

const NODE_WIDTH = 220;
const NODE_HEIGHT = 96;
const RANK_SEP = 90;
const NODE_SEP = 30;

const AUTO_ASPECT_THRESHOLD = 1.5;
const AUTO_MAX_LR_RANKS = 4;

function computeRanks(ids: string[], refsById: Map<string, string[]>): Map<string, number> {
  const ranks = new Map<string, number>();
  const visiting = new Set<string>();
  function dfs(id: string): number {
    if (ranks.has(id)) return ranks.get(id) as number;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const refs = refsById.get(id) ?? [];
    let max = -1;
    for (const ref of refs) { const r = dfs(ref); if (r > max) max = r; }
    const rank = max < 0 ? 0 : max + 1;
    ranks.set(id, rank);
    visiting.delete(id);
    return rank;
  }
  for (const id of ids) dfs(id);
  return ranks;
}

function pickRankdir(ranks: Map<string, number>): 'LR' | 'TB' {
  const rankSizes = new Map<number, number>();
  for (const r of ranks.values()) rankSizes.set(r, (rankSizes.get(r) ?? 0) + 1);
  const numRanks = rankSizes.size;
  const maxPerRank = Math.max(...rankSizes.values(), 0);
  const lrH = maxPerRank * (NODE_HEIGHT + NODE_SEP);
  const lrW = Math.max(numRanks, 1) * (NODE_WIDTH + RANK_SEP);
  return lrH > lrW * AUTO_ASPECT_THRESHOLD || numRanks > AUTO_MAX_LR_RANKS
    ? 'TB'
    : 'LR';
}

export function buildInitialGraph(agent: Canvas272Agent): AgentNodesGraphV1 {
  const activeLayers = extractActiveSortedLayers(agent.layers);
  const activeIds = new Set(activeLayers.map((l) => l.id));

  const refsById = new Map<string, string[]>();
  for (const layer of activeLayers) {
    const rawRefs = layer.referencedSteps ?? [];
    refsById.set(layer.id, rawRefs.filter((r) => activeIds.has(r)));
  }

  const model = buildDiagramModel(agent.layers);
  const headerIds = new Set<string>();
  const sectionLabelByHeaderId = new Map<string, string>();
  const childCountByHeaderId = new Map<string, number>();
  for (const item of model.mainLane) {
    if (item.kind === 'section') {
      headerIds.add(item.section.headerLayer.id);
      sectionLabelByHeaderId.set(item.section.headerLayer.id, item.section.label);
      childCountByHeaderId.set(item.section.headerLayer.id, item.section.children.length);
    }
  }

  const mainLaneIndexOf = new Map<string, number>();
  let order = 0;
  for (const item of model.mainLane) {
    if (item.kind === 'step') {
      mainLaneIndexOf.set(item.layer.id, order++);
    } else {
      mainLaneIndexOf.set(item.section.headerLayer.id, order++);
      for (const child of item.section.children) mainLaneIndexOf.set(child.id, order++);
    }
  }

  const ranks = computeRanks([...activeIds], refsById);
  const rankdir = pickRankdir(ranks);

  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir,
    ranksep: RANK_SEP,
    nodesep: NODE_SEP,
    ranker: 'tight-tree',
    marginx: 20,
    marginy: 20,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const layer of activeLayers) {
    g.setNode(layer.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  for (const layer of activeLayers) {
    for (const refId of refsById.get(layer.id) ?? []) {
      g.setEdge(refId, layer.id);
    }
  }

  dagre.layout(g);

  const nodes: AgentNodeSerialised[] = [];
  const nodeIdForLayer = new Map<string, string>();

  const orderedLayers = [...activeLayers].sort(
    (a, b) => (mainLaneIndexOf.get(a.id) ?? 0) - (mainLaneIndexOf.get(b.id) ?? 0),
  );
  const displayNumberOf = new Map<string, number>();
  orderedLayers.forEach((l, i) => displayNumberOf.set(l.id, i + 1));

  for (const layer of activeLayers) {
    const pos = g.node(layer.id);
    if (!pos) continue;
    const x = pos.x - NODE_WIDTH / 2;
    const y = pos.y - NODE_HEIGHT / 2;
    const isSection = headerIds.has(layer.id);
    const id = isSection ? `section-${layer.id}` : `step-${layer.id}`;
    nodeIdForLayer.set(layer.id, id);

    const runningNumber = displayNumberOf.get(layer.id) ?? 0;

    const corpusId = resolveLayerCorpusId(layer) || undefined;
    if (isSection) {
      nodes.push({
        id,
        type: 'c272Section',
        position: { x, y },
        data: {
          kind: 'section',
          layerId: layer.id,
          title: layer.name,
          indexLabel: `Section ${runningNumber}`,
          label: sectionLabelByHeaderId.get(layer.id) ?? '',
          headerLayerId: layer.id,
          headerTitle: layer.name,
          childCount: childCountByHeaderId.get(layer.id) ?? 0,
          tag: layer.tag || undefined,
          hasOutput: false,
          isEdited: false,
          corpusId,
          direction: rankdir,
        },
      });
    } else {
      nodes.push({
        id,
        type: 'c272Step',
        position: { x, y },
        data: {
          kind: 'step',
          layerId: layer.id,
          title: layer.name,
          indexLabel: `Step ${runningNumber}`,
          tag: layer.tag || undefined,
          hasOutput: false,
          isEdited: false,
          corpusId,
          direction: rankdir,
        },
      });
    }
  }

  const srcHandle = rankdir === 'TB' ? 'bottom' : 'right';
  const tgtHandle = rankdir === 'TB' ? 'top'    : 'left';
  const edges: AgentEdgeSerialised[] = [];
  for (const layer of activeLayers) {
    const targetId = nodeIdForLayer.get(layer.id);
    if (!targetId) continue;
    for (const refId of refsById.get(layer.id) ?? []) {
      const sourceId = nodeIdForLayer.get(refId);
      if (!sourceId) continue;
      edges.push({
        id: `e-ref-${refId}-${layer.id}`,
        source: sourceId,
        sourceHandle: srcHandle,
        target: targetId,
        targetHandle: tgtHandle,
      });
    }
  }

  return {
    version: 1,
    agentId: agent.id,
    agentName: agent.name,
    updatedAt: new Date().toISOString(),
    nodes,
    edges,
  };
}

export const BLANK_AGENT_STARTER_POSITION = { x: 280, y: 240 } as const;

export function buildBlankAgentStarterNode(title: string): AgentNodeSerialised {
  const id = `user-step-${Date.now()}-seed`;
  return {
    id,
    type: 'c272Step',
    position: { ...BLANK_AGENT_STARTER_POSITION },
    data: {
      kind: 'step',
      layerId: id,
      title: title.trim() || 'New step',
      indexLabel: 'Step 1',
      hasOutput: false,
      isEdited: false,
    },
  };
}
