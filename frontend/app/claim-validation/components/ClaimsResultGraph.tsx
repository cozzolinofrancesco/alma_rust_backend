'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  buildResultsGraph,
  VERDICT_COLORS,
  VERDICT_LABELS,
  EVIDENCE_COLOR,
  SOURCE_COLOR,
  type ResultGraphNode,
} from '../lib/resultsGraphModel';
import type { ValidationResult } from '../types';

// Canvas/DOM-bound — never SSR (matches EntityForceGraph).
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

interface Props {
  results: ValidationResult[];
}

// Force-graph augments each node with simulation coordinates at runtime.
type GraphNode = ResultGraphNode & { x?: number; y?: number };
type GraphLink = { source: string; target: string; weight: number };

function truncate(s: string, max = 28): string {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

const KIND_LABEL: Record<ResultGraphNode['kind'], string> = {
  claim: 'Claim',
  evidence: 'Evidence',
  source: 'Source',
};

export default function ClaimsResultGraph({ results }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [selected, setSelected] = useState<ResultGraphNode | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const data = useMemo(() => buildResultsGraph(results), [results]);

  useEffect(() => {
    setSelected(null);
  }, [data]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      const fg = fgRef.current;
      if (!fg || typeof fg.d3Force !== 'function') return;
      fg.d3Force('charge')?.strength(-260);
      fg.d3Force('link')?.distance(70);
      fg.d3ReheatSimulation?.call(fg);
    }, 100);
    return () => clearTimeout(timer);
  }, [data]);

  const nodeLabel = (node: object) => {
    const n = node as GraphNode;
    return `${KIND_LABEL[n.kind]}: ${truncate(n.detail, 80)}`;
  };

  const usedVerdicts = useMemo(() => {
    const set = new Set<NonNullable<ResultGraphNode['verdict']>>();
    data.nodes.forEach((n) => {
      if (n.kind === 'claim' && n.verdict) set.add(n.verdict);
    });
    return Array.from(set);
  }, [data]);

  if (data.nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-500">
        No results to visualize yet.
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div
        style={{ position: 'absolute', top: 8, left: 8, zIndex: 5 }}
        className="rounded-md bg-white/90 border border-gray-200 p-2 text-xs shadow-sm space-y-1 max-w-[220px]"
      >
        <div className="font-semibold text-gray-700 mb-1">Legend</div>
        {usedVerdicts.map((v) => (
          <div key={v} className="flex items-center gap-2">
            <span
              style={{
                background: VERDICT_COLORS[v],
                width: 10,
                height: 10,
                borderRadius: 9999,
                display: 'inline-block',
              }}
            />
            <span className="text-gray-600">{VERDICT_LABELS[v]}</span>
          </div>
        ))}
        <div className="flex items-center gap-2 pt-1 border-t border-gray-100 mt-1">
          <span
            style={{
              background: EVIDENCE_COLOR,
              width: 10,
              height: 10,
              borderRadius: 9999,
              display: 'inline-block',
            }}
          />
          <span className="text-gray-600">Evidence</span>
        </div>
        <div className="flex items-center gap-2">
          <span
            style={{
              background: SOURCE_COLOR,
              width: 10,
              height: 10,
              borderRadius: 2,
              display: 'inline-block',
            }}
          />
          <span className="text-gray-600">Source</span>
        </div>
      </div>

      {selected && (
        <div
          style={{ position: 'absolute', top: 8, right: 8, zIndex: 5 }}
          className="rounded-md bg-white border border-gray-200 p-3 text-xs shadow-md max-w-[280px]"
        >
          <div className="flex items-center justify-between mb-1">
            <span className="font-semibold text-gray-700">{KIND_LABEL[selected.kind]}</span>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="text-gray-400 hover:text-gray-700"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          {selected.kind === 'claim' && selected.verdict && (
            <div className="mb-1">
              <span
                className="inline-block px-1.5 py-0.5 rounded text-white text-[10px]"
                style={{ background: VERDICT_COLORS[selected.verdict] }}
              >
                {VERDICT_LABELS[selected.verdict]}
              </span>
            </div>
          )}
          <p className="text-gray-600 whitespace-pre-wrap leading-relaxed">{selected.detail}</p>
        </div>
      )}

      {size.width > 0 && (
        <ForceGraph2D
          ref={fgRef}
          width={size.width}
          height={size.height}
          graphData={data}
          backgroundColor="rgba(0,0,0,0)"
          nodeLabel={nodeLabel}
          nodeVal={(node: object) => (node as GraphNode).weight}
          nodeColor={(node: object) => (node as GraphNode).color}
          nodeRelSize={4}
          linkColor={() => 'rgba(100,116,139,0.35)'}
          linkWidth={(link: object) => 0.5 + (link as GraphLink).weight * 2}
          onNodeClick={(node: object) => setSelected(node as GraphNode)}
          onNodeHover={(node: object | null) => setHoveredId(node ? (node as GraphNode).id : null)}
          onBackgroundClick={() => setSelected(null)}
          nodeCanvasObjectMode={() => 'after'}
          nodeCanvasObject={(node: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
            const n = node as GraphNode;
            if (typeof n.x !== 'number' || typeof n.y !== 'number') return;
            const isSelected = selected?.id === n.id;
            const isHovered = hoveredId === n.id;
            // claims always labelled; evidence/source on hover/select (avoids clutter)
            const showLabel = n.kind === 'claim' || isHovered || isSelected;
            if (isSelected) {
              const radius = Math.sqrt(Math.max(n.weight, 1)) * 4;
              ctx.beginPath();
              ctx.arc(n.x, n.y, radius + 2 / globalScale, 0, 2 * Math.PI, false);
              ctx.strokeStyle = 'rgba(255,215,0,0.9)';
              ctx.lineWidth = 3 / globalScale;
              ctx.stroke();
            }
            if (showLabel) {
              const radius = Math.sqrt(Math.max(n.weight, 1)) * 4;
              const fontSize = (n.kind === 'claim' ? 11 : 10) / globalScale;
              ctx.font = `${isHovered || isSelected ? 'bold ' : ''}${fontSize}px sans-serif`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'top';
              ctx.fillStyle = '#374151';
              ctx.fillText(truncate(n.label, 26), n.x, n.y + radius + 2 / globalScale);
            }
          }}
        />
      )}
    </div>
  );
}
