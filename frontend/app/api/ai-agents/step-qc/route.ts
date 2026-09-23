
import { NextRequest, NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import {
  fetchQcTypesFromGSheet,
  normalizeSheetId,
  QC_TYPE_REGISTRY,
} from '@/app/claim-validation/lib/qcTypesService';
import { getCorpusById } from '@/app/lib/rag/registry';
import { queryFileSearchStore } from '@/app/lib/rag/fileSearchStore';
import { mapQueryResultToRetrievalResult } from '@/app/claim-validation/lib/ragRetrievalService';
import { validateClaim } from '@/app/claim-validation/lib/validationService';
import { createRefreshableAuth } from '@/app/lib/rag/auth';
import { GEMINI_MODELS } from '@/app/lib/modelConfig';
import { fetchWithTimeout } from '@/app/lib/fetchWithTimeout';

export const dynamic = 'force-dynamic';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_BASE_URL =
  process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

const AGENT_STEP_QC_LABEL = 'agent_step_validation_prompt';

export interface QcRow {
  claim:       string;
  status:      'MATCHING' | 'PARTIALLY_MATCHING' | 'NOT_MATCHING' | 'SOURCE_NOT_FOUND' | 'PENDING';
  action:      string;
  ragLocation: string | null;
  rationale:   string;
  sourceDoc:   string;
}

function callGemini(prompt: string): Promise<string> {
  const url = `${GEMINI_BASE_URL}/v1beta/models/${GEMINI_MODELS.flash}:generateContent?key=${GEMINI_API_KEY}`;
  return fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, topP: 0.95, topK: 20 },
    }),
  })
    .then((res) => {
      if (!res.ok) throw new Error(`Gemini error ${res.status}`);
      return res.json();
    })
    .then(
      (json) =>
        (json.candidates?.[0]?.content?.parts?.[0]?.text as string) ?? ''
    );
}

function parseJson<T>(text: string): T | null {
  try {
    const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    return match ? (JSON.parse(match[0]) as T) : null;
  } catch {
    return null;
  }
}

function encode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj) + '\n');
}

interface ExtractedClaim {
  CLAIM_TEXT: string;
  CLAIM_REF?: string | null;
  SOURCE_PAGE?: number | null;
}

async function resolveQcType(accessToken: string) {
  const sheetId = normalizeSheetId(process.env.TEMPLATES_SHEET_ID ?? '');

  let qcTypes = null;
  if (sheetId) {
    try {
      const gsheetPromise = fetchQcTypesFromGSheet(accessToken, sheetId);
      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), 4_000)
      );
      qcTypes = await Promise.race([gsheetPromise, timeoutPromise]);
    } catch {
      qcTypes = null;
    }
  }

  if (!qcTypes) qcTypes = QC_TYPE_REGISTRY;
  return qcTypes.find((t) => t.label.startsWith(AGENT_STEP_QC_LABEL)) ?? null;
}

const GENERIC_EXTRACTION_PROMPT = `You are a precise fact-checker. Extract every verifiable claim, factual statement, or numerical value from the text below.

RULES
1. One claim per entry — split compound sentences into separate entries.
2. Copy exact wording into CLAIM_TEXT.
3. Include numbers, percentages, comparisons, dates, and named assertions.
4. Skip obvious filler ("this section describes…", "in summary…").
5. If there are no verifiable claims, return an empty claims array.

OUTPUT — strict JSON only, nothing else:
{
  "claims": [
    { "CLAIM_TEXT": "string" }
  ]
}

Text:
`;

function buildExtractionPrompt(template: string, text: string): string {
  const trimmed = template.trim();
  if (trimmed.includes('SOURCE_PAGE') || trimmed.includes('uploaded document')) {
    return GENERIC_EXTRACTION_PROMPT + text.slice(0, 50_000);
  }
  return `${trimmed}\n\nText to extract claims from:\n\n${text.slice(0, 50_000)}`;
}

