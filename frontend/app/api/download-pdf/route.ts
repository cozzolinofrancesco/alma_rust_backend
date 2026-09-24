import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import { authOptions } from '@/app/lib/authOptions';
import { assertPublicHttpUrl, pinnedHttpsDispatcher } from '@/app/lib/ssrfGuard';

const MAX_PDF_BYTES = 50 * 1024 * 1024;

const requestSchema = z.object({
  pdfUrl: z.string().url(),
  filename: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // FE-SSRF-002: track the pinned dispatcher so it is always torn down, even on
  // an early return from a redirect/guard failure.
  let dispatcher: ReturnType<typeof pinnedHttpsDispatcher> | null = null;
  try {
    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'A valid pdfUrl is required' }, { status: 400 });
    }
    const { pdfUrl, filename } = parsed.data;

    let nextUrl = pdfUrl;
    let response: Awaited<ReturnType<typeof undiciFetch>> | null = null;
    const MAX_REDIRECTS = 5;

    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const { url: safeUrl, addresses } = await assertPublicHttpUrl(nextUrl);
        // FE-SSRF-002: connect only to the address just validated so undici cannot
        // re-resolve the hostname to a rebound private IP between check and fetch.
        if (dispatcher) await dispatcher.destroy();
        dispatcher = pinnedHttpsDispatcher(addresses);
        const hopResponse = await undiciFetch(safeUrl, {
          dispatcher,
          redirect: 'manual',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'application/pdf,*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
          },
        });

        if (hopResponse.status >= 300 && hopResponse.status < 400) {
          const location = hopResponse.headers.get('location');
          if (!location) {
            return NextResponse.json({ error: 'Redirect without a location' }, { status: 502 });
          }
          nextUrl = new URL(location, safeUrl).toString();
          continue;
        }

        response = hopResponse;
        break;
      }
    } catch (guardError) {
      return NextResponse.json(
        { error: guardError instanceof Error ? guardError.message : 'Disallowed URL' },
        { status: 400 }
      );
    }

    if (!response) {
      return NextResponse.json({ error: 'Too many redirects' }, { status: 502 });
    }

    if (!response.ok) {
      console.error(`Failed to fetch PDF: ${response.status} ${response.statusText}`);
      return NextResponse.json(
        { error: `Failed to fetch PDF from publisher: ${response.status} ${response.statusText}` },
        { status: response.status }
      );
    }

    const contentType = response.headers.get('content-type') || '';
    if (!/application\/(pdf|octet-stream)/i.test(contentType)) {
      return NextResponse.json(
        { error: 'Remote resource is not a PDF' },
        { status: 415 }
      );
    }

    const pdfBuffer = await response.arrayBuffer();
    if (pdfBuffer.byteLength > MAX_PDF_BYTES) {
      return NextResponse.json({ error: 'PDF exceeds maximum allowed size' }, { status: 413 });
    }

    const safeFilename = (filename || 'paper.pdf').replace(/[^a-z0-9._-]+/gi, '_');

    return new NextResponse(pdfBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${safeFilename}"`,
        'Content-Length': pdfBuffer.byteLength.toString(),
      },
    });

  } catch (error) {
    console.error('Error downloading PDF:', error);
    return NextResponse.json(
      { error: 'Failed to download PDF' },
      { status: 500 }
    );
  } finally {
    // FE-SSRF-002: release the pinned connection pool once the body is read.
    if (dispatcher) await dispatcher.destroy();
  }
}
