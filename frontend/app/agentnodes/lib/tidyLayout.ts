
import dagre from 'dagre';
import type { Edge, Node, XYPosition } from 'reactflow';
import { enforceNodeNodeGap } from './nodeSpacing';

const CARD_CHROME_H = 72;

const LANE_STEP = 20;

const FAN_PAD = 60;

const BASE_DAGRE_H = 160;

const DEFAULT_NODE_W = 220;
const DEFAULT_NODE_H = 96;

const PROFILES = {
  compact: { rankSep: 90, nodeSep: 30, marginXY: 20 },
  relax:   { rankSep: 720, nodeSep: 480, marginXY: 240 },
} as const;

export type TidyMode = keyof typeof PROFILES;

export type TidyAxis = 'both' | 'h' | 'v';

const ASPECT_THRESHOLD = 1.5;
const MAX_LR_RANKS = 4;

function computeRanksTidy(nodeIds: string[], edges: Edge[]): Map<string, number> {
  const sourcesOf = new Map<string, string[]>();
  for (const e of edges) {
    if (!sourcesOf.has(e.target)) sourcesOf.set(e.target, []);
    sourcesOf.get(e.target)!.push(e.source);
  }
  const ranks = new Map<string, number>();
  const visiting = new Set<string>();
  function dfs(id: string): number {
    if (ranks.has(id)) return ranks.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const srcs = sourcesOf.get(id) ?? [];
    let max = -1;
    for (const s of srcs) { const r = dfs(s); if (r > max) max = r; }
    const rank = max < 0 ? 0 : max + 1;
    ranks.set(id, rank);
    visiting.delete(id);
    return rank;
  }
  for (const id of nodeIds) dfs(id);
  return ranks;
}

function pickRankdirTidy(ranks: Map<string, number>): 'LR' | 'TB' {
  const sizes = new Map<number, number>();
  for (const r of ranks.values()) sizes.set(r, (sizes.get(r) ?? 0) + 1);
  const numRanks = sizes.size;
  const maxPerRank = Math.max(...sizes.values(), 0);
  const lrH = maxPerRank * (BASE_DAGRE_H + LANE_STEP);
  const lrW = Math.max(numRanks, 1) * (DEFAULT_NODE_W + 90 );
  return lrH > lrW * ASPECT_THRESHOLD || numRanks > MAX_LR_RANKS ? 'TB' : 'LR';
}

function inferConsensusDirection(nodes: readonly Node[]): 'LR' | 'TB' | null {
  let tb = 0;
  let lr = 0;
  for (const n of nodes) {
    if (n.type !== 'c272Step' && n.type !== 'c272Section') continue;
    const d = (n.data as Record<string, unknown> | undefined)?.direction;
    if (d === 'TB') tb++;
    else if (d === 'LR') lr++;
  }
  if (tb === 0 && lr === 0) return null;
  if (lr === 0) return 'TB';
  if (tb === 0) return 'LR';
  return tb >= lr ? 'TB' : 'LR';
}

