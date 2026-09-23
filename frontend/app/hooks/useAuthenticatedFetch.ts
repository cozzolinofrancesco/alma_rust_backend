'use client';

import { useCallback } from 'react';
import { useAppContext } from '../components/RootProvider';
import { ACCESS_TOKEN_REFRESH_MARGIN_MS, isTerminalRefreshError } from '../lib/authSessionPolicy';
import { SessionRefreshCancelledError, SessionRequestError, signInToGoogle } from '../lib/clientSession';

interface FetchOptions extends RequestInit {
  skipAuth?: boolean;
}

export const useAuthenticatedFetch = () => {
  const { getCurrentSession, refreshSession } = useAppContext();

  const authenticatedFetch = useCallback(async (
    url: string, 
    options: FetchOptions = {}
  ): Promise<Response> => {
    const { skipAuth, ...fetchOptions } = options;

    if (skipAuth) {
      return fetch(url, fetchOptions);
    }

    let session = getCurrentSession();
    let refreshedBeforeRequest = false;
    const mayRefresh = !isTerminalRefreshError(session?.error) && Date.now() >= (session?.refreshRetryAt ?? 0);
    const needsRefresh = !session?.accessToken || Date.now() >= (session.accessTokenExpires ?? 0) - ACCESS_TOKEN_REFRESH_MARGIN_MS;

    if (needsRefresh && mayRefresh) {
      refreshedBeforeRequest = true;
      try {
        session = await refreshSession();
        if (!session) {
          await signInToGoogle();
          throw new SessionRequestError();
        }
      } catch (failure) {
        if (failure instanceof SessionRefreshCancelledError || !session?.accessToken || Date.now() >= (session.accessTokenExpires ?? 0)) throw failure;
      }
    }

    if (isTerminalRefreshError(session?.error)) throw new Error('Google authorization is unavailable.');
    if (!session?.accessToken || Date.now() >= (session.accessTokenExpires ?? 0)) throw new SessionRequestError();

    const request = (accessToken: string) => {
      const headers = new Headers(fetchOptions.headers);
      headers.set('Authorization', `Bearer ${accessToken}`);
      return fetch(url, { ...fetchOptions, headers });
    };

    const response = await request(session.accessToken);
    const streamingBody = typeof ReadableStream !== 'undefined' && fetchOptions.body instanceof ReadableStream;
    if (response.status === 401 && !refreshedBeforeRequest && mayRefresh && !streamingBody && !fetchOptions.signal?.aborted) {
      try {
        const refreshed = await refreshSession(true);
        if (!refreshed) {
          await signInToGoogle();
        } else if (!refreshed.error && refreshed.accessToken && Date.now() < (refreshed.accessTokenExpires ?? 0)) {
          return request(refreshed.accessToken);
        }
      } catch {
        return response;
      }
    }

    return response;
  }, [getCurrentSession, refreshSession]);

  return authenticatedFetch;
};

export const createAuthenticatedFetch = (
  token: string | null,
  refreshToken: string | null,
  onTokenUpdate?: (newToken: string) => void
) => {
  return async (url: string, options: FetchOptions = {}): Promise<Response> => {
    const { skipAuth, ...fetchOptions } = options;

    if (skipAuth) {
      return fetch(url, fetchOptions);
    }

    let currentToken = token;

    const authHeaders: Record<string, string> = currentToken ? {
      'Authorization': `Bearer ${currentToken}`,
    } : {};

    const response = await fetch(url, {
      ...fetchOptions,
      headers: {
        ...authHeaders,
        ...(fetchOptions.headers as Record<string, string> || {}),
      },
    });

    if (response.status === 401 && refreshToken) {
      try {
        const refreshResponse = await fetch('/api/auth/refresh-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });

        if (refreshResponse.ok) {
          const refreshData = await refreshResponse.json();
          currentToken = refreshData.accessToken;
          
          if (currentToken) {
            if (onTokenUpdate) {
              onTokenUpdate(currentToken);
            }
            
            return fetch(url, {
              ...fetchOptions,
              headers: {
                'Authorization': `Bearer ${currentToken}`,
                ...(fetchOptions.headers as Record<string, string> || {}),
              },
            });
          } else {
            console.error('❌ No access token in createAuthenticatedFetch refresh response');
          }
        }
      } catch (error) {
        console.error('❌ Error in authenticated fetch retry:', error);
      }
    }

    return response;
  };
}; 