export async function POST(request: NextRequest) {
  const session = await getApiSession(request);
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json()) as {
    mode?: 'extract' | 'verify';
    corpusId?: string;
    generatedText?: string;
    claims?: string[];
  };

  const { mode = 'extract', corpusId } = body;

  if (mode === 'extract') {
    const { generatedText } = body;
    if (!corpusId || !generatedText?.trim()) {
      return NextResponse.json(
        { error: 'corpusId and generatedText are required' },
        { status: 400 }
      );
    }

    const qcType = await resolveQcType(session.accessToken as string);
    if (!qcType) {
      return NextResponse.json(
        { error: `QC type "${AGENT_STEP_QC_LABEL}" not found in GSheet.` },
        { status: 400 }
      );
    }

    const extractionPrompt = buildExtractionPrompt(qcType.extraction_prompt_template, generatedText);
    const extractionRaw = await callGemini(extractionPrompt);
    const extracted = parseJson<{ claims?: ExtractedClaim[] }>(extractionRaw);
    const claims = (extracted?.claims ?? [])
      .map((c) => c.CLAIM_TEXT?.trim())
      .filter(Boolean) as string[];

    return NextResponse.json({
      claims,
      message: claims.length === 0 ? 'no_claims_found' : 'ok',
    });
  }

  if (mode === 'verify') {
    const claimsToVerify = (body.claims ?? []).filter(Boolean);
    if (!corpusId || claimsToVerify.length === 0) {
      return new Response(
        encode({ type: 'error', error: 'corpusId and claims[] are required for verify mode' }),
        { status: 400, headers: { 'Content-Type': 'application/x-ndjson' } }
      );
    }

    const qcType = await resolveQcType(session.accessToken as string);
    if (!qcType) {
      return new Response(
        encode({ type: 'error', error: `QC type "${AGENT_STEP_QC_LABEL}" not found.` }),
        { status: 400, headers: { 'Content-Type': 'application/x-ndjson' } }
      );
    }

    const auth = createRefreshableAuth(
      session.accessToken as string,
      (session as { refreshToken?: string }).refreshToken
    );
    const corpus = await getCorpusById(corpusId, auth);
    if (!corpus) {
      return new Response(
        encode({ type: 'error', error: 'Corpus not found' }),
        { status: 404, headers: { 'Content-Type': 'application/x-ndjson' } }
      );
    }

    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();

    const RAG_RETRIEVE_TIMEOUT_MS = 30_000;

    const VALIDATION_PROMPT = `Verify the following claim against the retrieved evidence.

CLAIM: {{CLAIM_TEXT}}

{{RAG_EVIDENCE}}`;

    const STATUS_TO_QC: Record<string, QcRow['status']> = {
      supported:             'MATCHING',
      partially_supported:   'PARTIALLY_MATCHING',
      contradicted:          'NOT_MATCHING',
      insufficient_evidence: 'SOURCE_NOT_FOUND',
      unclear:               'SOURCE_NOT_FOUND',
    };

    const verifyClaim = async (claimText: string): Promise<QcRow> => {
      try {
        const timeoutPromise = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), RAG_RETRIEVE_TIMEOUT_MS)
        );
        const ragPromise = queryFileSearchStore(
          corpusId,
          corpus.corpusId,
          [{ role: 'user', text: claimText }]
        );
        const ragResult = await Promise.race([ragPromise, timeoutPromise]);

        if (!ragResult) {
          return {
            claim: claimText, status: 'SOURCE_NOT_FOUND',
            action: 'VERIFY_REFERENCE', ragLocation: null,
            rationale: 'Corpus retrieval timed out.', sourceDoc: '',
          };
        }

        const claimId   = `step_qc_${Date.now()}`;
        const retrieval = mapQueryResultToRetrievalResult(claimId, corpusId, ragResult, corpus);

        if (retrieval.retrieved_chunks.length === 0) {
          return {
            claim: claimText, status: 'SOURCE_NOT_FOUND',
            action: 'VERIFY_REFERENCE', ragLocation: null,
            rationale: 'No relevant evidence found in the corpus for this claim.',
            sourceDoc: '',
          };
        }

        const renderedPrompt = VALIDATION_PROMPT.replace('{{CLAIM_TEXT}}', claimText);
        const { result } = await validateClaim({ claimId, claimText, renderedPrompt, retrieval });

        const sourceDoc =
          result.evidence_sources?.[0] ??
          ragResult.groundingChunks?.[0]?.title ??
          ragResult.groundingChunks?.[0]?.uri ?? '';

        return {
          claim:       claimText,
          status:      STATUS_TO_QC[result.verdict] ?? 'SOURCE_NOT_FOUND',
          action:      result.action ?? 'NO_ACTION_NEEDED',
          ragLocation: result.rag_location ?? null,
          rationale:   result.explanation,
          sourceDoc,
        };
      } catch {
        return {
          claim: claimText, status: 'SOURCE_NOT_FOUND',
          action: 'VERIFY_REFERENCE', ragLocation: null,
          rationale: 'Verification error.', sourceDoc: '',
        };
      }
    };

    (async () => {
      try {
        for (const claimText of claimsToVerify) {
          const row = await verifyClaim(claimText);
          await writer.write(encode({ type: 'row', row }));
        }
        await writer.write(encode({ type: 'done' }));
      } catch (err) {
        await writer.write(encode({
          type: 'error',
          error: err instanceof Error ? err.message : 'QC verification failed',
        }));
      } finally {
        await writer.close();
      }
    })();

    return new Response(stream.readable, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  return NextResponse.json({ error: 'Unknown mode' }, { status: 400 });
}
