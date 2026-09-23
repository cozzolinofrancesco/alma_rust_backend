
import type { Canvas272Agent } from '../../canvas-272/lib/types';
import { extractActiveSortedLayers } from '../../canvas-272/lib/sections';
import type { AgentNodesGraphV1 } from './types';

export const RECIPE_DEMO_ID_PREFIX = 'recipe-demo-';
export const USER_STEP_LAYER_PREFIX = 'user-step-';

export type PersistedGraphInvalidReason =
  | 'id_mismatch'
  | 'recipe_demo'
  | 'unknown_layer'
  | 'dangling_edge'
  | 'empty_with_layers';

export type PersistedGraphValidation =
  | { ok: true }
  | { ok: false; reason: PersistedGraphInvalidReason };

export function validatePersistedGraphForAgent(
  graph: AgentNodesGraphV1,
  agent: Canvas272Agent,
): PersistedGraphValidation {
  if (graph.agentId !== agent.id) {
    return { ok: false, reason: 'id_mismatch' };
  }

  const layerIds = new Set(agent.layers.map((l) => l.id));
  const activeLayers = extractActiveSortedLayers(agent.layers);

  if (activeLayers.length > 0 && graph.nodes.length === 0) {
    return { ok: false, reason: 'empty_with_layers' };
  }

  const nodeIds = new Set<string>();
  for (const n of graph.nodes) {
    nodeIds.add(n.id);
    const lid = n.data?.layerId;
    if (typeof lid !== 'string' || !lid.length) {
      return { ok: false, reason: 'unknown_layer' };
    }
    if (n.id.startsWith(RECIPE_DEMO_ID_PREFIX) || lid.startsWith(RECIPE_DEMO_ID_PREFIX)) {
      return { ok: false, reason: 'recipe_demo' };
    }
    if (lid.startsWith(USER_STEP_LAYER_PREFIX)) {
      if (lid !== n.id) {
        return { ok: false, reason: 'unknown_layer' };
      }
      continue;
    }
    if (!layerIds.has(lid)) {
      return { ok: false, reason: 'unknown_layer' };
    }
  }

  for (const e of graph.edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) {
      return { ok: false, reason: 'dangling_edge' };
    }
  }

  return { ok: true };
}
