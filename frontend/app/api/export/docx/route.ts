
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

    const buffer = await structuredDocToDocxBuffer(body.doc);

    const filename =
      body.fileName && /\.docx$/i.test(body.fileName)
        ? body.fileName
        : `${(body.fileName ?? body.doc.agentName ?? 'canvas272').replace(/[^a-z0-9-_]+/gi, '_')}.docx`;

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
