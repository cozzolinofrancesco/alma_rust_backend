
import type { StructuredDoc } from '../../../canvas-272/lib/exportFormatter';
import type { ReviewReport, ReviewRun, ReviewerId } from './types';
import { computeDocHash } from './docHash';

function uuid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function runSingleReviewer(
  frozenDoc: Readonly<StructuredDoc>,
  reviewerId: ReviewerId,
): Promise<ReviewReport> {
  try {
    const res = await fetch('/api/agentnodes/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ reviewerId, doc: frozenDoc }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        details?: { reason?: string; raw?: string; rawPreview?: string };
      };
      const base = body.error ?? `HTTP ${res.status}`;
      const reason =
        body.details && typeof body.details === 'object' && 'reason' in body.details
          ? String((body.details as { reason?: unknown }).reason ?? '')
          : '';
      const msg = reason ? `${base} (${reason})` : base;
      throw new Error(msg);
    }

    const data = (await res.json()) as ReviewReport;
    return data;
  } catch (err) {
    return {
      reviewerId,
      overall: 'FAIL',
      comments: [
        {
          id: uuid(),
          stepNumber: 'N/A',
          severity: 'block',
          text: `Reviewer failed to run: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}

export async function runReviewCommittee(
  doc: Readonly<StructuredDoc>,
  reviewerIds: ReviewerId[],
): Promise<ReviewRun> {
  if (reviewerIds.length === 0) {
    throw new Error('runReviewCommittee: no reviewers selected');
  }

  const frozenDoc = Object.freeze({ ...doc, sections: Object.freeze(doc.sections.map(Object.freeze)) });

  const startedAt = new Date().toISOString();
  const docHash = await computeDocHash(doc);

  const reports = await Promise.all(
    reviewerIds.map((id) => runSingleReviewer(frozenDoc as Readonly<StructuredDoc>, id)),
  );

  return {
    runId: uuid(),
    startedAt,
    finishedAt: new Date().toISOString(),
    docHash,
    reports,
  };
}
