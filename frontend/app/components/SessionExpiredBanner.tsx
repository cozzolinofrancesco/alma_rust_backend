'use client';

import { useSession } from 'next-auth/react';
import { useState, useCallback, useEffect } from 'react';
import { LogIn, RotateCw } from 'lucide-react';
import { useAppContext } from './RootProvider';
import { signInToGoogle } from '../lib/clientSession';

export default function SessionExpiredBanner() {
    const { data: session } = useSession();
    const { refreshSession, sessionRefreshError } = useAppContext();
    const [isRetrying, setIsRetrying] = useState(false);
    const [retryFailed, setRetryFailed] = useState(false);

    useEffect(() => {
        if (!session?.error && !sessionRefreshError) setRetryFailed(false);
    }, [session?.error, sessionRefreshError]);

    const handleRetry = useCallback(async () => {
        setIsRetrying(true);
        setRetryFailed(false);
        try {
            const refreshed = await refreshSession(true);
            if (!refreshed) await signInToGoogle();
        } catch {
            setRetryFailed(true);
        } finally {
            setIsRetrying(false);
        }
    }, [refreshSession]);

    const handleSignInAgain = useCallback(async () => {
        setIsRetrying(true);
        try {
            await signInToGoogle();
        } catch {
            setRetryFailed(true);
        } finally {
            setIsRetrying(false);
        }
    }, []);

    if (!session || (!session.error && !sessionRefreshError && !retryFailed)) {
        return null;
    }

    const needsSignIn = session.error === 'RefreshAccessTokenError';
    const message = needsSignIn
        ? 'Google access needs to be authorized again.'
        : session.error === 'RefreshAccessTokenConfigurationError'
            ? 'Google sign-in is temporarily unavailable.'
            : 'Connection interrupted.';

    return (
        <div
            className="sticky top-0 z-50 w-full p-3 bg-red-600 text-white text-sm flex flex-wrap items-center justify-between gap-2"
            role="alert"
        >
            <span>{message}</span>
            <div className="flex flex-wrap gap-2">
                <button
                    type="button"
                    onClick={handleRetry}
                    disabled={isRetrying}
                    className="inline-flex items-center gap-2 px-3 py-1.5 bg-red-700 hover:bg-red-800 disabled:opacity-50 rounded text-xs font-medium transition-colors"
                    title="Retry connection"
                >
                    <RotateCw size={14} aria-hidden="true" className={isRetrying ? 'animate-spin' : undefined} />
                    {isRetrying ? 'Retrying...' : 'Retry'}
                </button>
                {needsSignIn && (
                    <button
                        type="button"
                        onClick={handleSignInAgain}
                        disabled={isRetrying}
                        className="inline-flex items-center gap-2 px-3 py-1.5 bg-white text-red-700 hover:bg-gray-100 disabled:opacity-50 rounded text-xs font-medium transition-colors"
                    >
                        <LogIn size={14} aria-hidden="true" />
                        Sign in again
                    </button>
                )}
            </div>
        </div>
    );
}
