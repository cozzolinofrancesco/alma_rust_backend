import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getAgentnodesDrive } from '../../../lib/agentnodesApi/driveFromRequest';

const ImportRequestSchema = z.object({ url: z.string().min(1) });

// Accepts a Google Docs URL (or a bare doc id) and returns the document's plain
// text by exporting it via the Drive API. Reuses the per-user OAuth Drive
// client, so the user can only import docs they already have access to.
function extractDocId(input: string): string | null {
  const byPath = input.match(/\/document\/d\/([\w-]+)/);
  if (byPath) return byPath[1];
  const byQuery = input.match(/[?&]id=([\w-]+)/);
  if (byQuery) return byQuery[1];
  if (/^[\w-]{20,}$/.test(input.trim())) return input.trim();
  return null;
}

export async function POST(request: NextRequest) {
  const ctx = await getAgentnodesDrive(request);
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = ImportRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'A Google Docs URL is required' }, { status: 400 });
  }

  const docId = extractDocId(parsed.data.url);
  if (!docId) {
    return NextResponse.json({ error: 'Could not recognise that as a Google Docs link' }, { status: 400 });
  }

  try {
    const res = await ctx.drive.files.export(
      { fileId: docId, mimeType: 'text/plain' },
      { responseType: 'text' },
    );
    const text = typeof res.data === 'string' ? res.data : String(res.data ?? '');
    return NextResponse.json({ text });
  } catch (error) {
    const code = (error as { code?: number })?.code;
    if (code === 404) {
      return NextResponse.json({ error: 'Document not found or not accessible' }, { status: 404 });
    }
    if (code === 403) {
      return NextResponse.json({ error: 'You do not have access to this document' }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : 'Failed to import document';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
