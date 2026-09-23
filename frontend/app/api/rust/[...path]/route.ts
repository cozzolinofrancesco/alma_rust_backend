
// -----------------------------------------------------------------------------
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic'; // never cache a proxied backend call
export const runtime = 'nodejs';

const RUST_API_BASE = (
  process.env.ALMA_RUST_API_URL ??
  process.env.NEXT_PUBLIC_ALMA_RUST_API_URL ??
  'http://localhost:8080'
).replace(/\/$/, '');

// Hop-by-hop / host-specific headers we must not forward upstream.
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'accept-encoding',
  'transfer-encoding',
]);

async function proxy(request: NextRequest, path: string[]): Promise<Response> {
  const upstreamPath = path.map(encodeURIComponent).join('/');
  const search = request.nextUrl.search; // preserves ?limit=…&q=…
  const targetUrl = `${RUST_API_BASE}/api/${upstreamPath}${search}`;

  // Forward the caller's headers (auth, cookie, x-api-key, content-type) verbatim,
  // minus the hop-by-hop ones the runtime manages itself.
  const forwardedHeaders = new Headers();
  request.headers.forEach((value, key) => {
    if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) forwardedHeaders.set(key, value);
  });

  const method = request.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';

  const upstreamResponse = await fetch(targetUrl, {
    method,
    headers: forwardedHeaders,
    body: hasBody ? await request.arrayBuffer() : undefined,
    redirect: 'manual',
    // @ts-expect-error — Node fetch needs this when streaming a request body.
    duplex: 'half',
  });

  // Relay status + body + content type back to the browser unchanged.
  const responseHeaders = new Headers();
  const contentType = upstreamResponse.headers.get('content-type');
  if (contentType) responseHeaders.set('content-type', contentType);
  const disposition = upstreamResponse.headers.get('content-disposition');
  if (disposition) responseHeaders.set('content-disposition', disposition);

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

type RouteContext = { params: Promise<{ path: string[] }> };

async function handle(request: NextRequest, context: RouteContext): Promise<Response> {
  const { path } = await context.params; // Next.js 15: params is async
  return proxy(request, path ?? []);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;
