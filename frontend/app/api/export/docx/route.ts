
import { NextRequest, NextResponse } from 'next/server';
import { structuredDocToDocxBuffer } from '@/app/canvas-272/lib/pandocDocx';

export const runtime = 'nodejs';

interface StructuredDocStep {
  number: string;
  name: string;
  output: string;
}

interface StructuredDocSection {
  heading: string | null;
  steps: StructuredDocStep[];
}

interface StructuredDoc {
  title: string;
  agentName: string;
  exportedAt: string;
  sections: StructuredDocSection[];
}

interface DocxRequestBody {
  doc: StructuredDoc;
  fileName?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as DocxRequestBody;
    if (!body?.doc || !Array.isArray(body.doc.sections)) {
      return NextResponse.json({ error: 'Invalid StructuredDoc payload' }, { status: 400 });
    }

    // FE-SSRF-001: use the sandboxed pandoc path (--sandbox + validateDocumentResources)
    // so a markdown image/link embedded in the doc can't drive SSRF or local file reads.
    const buffer = await structuredDocToDocxBuffer(body.doc, { safe: true });

    const rawFilename =
      body.fileName && /\.docx$/i.test(body.fileName)
        ? body.fileName
        : `${(body.fileName ?? body.doc.agentName ?? 'canvas272').replace(/[^a-z0-9-_]+/gi, '_')}.docx`;
    // FE-SSRF-001: strip CR/LF, quotes and backslashes so a crafted fileName can't
    // inject extra Content-Disposition directives or split the response headers.
    const filename = rawFilename.replace(/[\r\n"\\]+/g, '_');

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(buffer.length),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
