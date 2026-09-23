import type { NextRequest } from 'next/server';
import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import { getApiSession } from '../apiCaller.server';

export type AgentnodesDriveContext = {
  drive: drive_v3.Drive;
  /** Email of the authenticated caller, when available (used for corpus-link attribution). */
  email: string;
  /** OAuth tokens for the caller — used to read the caller's RAG registry (corpus names). */
  accessToken: string;
  refreshToken: string;
};

export async function getAgentnodesDrive(
  request: NextRequest
): Promise<AgentnodesDriveContext | null> {
  const session = await getApiSession(request);
  const accessToken = typeof session?.accessToken === 'string' ? session.accessToken : '';
  const refreshToken = typeof session?.refreshToken === 'string' ? session.refreshToken : '';
  const email = typeof session?.user?.email === 'string' ? session.user.email : '';

  if (!accessToken) return null;

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oauth2Client.setCredentials({
    access_token: accessToken,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  });

  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  return { drive, email, accessToken, refreshToken };
}
