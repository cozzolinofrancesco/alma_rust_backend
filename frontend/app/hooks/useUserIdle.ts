'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const ACTIVITY_EVENTS: (keyof WindowEventMap)[] = [
  'mousemove',
  'mousedown',
  'keydown',
  'scroll',
  'touchstart',
  'pointerdown',
  'wheel',
];

export function useUserIdle(idleMs: number): { isIdle: boolean } {
  const [isIdle, setIsIdle] = useState(false);
  const timerRef = useRef<number | null>(null);

  const scheduleIdle = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setIsIdle(false);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setIsIdle(true);
    }, idleMs);
  }, [idleMs]);

  useEffect(() => {
    scheduleIdle();

    const onActivity = () => {
      scheduleIdle();
    };

    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, onActivity, { passive: true });
    }
    return () => {
      for (const ev of ACTIVITY_EVENTS) {
        window.removeEventListener(ev, onActivity);
      }
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [scheduleIdle]);

  return { isIdle };
}
