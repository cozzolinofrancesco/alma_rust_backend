
import type { Edge, Node, XYPosition } from 'reactflow';

const DEFAULT_W = 220;
const DEFAULT_H = 70;

export const NODE_MIN_GAP = 40;

const EDGE_SAMPLES = 24;

function overlapsAnyNode(
  pos: XYPosition,
  w: number,
  h: number,
  gap: number,
  nodes: Node[],
): boolean {
  const px1 = pos.x - gap;
  const py1 = pos.y - gap;
  const px2 = pos.x + w + gap;
  const py2 = pos.y + h + gap;

  for (const n of nodes) {
    const nw = n.width  ?? DEFAULT_W;
    const nh = n.height ?? DEFAULT_H;
    const nx2 = n.position.x + nw;
    const ny2 = n.position.y + nh;
    if (px1 < nx2 && px2 > n.position.x && py1 < ny2 && py2 > n.position.y) return true;
  }
  return false;
}

function sampleEdgeBezier(
  sx: number, sy: number,
  tx: number, ty: number,
  n: number,
): XYPosition[] {
  const mx = (sx + tx) / 2;
  const pts: XYPosition[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push({
      x: u * u * u * sx + 3 * u * u * t * mx + 3 * u * t * t * mx + t * t * t * tx,
      y: u * u * u * sy + 3 * u * u * t * sy + 3 * u * t * t * ty + t * t * t * ty,
    });
  }
  return pts;
}

function overlapsEdge(
  pos: XYPosition,
  w: number,
  h: number,
  gap: number,
  edge: Edge,
  nodeById: Map<string, Node>,
): boolean {
  const src = nodeById.get(edge.source);
  const tgt = nodeById.get(edge.target);
  if (!src || !tgt) return false;

  const sx = src.position.x + (src.width  ?? DEFAULT_W);
  const sy = src.position.y + (src.height ?? DEFAULT_H) / 2;
  const tx = tgt.position.x;
  const ty = tgt.position.y + (tgt.height ?? DEFAULT_H) / 2;

  const pts = sampleEdgeBezier(sx, sy, tx, ty, EDGE_SAMPLES);

  const px1 = pos.x - gap;
  const py1 = pos.y - gap;
  const px2 = pos.x + w + gap;
  const py2 = pos.y + h + gap;

  for (const p of pts) {
    if (p.x >= px1 && p.x <= px2 && p.y >= py1 && p.y <= py2) return true;
  }
  return false;
}

export function overlapsAnyEdge(
  pos: XYPosition,
  w: number,
  h: number,
  gap: number,
  edges: Edge[],
  nodeById: Map<string, Node>,
): boolean {
  for (const e of edges) {
    if (overlapsEdge(pos, w, h, gap, e, nodeById)) return true;
  }
  return false;
}

function isEndpoint(nodeId: string, edge: Edge): boolean {
  return edge.source === nodeId || edge.target === nodeId;
}

function conflicts(
  pos: XYPosition,
  w: number,
  h: number,
  gap: number,
  nodes: Node[],
  edges: Edge[],
  nodeById: Map<string, Node>,
): boolean {
  return (
    overlapsAnyNode(pos, w, h, gap, nodes) ||
    overlapsAnyEdge(pos, w, h, gap, edges, nodeById)
  );
}

export function findFreePosition(
  proposed: XYPosition,
  nodes: Node[],
  edges: Edge[] = [],
  nodeW = DEFAULT_W,
  nodeH = DEFAULT_H,
  gap = NODE_MIN_GAP,
): XYPosition {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  if (!conflicts(proposed, nodeW, nodeH, gap, nodes, edges, nodeById)) return proposed;

  const stepX = nodeW + gap;
  const stepY = nodeH + gap;

  for (let ring = 1; ring <= 16; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
        const candidate: XYPosition = {
          x: proposed.x + dx * stepX,
          y: proposed.y + dy * stepY,
        };
        if (!conflicts(candidate, nodeW, nodeH, gap, nodes, edges, nodeById)) {
          return candidate;
        }
      }
    }
  }

  const maxY = nodes.reduce(
    (m, n) => Math.max(m, n.position.y + (n.height ?? DEFAULT_H)),
    proposed.y,
  );
  return { x: proposed.x, y: maxY + gap };
}

export function resolveAllConflicts(
  nodes: Node[],
  edges: Edge[],
  gap = NODE_MIN_GAP,
  maxPasses = 3,
): Node[] {
  let current = nodes;

  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    const nodeById = new Map(current.map((n) => [n.id, n]));

    const next = current.map((node) => {
      const w = node.width  ?? DEFAULT_W;
      const h = node.height ?? DEFAULT_H;
      const unrelatedEdges = edges.filter((e) => !isEndpoint(node.id, e));
      if (unrelatedEdges.length === 0) return node;

      const onEdge = overlapsAnyEdge(node.position, w, h, gap / 2, unrelatedEdges, nodeById);
      if (!onEdge) return node;

      const otherNodes = current.filter((n) => n.id !== node.id);
      const freePos = findFreePosition(node.position, otherNodes, unrelatedEdges, w, h, gap);
      if (freePos.x === node.position.x && freePos.y === node.position.y) return node;

      changed = true;
      return { ...node, position: freePos };
    });

    current = changed ? next : current;
    if (!changed) break;
  }

  return current;
}

