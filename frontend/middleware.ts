import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { corsHeaders } from './app/lib/cors';
import { isAllowedOrgEmail } from './app/lib/orgDomain';

// Routes that are intentionally public (no auth): the NextAuth flow manages its
// own cookies/headers, and setAuthCookie self-gates on a Bearer token.
function isPublicRoute(pathname: string): boolean {
  return pathname.startsWith('/api/auth/')
    || pathname === '/api/setAuthCookie'
    || pathname === '/api/docs-auth';
}

// Service endpoints validate SERVICE_API_KEY inside their own handler (and accept
// the key via body/form fields the Edge middleware can't read). They gate
// themselves, so the central gate lets them through to their handler.
const SERVICE_ENDPOINTS = [
  '/api/ai',
  '/api/ai/cache',
  '/api/gemini',
  '/api/generate-image',
  '/api/image-analysis',
];

function isServiceEndpoint(pathname: string): boolean {
  return SERVICE_ENDPOINTS.some((ep) => pathname === ep || pathname.startsWith(`${ep}/`));
}

// Every /api route except the public/service ones above requires a valid
// NextAuth session OR the shared SERVICE_API_KEY (x-api-key header). This is the
// single backstop so no route is ever left unauthenticated by omission.
async function isAuthorized(req: NextRequest): Promise<boolean> {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  // A valid Google JWT is only accepted for an allowed-org account — the
  // @roche.com restriction is enforced here, server-side (FE-AUTHZ-001), not
  // just in the client AuthGuard.
  if (token) return isAllowedOrgEmail(typeof token.email === 'string' ? token.email : undefined);
  const serviceKey = process.env.SERVICE_API_KEY;
  return !!serviceKey && req.headers.get('x-api-key') === serviceKey;
}

function withCors(response: NextResponse, pathname: string): NextResponse {
  // Exclude /api/auth/* — NextAuth manages its own cookies/headers, and
  // Access-Control-Allow-Credentials: false would break session cookies.
  if (pathname.startsWith('/api/') && !pathname.startsWith('/api/auth/')) {
    Object.entries(corsHeaders).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
  }
  return response;
}

export async function middleware(req: NextRequest) {
  // Handle CORS preflight requests globally
  if (req.method === 'OPTIONS') {
    return new NextResponse(null, { status: 200, headers: corsHeaders });
  }

  const { pathname } = req.nextUrl;

  // Central auth gate: applies to every /api route that isn't public or a
  // self-gating service endpoint.
  if (pathname.startsWith('/api/') && !isPublicRoute(pathname) && !isServiceEndpoint(pathname)) {
    if (!(await isAuthorized(req))) {
      const portableApi = pathname === '/api/v1/agentnodes' || pathname.startsWith('/api/v1/agentnodes/');
      return withCors(
        NextResponse.json(portableApi ? { error: { code: 'API_KEY_REQUIRED', message: 'A valid x-api-key header is required.',
          stage: 'authorization', finalInferenceAttempted: false, retryable: false } } : { error: 'Unauthorized' },
        { status: 401, ...(portableApi ? { headers: { 'Cache-Control': 'no-store' } } : {}) }),
        pathname,
      );
    }
  }

  return withCors(NextResponse.next(), pathname);
}

// Apply the middleware to all routes
export const config = {
  matcher: '/:path*',
};
