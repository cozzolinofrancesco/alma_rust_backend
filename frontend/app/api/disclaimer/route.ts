import { NextRequest, NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { google } from 'googleapis';
import { appendLifecycleRow } from '@/app/lib/sheets/appendLifecycleRow';
import { CURRENT_DISCLAIMER_VERSION } from '@/app/lib/disclaimerUtils';

// Per-user, durable record of disclaimer acceptance. Stored as a hidden JSON
// file in the signed-in user's own Google Drive root, mirroring the training /
// onboarding convention. The disclaimer still *shows* via a browser cookie
// (app/lib/disclaimerUtils.ts); this route only records the acceptance for audit
// and stamps the accepted version.

const DISCLAIMER_FILE_NAME = '__alma_disclaimer__.json';

interface DisclaimerRecord {
  acceptedVersions: string[];
  lastAcceptedVersion: string | null;
  lastAcceptedAt: string | null;
  history: { version: string; acceptedAt: string }[];
}

function driveFromSession(accessToken: string) {
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return google.drive({ version: 'v3', auth: oauth2Client });
}

function oauthFromSession(accessToken: string) {
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return oauth2Client;
}

async function findFileId(
  drive: ReturnType<typeof driveFromSession>,
): Promise<string | null> {
  const search = await drive.files.list({
    q: `name='${DISCLAIMER_FILE_NAME}' and 'root' in parents and trashed=false`,
    fields: 'files(id, name)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return search.data.files?.[0]?.id ?? null;
}

async function readRecord(
  drive: ReturnType<typeof driveFromSession>,
  fileId: string | null,
): Promise<DisclaimerRecord> {
  if (fileId) {
    try {
      const res = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true });
      const data = typeof res.data === 'string' ? JSON.parse(res.data) : (res.data as Record<string, unknown>);
      return {
        acceptedVersions: Array.isArray(data.acceptedVersions) ? (data.acceptedVersions as string[]) : [],
        lastAcceptedVersion: (data.lastAcceptedVersion as string) || null,
        lastAcceptedAt: (data.lastAcceptedAt as string) || null,
        history: Array.isArray(data.history) ? (data.history as DisclaimerRecord['history']) : [],
      };
    } catch (err) {
      console.warn('Failed to parse __alma_disclaimer__.json, starting fresh:', err);
    }
  }
  return { acceptedVersions: [], lastAcceptedVersion: null, lastAcceptedAt: null, history: [] };
}

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession(request);
    if (!session?.accessToken || !session.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userEmail = session.user.email;
    const body = await request.json().catch(() => ({}));
    const version = (body.version as string) || CURRENT_DISCLAIMER_VERSION;

    const drive = driveFromSession(session.accessToken);
    const existingFileId = await findFileId(drive);
    const record = await readRecord(drive, existingFileId);

    const nowIso = new Date().toISOString();
    const updated: DisclaimerRecord = {
      acceptedVersions: Array.from(new Set([...record.acceptedVersions, version])),
      lastAcceptedVersion: version,
      lastAcceptedAt: nowIso,
      history: [...record.history, { version, acceptedAt: nowIso }],
    };

    const fileContent = JSON.stringify(updated, null, 2);
    if (existingFileId) {
      await drive.files.update({
        fileId: existingFileId,
        media: { mimeType: 'application/json', body: fileContent },
        supportsAllDrives: true,
      });
    } else {
      await drive.files.create({
        requestBody: { name: DISCLAIMER_FILE_NAME, mimeType: 'application/json', parents: ['root'] },
        media: { mimeType: 'application/json', body: fileContent },
        fields: 'id',
        supportsAllDrives: true,
      });
    }

    const warnings: string[] = [];
    try {
      await appendLifecycleRow(oauthFromSession(session.accessToken), {
        tab: 'Disclaimer',
        email: userEmail,
        version,
        status: 'Accepted',
      });
    } catch (sheetErr) {
      console.warn('Failed to append disclaimer row to GSheet:', sheetErr);
      warnings.push('gsheet-append-failed');
    }

    return NextResponse.json({
      success: true,
      acceptedVersion: version,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  } catch (error) {
    console.error('Disclaimer record error:', error);
    return NextResponse.json(
      { error: 'Failed to record disclaimer acceptance', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
