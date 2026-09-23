import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';

export interface Sec3StepData {
  id: string;
  name: string;
  instruction: string;
  keywords: string[];
}

function parseKeywords(raw: string): string[] {
  const t = (raw || '').trim();
  if (!t) return [];
  return t.includes('\n')
    ? t.split('\n').map((s) => s.trim()).filter(Boolean)
    : t.split(',').map((s) => s.trim()).filter(Boolean);
}

async function fetchSec3Steps(accessToken: string, sheetId: string): Promise<Sec3StepData[]> {
  const range = encodeURIComponent('TemplatesSec3!A2:C');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Failed to fetch TemplatesSec3 (${response.status}): ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  const rows: string[][] = data.values || [];

  return rows
    .map((row, idx) => {
      const name = (row[0] || '').trim();
      const instruction = (row[1] || '').trim();
      const keywordsRaw = (row[2] || '').trim();
      if (!name || !instruction) return null;
      return {
        id: `sec3-step-${idx + 1}`,
        name,
        instruction,
        keywords: parseKeywords(keywordsRaw),
      };
    })
    .filter((s): s is Sec3StepData => s !== null);
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const sheetId: string = (body?.sheetId as string) || process.env.TEMPLATES_SHEET_ID || '';

    if (!sheetId) {
      return NextResponse.json({ error: 'No sheetId provided' }, { status: 400 });
    }

    const session = await getApiSession(req);
    const accessToken = (session as { accessToken?: string })?.accessToken;

    if (!accessToken) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const match = sheetId.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    const resolvedId = match?.[1] || sheetId;

    const steps = await fetchSec3Steps(accessToken, resolvedId);
    return NextResponse.json({ steps });
  } catch (error) {
    console.error('sec3-steps fetch error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load Sec3 steps' },
      { status: 500 }
    );
  }
}
