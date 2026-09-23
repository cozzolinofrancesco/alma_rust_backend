import { google, type sheets_v4 } from 'googleapis';

// Use googleapis' own bundled OAuth2 client type so it matches the sheets() call
// (the top-level google-auth-library copy is a different, incompatible type).
type OAuthClient = InstanceType<typeof google.auth.OAuth2>;

// Central spreadsheet that also holds the training completion tab. Falls back to
// the same hardcoded id training uses (app/api/training/route.ts) so a missing
// env var still lands rows in the right place.
const LIFECYCLE_SHEET_FALLBACK_ID = '1Z98AFw5qAFyiATWkpYDWQktSVrQBXj3rI7CRa2-1Iyc';

const HEADER = ['User Email', 'Timestamp', 'Version', 'Status'];

export type LifecycleTab = 'Disclaimer' | 'Onboarding';

export interface LifecycleRow {
  tab: LifecycleTab;
  email: string;
  version: string;
  status: string;
}

// Create the target tab if it doesn't exist yet, so the first write to a fresh
// spreadsheet doesn't fail on an unknown range.
async function ensureTab(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  tab: string,
): Promise<void> {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title',
  });
  const exists = meta.data.sheets?.some((s) => s.properties?.title === tab);
  if (exists) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
  });
}

// Write the header row once, if the tab's first row is still empty.
async function ensureHeader(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  tab: string,
): Promise<void> {
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A1:A1`,
  });
  if (existing.data.values && existing.data.values.length > 0) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [HEADER] },
  });
}

// Appends one lifecycle-event row (disclaimer accepted / onboarding tour
// completed or skipped) using the signed-in user's own OAuth token. Throws on
// any failure — callers treat it as non-fatal and surface a warning, mirroring
// the training route's best-effort sheet append.
export async function appendLifecycleRow(auth: OAuthClient, row: LifecycleRow): Promise<void> {
  const spreadsheetId = process.env.TRAINING_SHEET_ID || LIFECYCLE_SHEET_FALLBACK_ID;
  const sheets = google.sheets({ version: 'v4', auth });

  await ensureTab(sheets, spreadsheetId, row.tab);
  await ensureHeader(sheets, spreadsheetId, row.tab);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${row.tab}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[row.email, new Date().toISOString(), `v${row.version}`, row.status]],
    },
  });
}
