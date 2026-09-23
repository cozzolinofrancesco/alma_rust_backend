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