export function tidyLayout<T extends Node>(
  nodes: T[],
  edges: Edge[],
  mode: TidyMode = 'compact',
  axis: TidyAxis = 'both',
  forceDirection?: 'LR' | 'TB',
  preferFreshAutoDetect?: boolean,
): { nodes: T[]; direction: 'LR' | 'TB' } {
  if (nodes.length === 0) return { nodes, direction: forceDirection ?? 'LR' };

  const inDeg  = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const e of edges) {
    inDeg.set(e.target,  (inDeg.get(e.target)  ?? 0) + 1);
    outDeg.set(e.source, (outDeg.get(e.source) ?? 0) + 1);
  }

  const ranks = computeRanksTidy(nodes.map((n) => n.id), edges);
  const autoRankdir = pickRankdirTidy(ranks);
  const consensus = inferConsensusDirection(nodes);

  let rankdir: 'LR' | 'TB';
  if (forceDirection) {
    rankdir = forceDirection;
  } else if (axis !== 'both') {
    rankdir = consensus ?? autoRankdir;
  } else if (consensus && consensus !== autoRankdir && !preferFreshAutoDetect) {
    rankdir = consensus;
  } else {
    rankdir = autoRankdir;
  }

  const { rankSep, nodeSep, marginXY } = PROFILES[mode];

  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir,
    ranksep: rankSep,
    nodesep: nodeSep,
    ranker: mode === 'compact' ? 'tight-tree' : 'network-simplex',
    marginx: marginXY,
    marginy: marginXY,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) {
    let heightForDagre: number;
    if (mode === 'compact') {
      heightForDagre = n.height ?? DEFAULT_NODE_H;
    } else {
      const maxDeg = Math.max(inDeg.get(n.id) ?? 0, outDeg.get(n.id) ?? 0, 1);
      heightForDagre = Math.max(
        BASE_DAGRE_H,
        CARD_CHROME_H + (maxDeg - 1) * LANE_STEP + FAN_PAD,
      );
    }
    g.setNode(n.id, { width: n.width ?? DEFAULT_NODE_W, height: heightForDagre });
  }

  for (const e of edges) {
    if (g.hasNode(e.source) && g.hasNode(e.target)) {
      g.setEdge(e.source, e.target);
    }
  }

  dagre.layout(g);

  let result: T[] = nodes.map((n) => {
    const pos = g.node(n.id);
    const prevDir = (n.data as Record<string, unknown> | undefined)?.direction;
    const dirChanged = prevDir !== rankdir;
    if (!pos && !dirChanged) return n;
    const w = n.width  ?? DEFAULT_NODE_W;
    const h = n.height ?? DEFAULT_NODE_H;
    const newX = !pos ? n.position.x : (axis === 'v' ? n.position.x : pos.x - w / 2);
    const newY = !pos ? n.position.y : (axis === 'h' ? n.position.y : pos.y - h / 2);
    const posChanged = newX !== n.position.x || newY !== n.position.y;
    if (!posChanged && !dirChanged) return n;
    return {
      ...n,
      position: { x: newX, y: newY },
      data: { ...(n.data as object), direction: rankdir },
    };
  });

  if (axis !== 'h' && mode !== 'compact') {
    const MIN_NODE_GAP = 80;
    const MAX_OUTER = 4;
    for (let outer = 0; outer < MAX_OUTER; outer++) {
      const before = result;
      result = enforceNodeNodeGap(result, MIN_NODE_GAP, 40, 6) as T[];
      if (result === before) break;
    }
  }

  return { nodes: result, direction: rankdir };
}

function sampleCable(
  sx: number, sy: number,
  tx: number, ty: number,
  n = 16,
): XYPosition[] {
  const mx = (sx + tx) / 2;
  const pts: XYPosition[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push({
      x: u*u*u*sx + 3*u*u*t*mx + 3*u*t*t*mx + t*t*t*tx,
      y: u*u*u*sy + 3*u*u*t*sy + 3*u*t*t*ty + t*t*t*ty,
    });
  }
  return pts;
}

function segmentsIntersect(
  p1: XYPosition, p2: XYPosition,
  p3: XYPosition, p4: XYPosition,
): boolean {
  const d1x = p2.x - p1.x; const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x; const d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return false;
  const dx = p3.x - p1.x; const dy = p3.y - p1.y;
  const t = (dx * d2y - dy * d2x) / denom;
  const s = (dx * d1y - dy * d1x) / denom;
  return t > 0 && t < 1 && s > 0 && s < 1;
}

export function countEdgeCrossings(nodes: Node[], edges: Edge[]): number {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const polylines: XYPosition[][] = [];
  for (const e of edges) {
    const src = nodeById.get(e.source);
    const tgt = nodeById.get(e.target);
    if (!src || !tgt) continue;
    const sx = src.position.x + (src.width  ?? DEFAULT_NODE_W);
    const sy = src.position.y + (src.height ?? DEFAULT_NODE_H) / 2;
    const tx = tgt.position.x;
    const ty = tgt.position.y + (tgt.height ?? DEFAULT_NODE_H) / 2;
    polylines.push(sampleCable(sx, sy, tx, ty));
  }

  let crossings = 0;
  for (let i = 0; i < polylines.length; i++) {
    const a = polylines[i];
    for (let j = i + 1; j < polylines.length; j++) {
      const b = polylines[j];
      outer: for (let ai = 0; ai < a.length - 1; ai++) {
        for (let bi = 0; bi < b.length - 1; bi++) {
          if (segmentsIntersect(a[ai], a[ai + 1], b[bi], b[bi + 1])) {
            crossings++;
            break outer;
          }
        }
      }
    }
  }
  return crossings;
}

