
import type { AgentNodesGraphV1 } from './types';

function storageKey(projectId: string, agentId: string): string {
  return `agentnodes:${projectId}:${agentId}`;
}

export function readGraph(
  projectId: string,
  agentId: string,
): AgentNodesGraphV1 | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey(projectId, agentId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AgentNodesGraphV1;
    if (parsed?.version !== 1) return null;
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeGraph(projectId: string, graph: AgentNodesGraphV1): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      storageKey(projectId, graph.agentId),
      JSON.stringify(graph),
    );
  } catch {
  }
}

export function clearGraph(projectId: string, agentId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(storageKey(projectId, agentId));
  } catch {
  }
}
