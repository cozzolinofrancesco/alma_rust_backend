
// -----------------------------------------------------------------------------
import { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/app/lib/authOptions';

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

// Identity + shared-secret headers the browser must NEVER set itself. The Rust
// API trusts x-account-email as the caller principal and x-api-key as its
// perimeter, so we strip any client-supplied values and inject them from the
// server-verified session / server env instead (RUST-AUTHN-001).
const CLIENT_TRUST_HEADERS = new Set(['x-account-email', 'x-api-key']);

async function proxy(request: NextRequest, path: string[]): Promise<Response> {
  // Identity is the server-verified NextAuth session email, not a client header.
  // No session ⇒ no attributable principal ⇒ refuse (defense-in-depth behind
  // middleware, which should already have blocked the request).
  const session = await getServerSession(authOptions);
  const accountEmail = session?.user?.email;
  if (!accountEmail) {
    return new Response(JSON.stringify({ error: 'unauthenticated' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const upstreamPath = path.map(encodeURIComponent).join('/');
  const search = request.nextUrl.search; // preserves ?limit=…&q=…
  const targetUrl = `${RUST_API_BASE}/api/${upstreamPath}${search}`;

  // Forward the caller's headers minus the hop-by-hop ones AND minus any
  // client-supplied identity/secret headers (which we set from trusted sources).
  const forwardedHeaders = new Headers();
  request.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (STRIPPED_REQUEST_HEADERS.has(lowerKey)) return;
    if (CLIENT_TRUST_HEADERS.has(lowerKey)) return; // never trust these from the browser
    forwardedHeaders.set(key, value);
  });

  // Inject the server-trusted principal + shared-secret perimeter key.
  forwardedHeaders.set('x-account-email', accountEmail);
  const serviceApiKey = process.env.SERVICE_API_KEY;
  if (serviceApiKey) forwardedHeaders.set('x-api-key', serviceApiKey);

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
