
import { google } from 'googleapis';
import type { OAuth2Client } from 'googleapis-common';

export function createRefreshableAuth(
  accessToken: string,
  refreshToken?: string | null
): OAuth2Client {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    process.env.GOOGLE_REDIRECT_URI
  );

  auth.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken || undefined,
  });

  auth.on('tokens', (tokens) => {
    if (tokens.access_token) {
      console.log('🔄 [Auth] Access token refreshed automatically');
    }
  });

  return auth;
}

export async function ensureFreshToken(auth: OAuth2Client): Promise<void> {
  try {
    const { token } = await auth.getAccessToken();
    if (token) {
      console.log('✅ [Auth] Token is valid');
    }
  } catch (error) {
    console.error('❌ [Auth] Failed to refresh token:', error);
    throw new Error('Token refresh failed. Please re-authenticate.');
  }
}

export function hasRefreshToken(auth: OAuth2Client): boolean {
  const credentials = auth.credentials;
  return !!credentials.refresh_token;
}

