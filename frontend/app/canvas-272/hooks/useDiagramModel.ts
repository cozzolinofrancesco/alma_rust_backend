
import { useMemo } from 'react';
import { MarkerType, type Edge, type Node } from 'reactflow';
import type { Canvas272Agent, Canvas272Layer } from '../lib/types';
import { getLayerOutputText } from '../lib/layerOutput';
import { buildDiagramModel, extractActiveSortedLayers } from '../lib/sections';

const MAIN_X_GAP = 300;
const SUB_Y_GAP = 150;
const BLOCK_GAP = 30;
const TB_ITEM_GAP = MAIN_X_GAP;

const LR_ASPECT_THRESHOLD = 1.5;

const MAX_LR_COLUMNS = 4;

export type DiagramDirection = 'LR' | 'TB';

export type StepNodeData = {
  layerId: string;
  title: string;
  indexLabel: string;
  tag?: string;
  hasOutput: boolean;
  isEdited: boolean;
  hasDebug: boolean;
  corpusId?: string;
  onClick?: (layerId: string) => void;
  onOpenDebug?: (layerId: string) => void;
  direction?: DiagramDirection;
};

export type SectionNodeData = {
  label: string;
  headerLayerId: string;
  headerTitle: string;
  childCount: number;
  tag?: string;
  hasOutput: boolean;
  isEdited: boolean;
  hasDebug: boolean;
  corpusId?: string;
  onClick?: (layerId: string) => void;
  onOpenDebug?: (layerId: string) => void;
  direction?: DiagramDirection;
};

interface BuildInput {
  agent: Canvas272Agent;
  sidecarOutputs: Record<string, string>;
  onNodeClick: (layerId: string) => void;
  onOpenDebug: (layerId: string) => void;
}

function layerHasDebug(layer: Canvas272Layer): boolean {
  const info = layer.debugInfo;
  if (!info) return false;
  return Boolean(
    (info.reasoning && info.reasoning.trim().length > 0) ||
      (info.sources && info.sources.length > 0) ||
      (info.supports && info.supports.length > 0),
  );
}

function outputForLayer(
  layerResult: string | undefined,
  edited: string | undefined
): { hasOutput: boolean; isEdited: boolean } {
  const editedNonEmpty = typeof edited === 'string' && edited.trim().length > 0;
  const originalNonEmpty = typeof layerResult === 'string' && layerResult.trim().length > 0;
  return { hasOutput: editedNonEmpty || originalNonEmpty, isEdited: editedNonEmpty };
}

function computeLevels(
  activeIds: Set<string>,
  refsById: Map<string, string[]>
): Map<string, number> {
  const levels = new Map<string, number>();
  const visiting = new Set<string>();

  function dfs(id: string): number {
    if (levels.has(id)) return levels.get(id) as number;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const refs = refsById.get(id) ?? [];
    let max = -1;
    for (const refId of refs) {
      const refLevel = dfs(refId);
      if (refLevel > max) max = refLevel;
    }
    const level = max < 0 ? 0 : max + 1;
    levels.set(id, level);
    visiting.delete(id);
    return level;
  }

  for (const id of activeIds) {
    dfs(id);
  }
  return levels;
}

