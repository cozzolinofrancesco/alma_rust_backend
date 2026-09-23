import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import {
  normalizeSheetId,
  fetchQcTypesFromGSheet,
  QC_TYPE_REGISTRY,
} from '@/app/claim-validation/lib/qcTypesService';

export async function GET(request: Request) {
  const session = await getApiSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sheetIdRaw  = process.env.TEMPLATES_SHEET_ID ?? '';
  const sheetId     = normalizeSheetId(sheetIdRaw);
  const accessToken = (session as { accessToken?: string }).accessToken;

  if (sheetId && accessToken) {
    const sheetQcTypes = await fetchQcTypesFromGSheet(accessToken, sheetId);
    if (sheetQcTypes) {
      return NextResponse.json({ qcTypes: sheetQcTypes });
    }
  }

  return NextResponse.json({ qcTypes: QC_TYPE_REGISTRY });
}
