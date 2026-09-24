import { NextResponse } from 'next/server';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Requested-With, Accept, Origin, Cache-Control, X-CSRF-Token',
  'Access-Control-Max-Age': '86400',
  'Access-Control-Allow-Credentials': 'false',
};

export function addCorsHeaders(response: NextResponse): NextResponse {
  Object.entries(corsHeaders).forEach(([key, value]) => {
    response.headers.set(key, value);
  });
  return response;
}

export function createCorsResponse(data: unknown, status = 200): NextResponse {
  const response = NextResponse.json(data, { status });
  return addCorsHeaders(response);
}

export function createCorsOptionsResponse(): NextResponse {
  return new NextResponse(null, { 
    status: 200,
    headers: corsHeaders
  });
}

export function createCorsErrorResponse(error: string, status = 500): NextResponse {
  const response = NextResponse.json({ error }, { status });
  return addCorsHeaders(response);
}

export function withCors<T extends unknown[]>(
  handler: (...args: T) => Promise<NextResponse>
) {
  return async (...args: T): Promise<NextResponse> => {
    try {
      const response = await handler(...args);
      return addCorsHeaders(response);
    } catch (error) {
      console.error('API Error:', error);
      return createCorsErrorResponse(
        error instanceof Error ? error.message : 'Internal server error'
      );
    }
  };
}

// FE-AUTH-002 / MISC-CORS-001: token- and credential-bearing routes must NOT be
// readable cross-origin. The wildcard `corsHeaders` above (ACAO:*) is fine for
// non-sensitive routes, but a page on any origin could otherwise read a minted
// session/token body. The strict helpers below never emit `*`: they reflect the
// request Origin only when it is on an explicit allowlist (and then permit
// credentials). Same-origin app requests are unaffected (same-origin is not
// subject to CORS); unlisted cross-origin callers get no ACAO and cannot read
// the response.
const secureAllowedOrigins = new Set(
  (process.env.CORS_ALLOWED_ORIGINS ?? process.env.NEXTAUTH_URL ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);

function secureCorsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Requested-With, Accept, Origin, Cache-Control, X-CSRF-Token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (origin && secureAllowedOrigins.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

function addSecureCorsHeaders(response: NextResponse, request: Request): NextResponse {
  Object.entries(secureCorsHeaders(request.headers.get('origin'))).forEach(([key, value]) => {
    response.headers.set(key, value);
  });
  return response;
}

export function createSecureCorsResponse(data: unknown, request: Request, status = 200): NextResponse {
  return addSecureCorsHeaders(NextResponse.json(data, { status }), request);
}

export function createSecureCorsErrorResponse(error: string, request: Request, status = 500): NextResponse {
  return addSecureCorsHeaders(NextResponse.json({ error }, { status }), request);
}

export function createSecureCorsOptionsResponse(request: Request): NextResponse {
  return new NextResponse(null, {
    status: 200,
    headers: secureCorsHeaders(request.headers.get('origin')),
  });
}
