'use client';

import { memo } from 'react';
import { BaseEdge, getBezierPath, Position, type EdgeProps } from 'reactflow';

function CorpusEdgeImpl({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  markerEnd,
}: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition: Position.Bottom,
    targetX,
    targetY,
    targetPosition: Position.Top,
    curvature: 0.35,
  });

  const mergedStyle = {
    stroke: '#94a3b8',
    strokeWidth: 1.5,
    strokeDasharray: '7 5',
    ...style,
  };

  return <BaseEdge id={id} path={edgePath} style={mergedStyle} markerEnd={markerEnd} />;
}

export default memo(CorpusEdgeImpl);
