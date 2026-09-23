export function googleAuthFailure(error: unknown) {
  if (!error || typeof error !== 'object') return null;
  const failure = error as { code?: unknown; status?: unknown; response?: { status?: unknown }; error?: unknown };
  if (Number(failure.response?.status ?? failure.status ?? failure.code) !== 401 && failure.error !== 'invalid_grant') return null;
  return {
    code: 'GOOGLE_AUTH_EXPIRED',
    error: 'Google authorization expired or was revoked. Renew the caller token and review completed work before explicitly retrying.',
    retryable: false,
  } as const;
}