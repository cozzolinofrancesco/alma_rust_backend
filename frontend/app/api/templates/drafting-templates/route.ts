import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { loadTemplates } from '@/app/lib/templateLoader';

export async function GET(request: Request) {
  try {
    const session = await getApiSession(request);
    const accessToken = (session as { accessToken?: string })?.accessToken;

    const templatesResult = await loadTemplates(accessToken);
    if (!templatesResult) {
      return NextResponse.json(
        {
          error: 'Failed to load templates from GSheet. Check TEMPLATES_SHEET_ID and sharing permissions.',
          templates: [],
          source: 'none',
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      templates: Object.values(templatesResult.templates || {}),
      source: templatesResult.source,
    });
  } catch (error) {
    console.error('Failed to load drafting templates:', error);
    return NextResponse.json({ error: 'Failed to load drafting templates' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const sheetId = (body?.sheetId as string) || '';

    const session = await getApiSession(req);
    const accessToken = (session as { accessToken?: string })?.accessToken;

    const templatesResult = await loadTemplates(accessToken, {
      sheetId: sheetId || undefined,
    });
    if (!templatesResult) {
      return NextResponse.json(
        { error: 'Failed to load templates from GSheet', templates: [], source: 'none' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      templates: Object.values(templatesResult.templates || {}),
      source: templatesResult.source,
    });
  } catch (error) {
    console.error('Failed to load drafting templates (POST):', error);
    return NextResponse.json({ error: 'Failed to load drafting templates' }, { status: 500 });
  }
}

