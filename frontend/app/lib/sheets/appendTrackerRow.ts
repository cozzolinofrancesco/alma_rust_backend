import { google, type sheets_v4 } from 'googleapis';

// Use googleapis' own bundled OAuth2 client type so it matches the sheets() call
// (the top-level google-auth-library copy is a different, incompatible type).
type OAuthClient = InstanceType<typeof google.auth.OAuth2>;

// One row per bug report in the tracker sheet. Column order is the source of
// truth for the sheet header; keep TrackerRow, HEADER and the row array in sync.
export interface TrackerRow {
  timestamp: string;
  code: string;
  reporter: string;
  where: string;
  whatHappened: string;
  howItHappens: string;
  expected: string;
  extraInfo: string;
  pageUrl: string;
  appVersion: string;
  browser: string;
  viewport: string;
  screenshotCount: number;
  hasRecording: boolean;
  folderLink: string;
  videoLink: string;
}

const HEADER = [
  'Timestamp',
  'Code',
  'Reporter',
  'Where',
  'What happened',
  'How it happens',
  'Expected',
  'Extra info',
  'Page URL',
  'App version',
  'Browser',
  'Viewport',
  'Screenshots',
  'Recording',
  'Folder link',
  'Video link',
  'Status',
  'Priority',
  'Assignee',
  'Triage notes',
];

const CELL_MAX = 40000; // Sheets cell limit is 50k chars; stay comfortably under.

function clampCell(value: string): string {
  return value.length > CELL_MAX ? `${value.slice(0, CELL_MAX)}…` : value;
}

// Resolve the target tab: the configured name, else the spreadsheet's first tab
// (so it works regardless of what the default sheet is called).
async function resolveTab(sheets: sheets_v4.Sheets, spreadsheetId: string): Promise<string> {
  const configured = process.env.BUG_REPORT_TRACKER_TAB;
  if (configured) return configured;
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  return meta.data.sheets?.[0]?.properties?.title ?? 'Sheet1';
}

// Write the header row once, if the sheet's first row is still empty.
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

// Appends a report row using the reporter's own OAuth token. The tracker sheet
// must be shared with edit access to reporters, and the OAuth scope must include
// spreadsheets (read-write). Throws on any failure — callers treat it as
// non-fatal and surface a warning.
export async function appendTrackerRow(auth: OAuthClient, row: TrackerRow): Promise<void> {
  const spreadsheetId = process.env.BUG_REPORT_TRACKER_SHEET_ID;
  if (!spreadsheetId) {
    throw new Error('BUG_REPORT_TRACKER_SHEET_ID is not configured');
  }

  const sheets = google.sheets({ version: 'v4', auth });
  const tab = await resolveTab(sheets, spreadsheetId);
  await ensureHeader(sheets, spreadsheetId, tab);

  const values = [
    [
      row.timestamp,
      row.code,
      row.reporter,
      clampCell(row.where),
      clampCell(row.whatHappened),
      clampCell(row.howItHappens),
      clampCell(row.expected),
      clampCell(row.extraInfo),
      row.pageUrl,
      row.appVersion,
      clampCell(row.browser),
      row.viewport,
      String(row.screenshotCount),
      row.hasRecording ? 'yes' : 'no',
      row.folderLink,
      row.videoLink,
      'New', // status — owned by triage
      '', // priority — owned by triage
      '', // assignee — owned by triage
      '', // triageNotes — owned by triage
    ],
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
}