export function ensureCableSeparation(
  nodes: Node[],
  edges: Edge[],
  minCableGap = 24,
  maxPasses = 8,
): Node[] {
  let current = nodes;

  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    const posById = new Map(current.map((n) => [n.id, { ...n.position }]));
    const heightById = new Map(current.map((n) => [n.id, n.height ?? DEFAULT_H]));
    const indexById = new Map(current.map((n, i) => [n.id, i]));

    const cy = (id: string) => {
      const p = posById.get(id);
      const h = heightById.get(id) ?? DEFAULT_H;
      return p ? p.y + h / 2 : 0;
    };

    const outgoing = new Map<string, string[]>();
    const incoming = new Map<string, string[]>();
    for (const e of edges) {
      if (!posById.has(e.source) || !posById.has(e.target)) continue;
      if (!outgoing.has(e.source)) outgoing.set(e.source, []);
      outgoing.get(e.source)!.push(e.target);
      if (!incoming.has(e.target)) incoming.set(e.target, []);
      incoming.get(e.target)!.push(e.source);
    }

    const nudge = (id: string, dy: number) => {
      const p = posById.get(id);
      if (!p) return;
      posById.set(id, { x: p.x, y: p.y + dy });
      changed = true;
    };

    const spread = (peerIds: string[]) => {
      if (peerIds.length < 2) return;
      const sorted = [...peerIds].sort((a, b) => cy(a) - cy(b));
      for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i];
        const b = sorted[i + 1];
        const gap = cy(b) - cy(a);
        if (gap < minCableGap) {
          const half = (minCableGap - gap) / 2;
          nudge(a, -half);
          nudge(b, +half);
        }
      }
    };

    for (const [, peers] of outgoing) spread(peers);
    for (const [, peers] of incoming) spread(peers);

    if (!changed) break;

    current = current.map((n) => {
      const p = posById.get(n.id);
      if (!p || (p.x === n.position.x && p.y === n.position.y)) return n;
      return { ...n, position: p };
    });

    void indexById;
  }

  return current;
}

export function separateOverlappingNodes(
  nodes: Node[],
  minGap = 20,
  maxPush = 160,
  maxPasses = 4,
): Node[] {
  let current = nodes;

  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    const positions = current.map((n) => ({ ...n.position }));
    const widths    = current.map((n) => n.width  ?? DEFAULT_W);
    const heights   = current.map((n) => n.height ?? DEFAULT_H);

    for (let i = 0; i < current.length; i++) {
      for (let j = i + 1; j < current.length; j++) {
        const pi = positions[i]; const pj = positions[j];
        const wi = widths[i];   const hi = heights[i];
        const wj = widths[j];   const hj = heights[j];

        const pushX = Math.min(pi.x + wi, pj.x + wj) - Math.max(pi.x, pj.x) + minGap;
        const pushY = Math.min(pi.y + hi, pj.y + hj) - Math.max(pi.y, pj.y) + minGap;

        if (pushX <= 0 || pushY <= 0) continue;

        const half = Math.min(
          pushY <= pushX ? pushY : pushX,
          maxPush,
        ) / 2;

        if (pushY <= pushX) {
          if (pi.y + hi / 2 < pj.y + hj / 2) {
            positions[i].y -= half;
            positions[j].y += half;
          } else {
            positions[i].y += half;
            positions[j].y -= half;
          }
        } else {
          if (pi.x + wi / 2 < pj.x + wj / 2) {
            positions[i].x -= half;
            positions[j].x += half;
          } else {
            positions[i].x += half;
            positions[j].x -= half;
          }
        }
        changed = true;
      }
    }

    if (!changed) break;
    current = current.map((n, idx) => {
      const p = positions[idx];
      if (p.x === n.position.x && p.y === n.position.y) return n;
      return { ...n, position: p };
    });
  }

  return current;
}

export function enforceNodeNodeGap(
  nodes: Node[],
  minGap = 28,
  xTolerance = 40,
  maxPasses = 6,
): Node[] {
  let current = nodes;

  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    const positions = current.map((n) => ({ ...n.position }));
    const heights   = current.map((n) => n.height ?? DEFAULT_H);

    for (let i = 0; i < current.length; i++) {
      for (let j = i + 1; j < current.length; j++) {
        const ai = positions[i];
        const aj = positions[j];
        if (Math.abs(ai.x - aj.x) > xTolerance) continue;

        const top = ai.y < aj.y ? i : j;
        const bot = top === i ? j : i;
        const tBottom = positions[top].y + heights[top];
        const bTop    = positions[bot].y;
        const overlap = (tBottom + minGap) - bTop;
        if (overlap > 0) {
          const half = overlap / 2;
          positions[top].y -= half;
          positions[bot].y += half;
          changed = true;
        }
      }
    }

    if (!changed) break;
    current = current.map((n, idx) => {
      const p = positions[idx];
      if (p.x === n.position.x && p.y === n.position.y) return n;
      return { ...n, position: p };
    });
  }

  return current;
}
