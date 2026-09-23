import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { fetchStudyTypesFromGSheet, loadStudyTypes, loadStudyTypesFromYamlText } from '@/app/lib/templateLoader';

export async function GET(request: Request) {
  try {
    const configSheetId = process.env.STUDY_TYPES_SHEET_ID || '';
    if (configSheetId) {
      const session = await getApiSession(request);
      const accessToken = (session as { accessToken?: string })?.accessToken;
      if (accessToken) {
        const fromSheet = await fetchStudyTypesFromGSheet(accessToken, configSheetId);
        if (fromSheet) return NextResponse.json({ studyTypes: fromSheet, source: 'gsheet' });
      }
    }

    const studyTypes = loadStudyTypes();
    return NextResponse.json({ studyTypes, source: 'yaml' });
  } catch (error) {
    console.error('Failed to load study types:', error);
    return NextResponse.json({ error: 'Failed to load study types' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const sheetId = (body?.sheetId as string) || '';
    const yamlText = (body?.yamlText as string) || '';

    const configSheetId = process.env.STUDY_TYPES_SHEET_ID || '';
    const session = await getApiSession(req);
    const accessToken = (session as { accessToken?: string })?.accessToken;

    if (accessToken && configSheetId) {
      const fromSheet = await fetchStudyTypesFromGSheet(accessToken, configSheetId);
      if (fromSheet) return NextResponse.json({ studyTypes: fromSheet, source: 'gsheet' });
    }

    if (accessToken && sheetId && sheetId !== configSheetId) {
      const fromSheet = await fetchStudyTypesFromGSheet(accessToken, sheetId);
      if (fromSheet) return NextResponse.json({ studyTypes: fromSheet, source: 'gsheet' });
    }

    if (yamlText) {
      const parsed = loadStudyTypesFromYamlText(yamlText);
      if (parsed.length > 0) return NextResponse.json({ studyTypes: parsed, source: 'upload' });
    }

    const studyTypes = loadStudyTypes();
    return NextResponse.json({ studyTypes, source: 'yaml' });
  } catch (error) {
    console.error('Failed to load study types (POST):', error);
    return NextResponse.json({ error: 'Failed to load study types' }, { status: 500 });
  }
}

