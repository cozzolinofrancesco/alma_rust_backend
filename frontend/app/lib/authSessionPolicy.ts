export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
export const SESSION_REFRESH_RETRY_MS = 30 * 1000;

export function isTerminalRefreshError(error?: string): boolean {
  return error === 'RefreshAccessTokenError' || error === 'RefreshAccessTokenConfigurationError';
}