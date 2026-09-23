import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import {
  fetchInstructionsTabFromSheet,
  fetchSect1MetaStepsFromSheet,
  mergeSharedBiomaterialInstruction,
} from '@/app/lib/sect1MetaSteps';

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

    const [steps, instructionsTabText] = await Promise.all([
      fetchSect1MetaStepsFromSheet(accessToken, resolvedId),
      fetchInstructionsTabFromSheet(accessToken, resolvedId),
    ]);
    const sharedInstruction = mergeSharedBiomaterialInstruction(instructionsTabText, steps);
    return NextResponse.json({ steps, sharedInstruction });
  } catch (error) {
    console.error('sect1-meta-steps fetch error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load sect1MetaSteps' },
      { status: 500 }
    );
  }
}
