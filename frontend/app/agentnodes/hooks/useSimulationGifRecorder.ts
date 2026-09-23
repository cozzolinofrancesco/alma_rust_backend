'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { encodeSimulationGif } from '../lib/encodeSimulationGif';

const CAPTURE_DELAY_MS = 250;

export interface SimulationGifRecorderState {
  isRecordingEnabled: boolean;
  setIsRecordingEnabled: (enabled: boolean) => void;
  isEncoding: boolean;
  encodingProgress: number;
}

export function useSimulationGifRecorder({
  isSimulating,
  runningLayerIds,
  stepDurationMs,
  agentName,
  captureFrame,
}: {
  isSimulating: boolean;
  runningLayerIds: ReadonlySet<string>;
  stepDurationMs: number;
  agentName: string;
  captureFrame: () => Promise<string | null>;
}): SimulationGifRecorderState {
  const [isRecordingEnabled, setIsRecordingEnabled] = useState(false);
  const [isEncoding, setIsEncoding] = useState(false);
  const [encodingProgress, setEncodingProgress] = useState(0);

  const framesRef = useRef<string[]>([]);
  const captureFrameRef = useRef(captureFrame);
  captureFrameRef.current = captureFrame;

  useEffect(() => {
    if (!isRecordingEnabled || !isSimulating || !runningLayerIds.size) return;

    const id = window.setTimeout(async () => {
      const frame = await captureFrameRef.current();
      if (frame) framesRef.current.push(frame);
    }, CAPTURE_DELAY_MS);

    return () => window.clearTimeout(id);
  }, [runningLayerIds, isSimulating, isRecordingEnabled]);

  const prevIsSimulatingRef = useRef(false);
  useEffect(() => {
    const wasSimulating = prevIsSimulatingRef.current;
    prevIsSimulatingRef.current = isSimulating;

    if (!wasSimulating || isSimulating) return;

    setIsRecordingEnabled(false);

    if (!isRecordingEnabled || !framesRef.current.length) return;

    const frames = framesRef.current.splice(0);
    setIsEncoding(true);
    setEncodingProgress(0);

    encodeSimulationGif(frames, stepDurationMs, agentName, (p) => {
      setEncodingProgress(p);
    }).finally(() => {
      setIsEncoding(false);
    });
  }, [isSimulating, isRecordingEnabled, stepDurationMs, agentName]);

  const setEnabled = useCallback((enabled: boolean) => {
    if (!enabled) framesRef.current = [];
    setIsRecordingEnabled(enabled);
  }, []);

  return { isRecordingEnabled, setIsRecordingEnabled: setEnabled, isEncoding, encodingProgress };
}
