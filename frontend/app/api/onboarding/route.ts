import { NextRequest, NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { google } from 'googleapis';
import { appendLifecycleRow } from '@/app/lib/sheets/appendLifecycleRow';
import { CURRENT_ONBOARDING_VERSION } from '@/app/lib/onboardingStatus';

// Per-user, durable onboarding-tour record. Stored as a single hidden config
// file in the signed-in user's own Google Drive root, mirroring the training
// convention. Version-gated so a bumped tour re-shows once; each completion or
// skip is also appended to the central GSheet "Onboarding" tab for audit.

const ONBOARDING_FILE_NAME = '__alma_onboarding__.json';

interface OnboardingRecord {
  completedVersions: string[];
  lastVersion: string | null;
  lastAt: string | null;
  history: { version: string; at: string; status: 'completed' | 'skipped' }[];
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

async function findFlagFileId(
  drive: ReturnType<typeof driveFromSession>,
): Promise<string | null> {
  const search = await drive.files.list({
    q: `name='${ONBOARDING_FILE_NAME}' and 'root' in parents and trashed=false`,
    fields: 'files(id, name)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return search.data.files?.[0]?.id ?? null;
}

// Reads the versioned record. Legacy files written as { completed: true } (no
// completedVersions) are migrated to completedVersions: ['1.0'] so existing
// users are not re-shown the v1.0 tour.
async function readRecord(
  drive: ReturnType<typeof driveFromSession>,
  fileId: string | null,
): Promise<OnboardingRecord> {
  if (fileId) {
    try {
      const res = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true });
      const data = typeof res.data === 'string' ? JSON.parse(res.data) : (res.data as Record<string, unknown>);
      if (Array.isArray(data.completedVersions)) {
        return {
          completedVersions: data.completedVersions as string[],
          lastVersion: (data.lastVersion as string) || null,
          lastAt: (data.lastAt as string) || null,
          history: Array.isArray(data.history) ? (data.history as OnboardingRecord['history']) : [],
        };
      }
      // Legacy boolean flag → treat as v1.0 done.
      if (data.completed === true) {
        return {
          completedVersions: ['1.0'],
          lastVersion: '1.0',
          lastAt: (data.completedAt as string) || null,
          history: [],
        };
      }
    } catch (err) {
      console.warn('Failed to parse __alma_onboarding__.json, starting fresh:', err);
    }
  }
  return { completedVersions: [], lastVersion: null, lastAt: null, history: [] };
}

export async function GET(request: Request) {
  try {
    const session = await getApiSession(request);
    if (!session?.accessToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const drive = driveFromSession(session.accessToken);
    const fileId = await findFlagFileId(drive);
    const record = await readRecord(drive, fileId);

    return NextResponse.json({
      completed: record.completedVersions.includes(CURRENT_ONBOARDING_VERSION),
      currentVersion: CURRENT_ONBOARDING_VERSION,
      completedVersions: record.completedVersions,
    });
  } catch (error) {
    console.error('Onboarding status read error:', error);
    return NextResponse.json(
      { error: 'Failed to read onboarding status', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession(request);
    if (!session?.accessToken || !session.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userEmail = session.user.email;
    const body = await request.json().catch(() => ({}));
    const version = (body.version as string) || CURRENT_ONBOARDING_VERSION;
    const status: 'completed' | 'skipped' = body.status === 'skipped' ? 'skipped' : 'completed';

    const drive = driveFromSession(session.accessToken);
    const existingFileId = await findFlagFileId(drive);
    const record = await readRecord(drive, existingFileId);

    const nowIso = new Date().toISOString();
    const updated: OnboardingRecord = {
      completedVersions: Array.from(new Set([...record.completedVersions, version])),
      lastVersion: version,
      lastAt: nowIso,
      history: [...record.history, { version, at: nowIso, status }],
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
        requestBody: { name: ONBOARDING_FILE_NAME, mimeType: 'application/json', parents: ['root'] },
        media: { mimeType: 'application/json', body: fileContent },
        fields: 'id',
        supportsAllDrives: true,
      });
    }

    const warnings: string[] = [];
    try {
      await appendLifecycleRow(oauthFromSession(session.accessToken), {
        tab: 'Onboarding',
        email: userEmail,
        version,
        status: status === 'skipped' ? 'Skipped' : 'Completed',
      });
    } catch (sheetErr) {
      console.warn('Failed to append onboarding row to GSheet:', sheetErr);
      warnings.push('gsheet-append-failed');
    }

    return NextResponse.json({
      success: true,
      completed: true,
      completedVersion: version,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  } catch (error) {
    console.error('Onboarding status write error:', error);
    return NextResponse.json(
      { error: 'Failed to write onboarding status', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
