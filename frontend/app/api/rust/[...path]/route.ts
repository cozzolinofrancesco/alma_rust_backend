
// -----------------------------------------------------------------------------
import { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';

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

  // Forward the caller's headers (auth, cookie, content-type) verbatim, minus the
  // hop-by-hop ones the runtime manages itself.
  const forwardedHeaders = new Headers();
  request.headers.forEach((value, key) => {
    if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) forwardedHeaders.set(key, value);
  });

  // Resolve the Rust perimeter's identity headers. The Rust API
  // (crates/http/src/pipeline/extractor.rs) requires `x-account-email` on every
  // request and `x-api-key` when SERVICE_API_KEY is configured — but a browser
  // carries only the NextAuth session cookie, so without this translation every
  // browser→Rust call would 401. Two accepted callers:
  //   1. Browser session — derive the principal email from the NextAuth JWT.
  //   2. Trusted service call presenting the shared secret (`x-api-key ===
  //      SERVICE_API_KEY`) with an explicit `x-account-email` — honored as-is
  //      (used by the local e2e harness). Browsers never hold the service key, so
  //      this branch cannot be reached from the client.
  // Identity is set AFTER the verbatim header copy so a session caller cannot
  // spoof it.
  const serviceApiKey = process.env.SERVICE_API_KEY;
  const presentedServiceKey = request.headers.get('x-api-key');
  const presentedAccountEmail = request.headers.get('x-account-email');
  let authorizedEmail: string | null = null;
  if (serviceApiKey && presentedServiceKey === serviceApiKey && presentedAccountEmail) {
    authorizedEmail = presentedAccountEmail;
  } else {
    const sessionToken = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
    authorizedEmail = typeof sessionToken?.email === 'string' ? sessionToken.email : null;
  }
  if (!authorizedEmail) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  forwardedHeaders.set('x-account-email', authorizedEmail);
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