export function useDiagramModel({ agent, sidecarOutputs, onNodeClick, onOpenDebug }: BuildInput): {
  nodes: Node[];
  edges: Edge[];
  stepCount: number;
  sectionChildrenByHeaderId: Record<string, string[]>;
  direction: DiagramDirection;
} {
  return useMemo(() => {
    const activeLayers = extractActiveSortedLayers(agent.layers);
    const activeIds = new Set(activeLayers.map((l) => l.id));

    const refsById = new Map<string, string[]>();
    for (const layer of activeLayers) {
      const validRefs = (layer.referencedSteps ?? []).filter((r) => activeIds.has(r));
      refsById.set(layer.id, validRefs);
    }

    const levelOf = computeLevels(activeIds, refsById);

    const model = buildDiagramModel(agent.layers);

    const mainLaneIndexOf = new Map<string, number>();
    model.mainLane.forEach((item, idx) => {
      const id = item.kind === 'step' ? item.layer.id : item.section.headerLayer.id;
      mainLaneIndexOf.set(id, idx);
    });

    type ColumnItem =
      | { kind: 'step'; layerId: string; mainIdx: number }
      | { kind: 'section'; headerId: string; childIds: string[]; mainIdx: number };

    const columnMap = new Map<number, ColumnItem[]>();

    for (const item of model.mainLane) {
      if (item.kind === 'step') {
        const col = levelOf.get(item.layer.id) ?? 0;
        if (!columnMap.has(col)) columnMap.set(col, []);
        (columnMap.get(col) as ColumnItem[]).push({
          kind: 'step',
          layerId: item.layer.id,
          mainIdx: mainLaneIndexOf.get(item.layer.id) ?? 0,
        });
      } else {
        const col = levelOf.get(item.section.headerLayer.id) ?? 0;
        if (!columnMap.has(col)) columnMap.set(col, []);
        (columnMap.get(col) as ColumnItem[]).push({
          kind: 'section',
          headerId: item.section.headerLayer.id,
          childIds: item.section.children.map((c) => c.id),
          mainIdx: mainLaneIndexOf.get(item.section.headerLayer.id) ?? 0,
        });
      }
    }

    for (const items of columnMap.values()) {
      items.sort((a, b) => a.mainIdx - b.mainIdx);
    }

    const numLevels = columnMap.size;
    const maxColHeight = numLevels === 0 ? 0 : Math.max(
      ...Array.from(columnMap.values()).map((items) =>
        items.reduce(
          (sum, item) => sum + (item.kind === 'step' ? 1 : 1 + item.childIds.length),
          0,
        ),
      ),
    );
    const lrHeight = maxColHeight * (SUB_Y_GAP + BLOCK_GAP);
    const lrWidth = Math.max(numLevels, 1) * MAIN_X_GAP;
    const direction: DiagramDirection =
      lrHeight > lrWidth * LR_ASPECT_THRESHOLD || numLevels > MAX_LR_COLUMNS
        ? 'TB'
        : 'LR';

    const nodes: Node[] = [];
    const layerById = new Map(activeLayers.map((l) => [l.id, l]));
    const nodeIdForLayer = new Map<string, string>();
    const sectionChildrenByHeaderId: Record<string, string[]> = {};

    let runningNumber = 1;

    for (const [col, items] of Array.from(columnMap.entries()).sort(([a], [b]) => a - b)) {
      const fixedAxis = col * MAIN_X_GAP;
      let currentOffset = 0;

      const pos = (offset: number): { x: number; y: number } =>
        direction === 'LR'
          ? { x: fixedAxis, y: offset }
          : { x: offset,    y: fixedAxis };

      const itemGap = direction === 'LR' ? SUB_Y_GAP + BLOCK_GAP : TB_ITEM_GAP;
      const subGap = direction === 'LR' ? SUB_Y_GAP : TB_ITEM_GAP;

      for (const item of items) {
        if (item.kind === 'step') {
          const layer = layerById.get(item.layerId);
          if (!layer) { currentOffset += itemGap; continue; }
          const { hasOutput, isEdited } = outputForLayer(
            getLayerOutputText(layer) || undefined,
            sidecarOutputs[layer.id]
          );
          const nodeId = `step-${layer.id}`;
          nodeIdForLayer.set(layer.id, nodeId);
          nodes.push({
            id: nodeId,
            type: 'c272Step',
            position: pos(currentOffset),
            data: {
              layerId: layer.id,
              title: layer.name,
              indexLabel: `Step ${runningNumber}`,
              tag: layer.tag || undefined,
              hasOutput,
              isEdited,
              hasDebug: layerHasDebug(layer),
              direction,
              onClick: onNodeClick,
              onOpenDebug,
            } satisfies StepNodeData,
          });
          runningNumber += 1;
          currentOffset += itemGap;
        } else {
          const headerLayer = layerById.get(item.headerId);
          if (!headerLayer) {
            currentOffset += (1 + item.childIds.length) * subGap + BLOCK_GAP;
            continue;
          }
          const { hasOutput: headerHasOutput, isEdited: headerEdited } = outputForLayer(
            getLayerOutputText(headerLayer) || undefined,
            sidecarOutputs[headerLayer.id]
          );
          const headerNodeId = `section-${headerLayer.id}`;
          nodeIdForLayer.set(headerLayer.id, headerNodeId);

          const sectionObj = model.mainLane
            .find((mi) => mi.kind === 'section' && mi.section.headerLayer.id === headerLayer.id);
          const sectionLabel = sectionObj?.kind === 'section' ? sectionObj.section.label : headerLayer.name;

          nodes.push({
            id: headerNodeId,
            type: 'c272Section',
            position: pos(currentOffset),
            data: {
              label: sectionLabel,
              headerLayerId: headerLayer.id,
              headerTitle: headerLayer.name,
              childCount: item.childIds.length,
              tag: headerLayer.tag || undefined,
              hasOutput: headerHasOutput,
              isEdited: headerEdited,
              hasDebug: layerHasDebug(headerLayer),
              direction,
              onClick: onNodeClick,
              onOpenDebug,
            } satisfies SectionNodeData,
          });
          runningNumber += 1;

          const childNodeIds: string[] = [];
          item.childIds.forEach((childId, i) => {
            const childLayer = layerById.get(childId);
            if (!childLayer) return;
            const { hasOutput, isEdited } = outputForLayer(
              getLayerOutputText(childLayer) || undefined,
              sidecarOutputs[childLayer.id]
            );
            const subNodeId = `substep-${childLayer.id}`;
            nodeIdForLayer.set(childLayer.id, subNodeId);
            childNodeIds.push(subNodeId);
            nodes.push({
              id: subNodeId,
              type: 'c272Step',
              position: pos(currentOffset + (i + 1) * subGap),
              data: {
                layerId: childLayer.id,
                title: childLayer.name,
                indexLabel: `Step ${runningNumber}`,
                tag: childLayer.tag || undefined,
                hasOutput,
                isEdited,
                hasDebug: layerHasDebug(childLayer),
                direction,
                onClick: onNodeClick,
                onOpenDebug,
              } satisfies StepNodeData,
            });
            runningNumber += 1;
          });

          sectionChildrenByHeaderId[headerNodeId] = childNodeIds;
          currentOffset += (1 + item.childIds.length) * subGap + BLOCK_GAP;
        }
      }
    }

    const edges: Edge[] = [];
    const edgeStyle = { stroke: '#1a2b5b', strokeWidth: 2 };
    const [srcHandle, tgtHandle] = direction === 'LR'
      ? ['right', 'left']
      : ['bottom', 'top'];

    for (const layer of activeLayers) {
      const targetNodeId = nodeIdForLayer.get(layer.id);
      if (!targetNodeId) continue;
      const refs = refsById.get(layer.id) ?? [];
      for (const refId of refs) {
        const sourceNodeId = nodeIdForLayer.get(refId);
        if (!sourceNodeId) continue;
        edges.push({
          id: `e-ref-${refId}-${layer.id}`,
          source: sourceNodeId,
          sourceHandle: srcHandle,
          target: targetNodeId,
          targetHandle: tgtHandle,
          type: 'smoothstep',
          markerEnd: { type: MarkerType.ArrowClosed, color: '#1a2b5b' },
          style: edgeStyle,
        });
      }
    }

    return { nodes, edges, stepCount: runningNumber - 1, sectionChildrenByHeaderId, direction };
  }, [agent, sidecarOutputs, onNodeClick, onOpenDebug]);
}
