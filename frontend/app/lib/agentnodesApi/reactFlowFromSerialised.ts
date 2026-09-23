import type { Edge, Node } from 'reactflow';
import type { AgentEdgeSerialised, AgentNodeData, AgentNodeSerialised } from '../../agentnodes/lib/types';

export function serialisedNodesToRf(nodes: AgentNodeSerialised[]): Node<AgentNodeData>[] {
  return nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: n.position,
    data: n.data,
  }));
}

export function serialisedEdgesToRf(edges: AgentEdgeSerialised[]): Edge[] {
  return edges.map(
    (e) =>
      ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? undefined,
        targetHandle: e.targetHandle ?? undefined,
        type: 'smoothstep',
        markerEnd: { type: 'arrowclosed', color: '#1a2b5b' },
        style: { stroke: '#1a2b5b', strokeWidth: 2 },
      }) as Edge
  );
}

export function rfNodesToSerialised(nodes: Node<AgentNodeData>[]): AgentNodeSerialised[] {
  return nodes.map((n) => {
    const { onClick: _drop, ...data } = n.data;
    void _drop;
    return {
      id: n.id,
      type: (n.type as AgentNodeSerialised['type']) ?? 'c272Step',
      position: n.position,
      data,
    };
  });
}

export function rfEdgesToSerialised(edges: Edge[]): AgentEdgeSerialised[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? null,
    targetHandle: e.targetHandle ?? null,
  }));
}
