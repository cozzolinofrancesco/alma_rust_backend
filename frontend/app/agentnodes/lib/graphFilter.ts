import type { Node } from 'reactflow';
import type { AgentNodeData } from './types';

export const AGENT_NODES_GRAPH_FILTER_UNTAGGED = '__an_graph_untagged__';

export type AgentNodesGraphFilter = {
  nameQuery: string;
  selectedTags: readonly string[];
};

export function isAgentNodesGraphFilterActive(f: AgentNodesGraphFilter): boolean {
  return f.selectedTags.length > 0 || f.nameQuery.trim().length > 0;
}

function nodeSearchHaystack(n: Node<AgentNodeData>): string {
  const d = n.data;
  return [d.title, d.label, d.headerTitle].filter(Boolean).join(' ').toLowerCase();
}

export function matchesAgentNodeGraphFilter(
  n: Node<AgentNodeData>,
  f: AgentNodesGraphFilter,
): boolean {
  const q = f.nameQuery.trim().toLowerCase();
  if (q) {
    const hay = nodeSearchHaystack(n);
    if (!hay.includes(q)) return false;
  }
  const tags = f.selectedTags;
  if (tags.length === 0) return true;
  const raw = n.data.tag;
  if (raw && tags.includes(raw)) return true;
  if (!raw && tags.includes(AGENT_NODES_GRAPH_FILTER_UNTAGGED)) return true;
  return false;
}
