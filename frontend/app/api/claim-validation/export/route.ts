import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { exportToCsv, exportToJson } from '@/app/claim-validation/lib/resultProcessingService';
import type { ExportRequest } from '@/app/claim-validation/types';

export async function POST(request: Request) {
  const session = await getApiSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: ExportRequest;
  try {
    body = await request.json() as ExportRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { results, format, extractionPrompt, validationPrompt, corpus_scope_sha, extraction_integrity_record } = body;

  if (!Array.isArray(results)) {
    return NextResponse.json({ error: 'results must be an array' }, { status: 400 });
  }

  if (format === 'csv') {
    const csv      = exportToCsv(results);
    const filename = `claim-validation-${Date.now()}.csv`;
    return new Response(csv, {
      headers: {
        'Content-Type':        'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  }

  if (format === 'json') {
    const rows = exportToJson(results);
    const payload =
      extractionPrompt !== undefined || validationPrompt !== undefined || corpus_scope_sha !== undefined || extraction_integrity_record !== undefined
        ? {
            extraction_prompt: extractionPrompt ?? '',
            ...(extraction_integrity_record !== undefined ? { extraction_integrity_record } : {}),
            validation_prompt_template: validationPrompt ?? '',
            ...(corpus_scope_sha != null && corpus_scope_sha !== '' ? { corpus_scope_sha } : {}),
            results: rows,
          }
        : rows;
    const json     = JSON.stringify(payload, null, 2);
    const filename = `claim-validation-${Date.now()}.json`;
    return new Response(json, {
      headers: {
        'Content-Type':        'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  }

  return NextResponse.json({ error: 'format must be "csv" or "json"' }, { status: 400 });
}
