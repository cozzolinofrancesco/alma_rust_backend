import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import type { Session } from '@/app/lib/authOptions';
import { extractClaims } from '@/app/claim-validation/lib/claimExtractionService';
import { splitAndExtract } from '@/app/claim-validation/lib/splitExtractService';
import type { ExtractClaimsRequest, SplitConfig } from '@/app/claim-validation/types';

export const maxDuration = 3000;

export async function POST(request: Request) {
  const session = (await getApiSession(request)) as Session | null;
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: ExtractClaimsRequest;
  try {
    body = await request.json() as ExtractClaimsRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { fileUri, mimeType, document_id, extractionPrompt, rawText, splitConfig } = body as ExtractClaimsRequest & { splitConfig?: SplitConfig };

  if (!document_id || !extractionPrompt) {
    return NextResponse.json(
      { error: 'Missing required fields: document_id, extractionPrompt' },
      { status: 400 }
    );
  }

  if (!rawText && !fileUri) {
    return NextResponse.json(
      { error: 'Either fileUri or rawText must be provided' },
      { status: 400 }
    );
  }

  if (!extractionPrompt.trim()) {
    return NextResponse.json(
      { error: 'extractionPrompt must not be empty' },
      { status: 400 }
    );
  }

  const useSplit = !rawText && splitConfig?.enabled === true && !!fileUri;

  if (splitConfig?.enabled && !rawText) {
    const { pagesPerChunk, overlapPages } = splitConfig;
    if (!Number.isInteger(pagesPerChunk) || pagesPerChunk < 1) {
      return NextResponse.json({ error: 'splitConfig.pagesPerChunk must be an integer >= 1' }, { status: 400 });
    }
    if (!Number.isInteger(overlapPages) || overlapPages < 0) {
      return NextResponse.json({ error: 'splitConfig.overlapPages must be a non-negative integer' }, { status: 400 });
    }
    if (overlapPages >= pagesPerChunk) {
      return NextResponse.json({ error: 'splitConfig.overlapPages must be less than pagesPerChunk' }, { status: 400 });
    }
  }

  try {
    console.log(
      `[API/extract-claims] document_id=${document_id} mode=${rawText ? 'raw-text' : `fileUri=${fileUri}`}${useSplit ? ` split(${splitConfig!.pagesPerChunk}p overlap=${splitConfig!.overlapPages})` : ''}`
    );

    const { claims, rawCount, extraction_integrity_record } = useSplit
      ? await splitAndExtract({
          fileUri:          fileUri!,
          mimeType:         mimeType ?? 'application/pdf',
          documentId:       document_id,
          extractionPrompt,
          splitConfig: {
            pagesPerChunk: splitConfig!.pagesPerChunk,
            overlapPages:  splitConfig!.overlapPages,
          },
        })
      : await extractClaims({
          fileUri:          fileUri ?? undefined,
          mimeType:         mimeType ?? 'application/pdf',
          rawText:          rawText ?? undefined,
          documentId:       document_id,
          extractionPrompt,
        });

    if (claims.length === 0) {
      return NextResponse.json({
        claims:    [],
        raw_count: rawCount,
        extraction_integrity_record,
        warning:   'No claims were extracted. Try adjusting the extraction prompt.',
      });
    }

    return NextResponse.json({ claims, raw_count: rawCount, extraction_integrity_record });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Claim extraction failed';
    console.error('[API/extract-claims] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
