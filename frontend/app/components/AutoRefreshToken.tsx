'use client';

import { useEffect, useRef } from 'react';
import { useSession } from 'next-auth/react';
import type { Session } from 'next-auth';
import { useAppContext } from './RootProvider';
import { ACCESS_TOKEN_REFRESH_MARGIN_MS, SESSION_REFRESH_RETRY_MS, isTerminalRefreshError } from '../lib/authSessionPolicy';
import { SessionRefreshCancelledError, signInToGoogle } from '../lib/clientSession';

const AutoRefreshToken: React.FC = () => {
  const { data: session } = useSession();
  const { setToken, refreshSession } = useAppContext();
  const attempts = useRef(0);
  const previousIdentity = useRef(session?.user?.email);

  useEffect(() => {
    if (!session) return;
    let current: Session = session;
    let disposed = false;
    let refreshing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (previousIdentity.current !== session.user?.email || (!session.error && (session.accessTokenExpires ?? 0) > Date.now() + ACCESS_TOKEN_REFRESH_MARGIN_MS)) {
      attempts.current = 0;
    }
    previousIdentity.current = session.user?.email;
    if (session.accessToken) setToken(session.accessToken);

    function schedule(next: Session, retry = false) {
      clearTimeout(timer);
      if (disposed || isTerminalRefreshError(next.error) || attempts.current >= 4) return;
      const delay = retry || next.error
        ? Math.max(SESSION_REFRESH_RETRY_MS * 2 ** Math.max(0, attempts.current - 1), (next.refreshRetryAt ?? 0) - Date.now())
        : Math.max(0, (next.accessTokenExpires ?? Date.now()) - Date.now() - ACCESS_TOKEN_REFRESH_MARGIN_MS);
      timer = setTimeout(() => { void refresh(); }, delay);
    }

    async function refresh() {
      if (disposed || refreshing || !navigator.onLine || isTerminalRefreshError(current.error)) return;
      clearTimeout(timer);
      refreshing = true;
      attempts.current += 1;
      try {
        const refreshed = await refreshSession();
        if (disposed) return;
        if (!refreshed) {
          await signInToGoogle();
          return;
        }
        current = refreshed;
        if (refreshed.accessToken) setToken(refreshed.accessToken);
        if (!refreshed.error) attempts.current = 0;
        schedule(refreshed, !!refreshed.error);
      } catch (failure) {
        if (!disposed && !(failure instanceof SessionRefreshCancelledError)) schedule(current, true);
      } finally {
        refreshing = false;
      }
    }

    function resume() {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      attempts.current = 0;
      void refresh();
    }

    schedule(current, attempts.current > 0);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);

    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
    };
  }, [session, refreshSession, setToken]);

  return null;
};

export default AutoRefreshToken;
