'use client';

import type { Session } from 'next-auth';
import { signIn } from 'next-auth/react';
import { isTerminalRefreshError } from './authSessionPolicy';

export class SessionRequestError extends Error {
  constructor() {
    super('The session could not be checked. Please retry when connected.');
    this.name = 'SessionRequestError';
  }
}

export class SessionRefreshCancelledError extends Error {
  constructor() {
    super('The signed-in account changed during session refresh.');
    this.name = 'SessionRefreshCancelledError';
  }
}

export async function readBrowserSession(): Promise<Session | null> {
  if (!navigator.onLine) throw new SessionRequestError();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 35_000);

  try {
    const response = await fetch('/api/auth/session', {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new SessionRequestError();
    const session = await response.json();
    if (session === null) return null;
    if (typeof session !== 'object' || Array.isArray(session)) throw new SessionRequestError();
    if (Object.keys(session).length === 0) return null;
    if (typeof session.expires !== 'string' || !Number.isFinite(Date.parse(session.expires))) {
      throw new SessionRequestError();
    }
    if (typeof session.user?.email !== 'string' || !session.user.email) return null;
    return session as Session;
  } catch {
    throw new SessionRequestError();
  } finally {
    clearTimeout(timeoutId);
  }
}

export function createSessionRefresher(
  load: (force: boolean) => Promise<Session | null>,
  currentAccessToken: () => string | undefined,
): (force?: boolean) => Promise<Session | null> {
  let pending: { promise: Promise<Session | null>; forced: boolean } | null = null;

  function refresh(force = false): Promise<Session | null> {
    if (pending) {
      if (force && !pending.forced) {
        const previousToken = currentAccessToken();
        return pending.promise.then(session => {
          if (session && previousToken && session.accessToken === previousToken && !isTerminalRefreshError(session.error)) {
            return refresh(true);
          }
          return session;
        });
      }
      return pending.promise;
    }

    const promise = Promise.resolve().then(() => load(force)).finally(() => {
      if (pending?.promise === promise) pending = null;
    });
    pending = { promise, forced: force };
    return promise;
  }

  return refresh;
}

let signingIn = false;

export async function signInToGoogle(): Promise<void> {
  if (signingIn) return;
  signingIn = true;
  try {
    await signIn('google', {
      callbackUrl: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    });
  } catch (error) {
    signingIn = false;
    throw error;
  }
}

export function reloadBrowserSession(): void {
  window.location.reload();
}