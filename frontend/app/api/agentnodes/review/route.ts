
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { geminiChat } from '../../../lib/gemini';
import { DEFAULT_MODEL } from '../../../lib/modelConfig';
import { getReviewer } from '../../../agentnodes/lib/reviewers/registry';
import type { ReviewerId } from '../../../agentnodes/lib/reviewers/types';

export const runtime = 'nodejs';

const ReviewerIdSchema = z.enum([
  'document-quality',
  'grammar-mechanics',
  'clarity-readability',
  'consistency-style',
  'clinical',
  'medical-writer',
  'fda-drugs',
  'ema-drugs',
  'regulatory',
  'sme-biomaterial',
]);

const StructuredDocStepSchema = z.object({
  number: z.string(),
  name: z.string(),
  output: z.string(),
});

const StructuredDocSectionSchema = z.object({
  heading: z.string().nullable(),
  steps: z.array(StructuredDocStepSchema),
  tag: z.string().nullable().optional(),
});

const StructuredDocSchema = z.object({
  title: z.string(),
  agentName: z.string(),
  exportedAt: z.string(),
  sections: z.array(StructuredDocSectionSchema),
});

const VerdictSchema = z.enum(['PASS', 'REVISE', 'FAIL']);
const SeveritySchema = z.enum(['info', 'warn', 'block']);

const CoercedReviewReportSchema = z.object({
  reviewerId: ReviewerIdSchema,
  overall: VerdictSchema,
  comments: z.array(
    z.object({
      stepNumber: z.string(),
      severity: SeveritySchema,
      text: z.string(),
    }),
  ),
});

function shallowCamelKeys(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const nk = k.replace(/_([a-z])/g, (_, g: string) => g.toUpperCase());
    out[nk] = v;
  }
  return out;
}

function unwrapSingleElementArray(data: unknown): unknown {
  if (Array.isArray(data) && data.length === 1) return data[0];
  return data;
}

function normalizeOverall(raw: unknown): z.infer<typeof VerdictSchema> | null {
  if (typeof raw !== 'string') return null;
  let u = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (u === 'PASSED' || u === 'OK' || u === 'APPROVED') u = 'PASS';
  if (u === 'FAILED' || u === 'REJECT') u = 'FAIL';
  if (u === 'REVISION' || u === 'NEEDSREVISION' || u === 'NEEDS_REVISION') u = 'REVISE';
  const v = VerdictSchema.safeParse(u);
  return v.success ? v.data : null;
}

function normalizeSeverity(raw: unknown): z.infer<typeof SeveritySchema> {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'critical' || s === 'high' || s === 'error' || s === 'blocking') return 'block';
  if (s === 'warning' || s === 'medium' || s === 'moderate') return 'warn';
  if (s === 'informational' || s === 'low' || s === 'note') return 'info';
  const p = SeveritySchema.safeParse(s);
  return p.success ? p.data : 'info';
}

function coerceModelReviewToReport(
  parsed: unknown,
  expectedReviewerId: ReviewerId,
  fallbackStepNumber: string,
): { ok: true; report: z.infer<typeof CoercedReviewReportSchema> } | { ok: false; reason: string } {
  const root = unwrapSingleElementArray(parsed);
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    return { ok: false, reason: 'Root JSON was not an object' };
  }
  const row = shallowCamelKeys(root as Record<string, unknown>);

  const overall = normalizeOverall(row.overall);
  if (!overall) {
    return { ok: false, reason: `Invalid or missing "overall" (got ${JSON.stringify(row.overall)})` };
  }

  const rawComments = row.comments;
  const list = Array.isArray(rawComments) ? rawComments : [];

  const comments: z.infer<typeof CoercedReviewReportSchema>['comments'] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const c = shallowCamelKeys(item as Record<string, unknown>);
    const stepRaw = c.stepNumber ?? c.step ?? c.stepNum;
    let stepNumber =
      stepRaw === null || stepRaw === undefined ? '' : String(stepRaw).replace(/^step\s*/i, '').trim();
    if (!stepNumber) stepNumber = fallbackStepNumber;

    const textRaw = c.text ?? c.message ?? c.body ?? c.comment;
    const text = textRaw === null || textRaw === undefined ? '' : String(textRaw).trim();
    if (!text) continue;

    comments.push({
      stepNumber,
      severity: normalizeSeverity(c.severity),
      text,
    });
  }

  const coerced = {
    reviewerId: expectedReviewerId,
    overall,
    comments,
  };
  const finalParse = CoercedReviewReportSchema.safeParse(coerced);
  if (!finalParse.success) {
    return { ok: false, reason: finalParse.error.message };
  }
  return { ok: true, report: finalParse.data };
}

