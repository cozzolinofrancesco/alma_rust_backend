'use client';

import { memo } from 'react';
import {
  BaseEdge,
  getBezierPath,
  getSmoothStepPath,
  Position,
  type EdgeProps,
} from 'reactflow';

export interface OffsetEdgeData {
  srcIdx?: number;
  srcCount?: number;
  tgtIdx?: number;
  tgtCount?: number;
  srcBundleOffset?: number;
  tgtBundleOffset?: number;
  smooth?: boolean;
}

const BASE_CURVATURE = 0.3;

const CURVATURE_STEP = 0.18;

const CURVATURE_MIN = 0.05;
const CURVATURE_MAX = 0.85;

function OffsetEdgeImpl({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps<OffsetEdgeData>) {
  const srcIdx   = data?.srcIdx   ?? 0;
  const srcCount = data?.srcCount ?? 1;
  const tgtIdx   = data?.tgtIdx   ?? 0;
  const tgtCount = data?.tgtCount ?? 1;
  const smooth   = data?.smooth   ?? false;

  const srcBundle = srcCount <= 1 ? (data?.srcBundleOffset ?? 0) : 0;
  const tgtBundle = tgtCount <= 1 ? (data?.tgtBundleOffset ?? 0) : 0;

  const isTB = sourcePosition === Position.Bottom || sourcePosition === Position.Top;

  let edgePath: string;

  if (smooth) {
    const srcDelta = srcCount > 1 ? (srcIdx - (srcCount - 1) / 2) * CURVATURE_STEP : 0;
    const tgtDelta = tgtCount > 1 ? (tgtIdx - (tgtCount - 1) / 2) * CURVATURE_STEP : 0;
    const curvature = Math.max(
      CURVATURE_MIN,
      Math.min(CURVATURE_MAX, BASE_CURVATURE + srcDelta + tgtDelta),
    );
    if (isTB) {
      [edgePath] = getBezierPath({
        sourceX: sourceX + srcBundle, sourceY, sourcePosition,
        targetX: targetX + tgtBundle, targetY, targetPosition,
        curvature,
      });
    } else {
      [edgePath] = getBezierPath({
        sourceX, sourceY: sourceY + srcBundle, sourcePosition,
        targetX, targetY: targetY + tgtBundle, targetPosition,
        curvature,
      });
    }
  } else if (isTB) {
    const LANE_STEP       = 20;
    const PIVOT_STEP      = 14;
    const STRAIGHTEN_SNAP = 10;

    const srcLaneOffset = srcCount > 1 ? (srcIdx - (srcCount - 1) / 2) * LANE_STEP : 0;
    const tgtLaneOffset = tgtCount > 1 ? (tgtIdx - (tgtCount - 1) / 2) * LANE_STEP : 0;
    const midShift =
      srcCount > 1 ? (srcIdx - (srcCount - 1) / 2) * PIVOT_STEP :
      tgtCount > 1 ? (tgtIdx - (tgtCount - 1) / 2) * PIVOT_STEP : 0;
    const centerY = (sourceY + targetY) / 2 + midShift;

    const effectiveSrcX = sourceX + srcLaneOffset + srcBundle;
    const effectiveTgtX = targetX + tgtLaneOffset + tgtBundle;

    if (Math.abs(effectiveSrcX - effectiveTgtX) <= STRAIGHTEN_SNAP) {
      const midX = (effectiveSrcX + effectiveTgtX) / 2;
      edgePath = `M ${midX},${sourceY} L ${midX},${targetY}`;
    } else {
      [edgePath] = getSmoothStepPath({
        sourceX: effectiveSrcX,
        sourceY,
        sourcePosition,
        targetX: effectiveTgtX,
        targetY,
        targetPosition,
        borderRadius: 6,
        centerY,
      });
    }
  } else {
    const LANE_STEP       = 20;
    const PIVOT_STEP      = 14;
    const STRAIGHTEN_SNAP = 10;

    const srcLaneOffset = srcCount > 1 ? (srcIdx - (srcCount - 1) / 2) * LANE_STEP : 0;
    const tgtLaneOffset = tgtCount > 1 ? (tgtIdx - (tgtCount - 1) / 2) * LANE_STEP : 0;
    const midShift =
      srcCount > 1 ? (srcIdx - (srcCount - 1) / 2) * PIVOT_STEP :
      tgtCount > 1 ? (tgtIdx - (tgtCount - 1) / 2) * PIVOT_STEP : 0;
    const centerX = (sourceX + targetX) / 2 + midShift;

    const effectiveSrcY = sourceY + srcLaneOffset + srcBundle;
    const effectiveTgtY = targetY + tgtLaneOffset + tgtBundle;

    if (Math.abs(effectiveSrcY - effectiveTgtY) <= STRAIGHTEN_SNAP) {
      const midY = (effectiveSrcY + effectiveTgtY) / 2;
      edgePath = `M ${sourceX},${midY} L ${targetX},${midY}`;
    } else {
      [edgePath] = getSmoothStepPath({
        sourceX,
        sourceY: effectiveSrcY,
        sourcePosition,
        targetX,
        targetY: effectiveTgtY,
        targetPosition,
        borderRadius: 6,
        centerX,
      });
    }
  }

  return <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd} />;
}

export default memo(OffsetEdgeImpl);
