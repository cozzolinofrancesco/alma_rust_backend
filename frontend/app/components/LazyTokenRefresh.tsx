'use client';

import { useEffect, useCallback } from 'react';
import { useAppContext } from './RootProvider';
import { ACCESS_TOKEN_REFRESH_MARGIN_MS, isTerminalRefreshError } from '../lib/authSessionPolicy';

const LazyTokenRefresh: React.FC = () => {
  const { getCurrentSession, refreshSession } = useAppContext();

  const refreshTokenIfNeeded = useCallback(async (): Promise<string | null> => {
    const session = getCurrentSession();
    if (isTerminalRefreshError(session?.error)) return null;
    if (session?.accessToken && Date.now() < (session.accessTokenExpires ?? 0) - ACCESS_TOKEN_REFRESH_MARGIN_MS) {
      return session.accessToken;
    }

    try {
      const refreshed = await refreshSession();
      return !refreshed?.error && Date.now() < (refreshed?.accessTokenExpires ?? 0)
        ? refreshed?.accessToken ?? null
        : null;
    } catch {
      return null;
    }
  }, [getCurrentSession, refreshSession]);

  useEffect(() => {
    const globalWindow = window as typeof window & { refreshTokenIfNeeded?: () => Promise<string | null> };
    globalWindow.refreshTokenIfNeeded = refreshTokenIfNeeded;

    return () => {
      if (globalWindow.refreshTokenIfNeeded === refreshTokenIfNeeded) delete globalWindow.refreshTokenIfNeeded;
    };
  }, [refreshTokenIfNeeded]);

  return null;
};

export default LazyTokenRefresh; 