function parseJsonFromModelText(raw: string): unknown | null {
  let t = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1].trim();

  const tryParse = (s: string): unknown | null => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return null;
    }
  };

  let v = tryParse(t);
  if (v !== null) return v;

  const i0 = t.indexOf('{');
  const i1 = t.lastIndexOf('}');
  if (i0 >= 0 && i1 > i0) v = tryParse(t.slice(i0, i1 + 1));
  return v;
}

function collectStepNumbers(doc: z.infer<typeof StructuredDocSchema>): string[] {
  const nums: string[] = [];
  for (const sec of doc.sections) {
    for (const st of sec.steps) nums.push(st.number);
  }
  return nums;
}

const RequestBodySchema = z.object({
  reviewerId: ReviewerIdSchema,
  doc: StructuredDocSchema,
});

function buildDocPrompt(doc: z.infer<typeof StructuredDocSchema>, reviewerId: ReviewerId): string {
  const lines: string[] = [
    `Document: ${doc.title}`,
    `Agent: ${doc.agentName}`,
    '',
    'Please review the following document content:',
    '',
  ];

  for (const section of doc.sections) {
    if (section.heading) {
      lines.push(`## ${section.heading}`);
      lines.push('');
    }
    for (const step of section.steps) {
      lines.push(`### Step ${step.number} — ${step.name}`);
      lines.push('');
      lines.push(step.output.trim() || '(no output)');
      lines.push('');
    }
  }

  const stepNums = collectStepNumbers(doc);
  const stepList = stepNums.length > 0 ? stepNums.map((n) => `"${n}"`).join(', ') : '"1"';

  lines.push('');
  lines.push(
    'Return your review as a single JSON object matching the required schema. ' +
      'Respond with ONLY the JSON — no other text.',
  );
  lines.push('');
  lines.push('Hard requirements for this run:');
  lines.push(`- The field "reviewerId" MUST be exactly this string: "${reviewerId}"`);
  lines.push(
    `- Each comment's "stepNumber" MUST be one of these exact values (match the document): ${stepList}`,
  );

  return lines.join('\n');
}

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rawBody = await request.json();
    const bodyParse = RequestBodySchema.safeParse(rawBody);
    if (!bodyParse.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: bodyParse.error.flatten() },
        { status: 400 },
      );
    }

    const { reviewerId, doc } = bodyParse.data;
    const reviewer = getReviewer(reviewerId as ReviewerId);

    const userPrompt = buildDocPrompt(doc, reviewerId as ReviewerId);

    const rawResponse = await geminiChat(
      [{ role: 'user', text: userPrompt }],
      DEFAULT_MODEL,
      { role: 'system', text: reviewer.systemInstruction },
    );

    if (!rawResponse) {
      return NextResponse.json({ error: 'Empty response from model' }, { status: 502 });
    }

    const parsed = parseJsonFromModelText(rawResponse);
    if (parsed === null) {
      return NextResponse.json(
        { error: 'Model did not return valid JSON', raw: rawResponse.slice(0, 400) },
        { status: 502 },
      );
    }

    const fallbackStep = collectStepNumbers(doc)[0] ?? '1';
    const coerced = coerceModelReviewToReport(parsed, reviewerId as ReviewerId, fallbackStep);
    if (!coerced.ok) {
      return NextResponse.json(
        {
          error: 'Model response did not match review schema',
          details: { reason: coerced.reason, rawPreview: rawResponse.slice(0, 500) },
        },
        { status: 502 },
      );
    }

    const reportWithIds = {
      ...coerced.report,
      comments: coerced.report.comments.map((c, i) => ({
        ...c,
        id: `${reviewerId}-${i}-${Date.now()}`,
      })),
    };

    return NextResponse.json(reportWithIds);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
