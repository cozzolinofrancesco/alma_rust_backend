'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { usePathname } from 'next/navigation';
import { useNavigationLoading } from '../contexts/NavigationLoadingContext';
import { useAppBusy } from '../contexts/AppBusyContext';
import { useSplashState } from './SplashScreenWrapper';
import { useUserIdle } from '../hooks/useUserIdle';
import {
  markDailyHelpShownToday,
  wasDailyHelpShownToday,
  wasQuestionsContactIntroSeen,
} from '../lib/dailyHelpPrompt';
import QuestionsModal from './QuestionsModal';

const HOME_IDLE_MS = 15_000;
const DEFAULT_IDLE_MS = 45_000;

function isFocusedWorkSurface(pathname: string): boolean {
  return pathname.startsWith('/ai-agents/edit') || pathname.startsWith('/agentnodes');
}

export default function DailyHelpPromptController() {
  const { data: session, status } = useSession();
  const pathname = usePathname() ?? '';
  const { isNavigating } = useNavigationLoading();
  const { isBusy: appContextBusy } = useAppBusy();
  const { isInitialLoad } = useSplashState();

  const homeSplashOk = pathname !== '/' || !isInitialLoad;
  const idleMs = pathname === '/' ? HOME_IDLE_MS : DEFAULT_IDLE_MS;
  const { isIdle } = useUserIdle(idleMs);

  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const openedRef = useRef(false);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const handleClose = useCallback(() => {
    markDailyHelpShownToday();
    setOpen(false);
    openedRef.current = false;
  }, []);

  useEffect(() => {
    if (status !== 'authenticated' || !session) return;

    const tick = () => {
      if (openRef.current) return;
      if (openedRef.current) return;
      if (isFocusedWorkSurface(pathname)) return;
      if (wasDailyHelpShownToday()) return;
      if (!wasQuestionsContactIntroSeen()) return;
      if (!isIdle || !homeSplashOk) return;
      if (isNavigating) return;
      if (appContextBusy) return;

      try {
        if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
        if (document.querySelector('.agent-loading-overlay, .edit-agent-loading-overlay')) return;
      } catch {
        return;
      }

      openedRef.current = true;
      setOpen(true);
    };

    const id = window.setInterval(tick, 500);
    tick();
    return () => window.clearInterval(id);
  }, [status, session, isIdle, homeSplashOk, isNavigating, appContextBusy, pathname]);

  return (
    <QuestionsModal isOpen={open} onClose={handleClose} variant="dailyHelp" />
  );
}
