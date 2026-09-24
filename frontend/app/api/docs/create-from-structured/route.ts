import { Readable } from 'node:stream';
import { google } from 'googleapis';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { StructuredDoc } from '../../../canvas-272/lib/exportFormatter';
import { structuredDocToDocxBuffer } from '../../../canvas-272/lib/pandocDocx';

export const runtime = 'nodejs';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';

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

const RequestSchema = z.object({ doc: StructuredDocSchema });

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession(request);
    if (!session?.accessToken) {
      return NextResponse.json({ error: 'User not authenticated' }, { status: 401 });
    }

    const parsed = RequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid StructuredDoc payload' }, { status: 400 });
    }
    const doc = parsed.data.doc as StructuredDoc;

    // FE-SSRF-001: use the sandboxed pandoc path (--sandbox + validateDocumentResources)
    // so doc content can't drive SSRF / local file reads during conversion.
    const buffer = await structuredDocToDocxBuffer(doc, { safe: true });

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID!,
      process.env.GOOGLE_CLIENT_SECRET!,
      process.env.GOOGLE_REDIRECT_URI!,
    );
    oauth2Client.setCredentials({
      access_token: session.accessToken,
      refresh_token: session.refreshToken,
    });

    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    // Uploading DOCX media while requesting a google-apps.document target
    // mimeType makes Drive convert it into a native Google Doc, preserving
    // tables and turning Pandoc's OMML math into real Docs equations.
    const createResponse = await drive.files.create({
      requestBody: { name: doc.title, mimeType: GOOGLE_DOC_MIME },
      media: { mimeType: DOCX_MIME, body: Readable.from(buffer) },
      fields: 'id, webViewLink, name',
    });

    return NextResponse.json({
      document: {
        id: createResponse.data.id,
        webViewLink: createResponse.data.webViewLink ?? null,
        name: createResponse.data.name,
      },
    });
  } catch (error) {
    console.error('Error creating Google Doc from StructuredDoc:', error);

    if (error instanceof Error) {
      if (error.message.includes('insufficient authentication') || error.message.includes('unauthorized')) {
        return NextResponse.json({
          error: 'Authentication Error',
          details: 'Unable to authenticate with Google Drive API.',
          action: 'Please try logging out and logging back in.',
          fallback: 'You can use the Download option instead.',
        }, { status: 401 });
      }

      if (error.message.includes('quotaExceeded')) {
        return NextResponse.json({
          error: 'API Quota Exceeded',
          details: 'Google Drive API quota has been exceeded.',
          action: 'Please try again later.',
          fallback: 'You can use the Download option instead.',
        }, { status: 429 });
      }
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({
      error: 'Document Creation Failed',
      details: errorMessage,
      fallback: 'You can use the Download option instead.',
    }, { status: 500 });
  }
}
