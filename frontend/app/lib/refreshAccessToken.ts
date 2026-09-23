import { JWT } from "next-auth/jwt";
import { SESSION_REFRESH_RETRY_MS } from './authSessionPolicy';

export interface Token extends JWT {
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpires?: number;
  error?: string;
  refreshRetryAt?: number;
  name?: string | null;
  email?: string | null;
  picture?: string | null;
}

type RefreshResult = Pick<Token, 'accessToken' | 'refreshToken' | 'accessTokenExpires' | 'error' | 'refreshRetryAt'>;

const inFlightRefreshes = new Map<string, Promise<RefreshResult>>();

function refreshFailure(error: string, status?: number): RefreshResult {
  console.warn('Google token refresh failed', { error, status });
  return {
    error,
    refreshRetryAt: error === 'RefreshAccessTokenTemporaryError' ? Date.now() + SESSION_REFRESH_RETRY_MS : undefined,
  };
}

async function exchangeRefreshToken(refreshToken: string, clientId: string, clientSecret: string): Promise<RefreshResult> {
  const controller = new AbortController();
  const configuredTimeout = Number(process.env.OAUTH_TIMEOUT ?? 10_000);
  const timeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.min(configuredTimeout, 30_000)
    : 10_000;
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: controller.signal,
      cache: 'no-store',
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    const refreshedTokens = await response.json();

    if (!response.ok) {
      const error = refreshedTokens?.error;
      if (response.status === 429 || response.status >= 500) {
        return refreshFailure('RefreshAccessTokenTemporaryError', response.status);
      }
      if (error === 'invalid_grant') {
        return refreshFailure('RefreshAccessTokenError', response.status);
      }
      return refreshFailure('RefreshAccessTokenConfigurationError', response.status);
    }

    if (
      typeof refreshedTokens?.access_token !== 'string' || !refreshedTokens.access_token ||
      typeof refreshedTokens.expires_in !== 'number' ||
      !Number.isFinite(refreshedTokens.expires_in) || refreshedTokens.expires_in <= 0
    ) {
      return refreshFailure('RefreshAccessTokenTemporaryError', response.status);
    }

    return {
      error: undefined,
      refreshRetryAt: undefined,
      accessToken: refreshedTokens.access_token,
      refreshToken: typeof refreshedTokens.refresh_token === 'string' && refreshedTokens.refresh_token
        ? refreshedTokens.refresh_token
        : refreshToken,
      accessTokenExpires: Date.now() + refreshedTokens.expires_in * 1000,
    };
  } catch {
    return refreshFailure('RefreshAccessTokenTemporaryError');
  } finally {
    clearTimeout(timeoutId);
  }
}

export const refreshAccessToken = async (token: Token): Promise<Token> => {
  if (!token.refreshToken) {
    return { ...token, error: 'RefreshAccessTokenError', refreshRetryAt: undefined };
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return { ...token, ...refreshFailure('RefreshAccessTokenConfigurationError') };
  }

  const key = `${clientId}:${token.refreshToken}`;
  let pending = inFlightRefreshes.get(key);
  if (!pending) {
    pending = exchangeRefreshToken(token.refreshToken, clientId, clientSecret)
      .finally(() => inFlightRefreshes.delete(key));
    inFlightRefreshes.set(key, pending);
  }

  return { ...token, ...await pending };
};
