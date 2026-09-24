import type { NextRequest } from "next/server";
import { JWT, encode } from "next-auth/jwt";
import { getServerSession } from "next-auth/next";
import { refreshAccessToken } from "../../../lib/refreshAccessToken";
import { authOptions } from "../../../lib/authOptions";
import { createSecureCorsResponse, createSecureCorsErrorResponse, createSecureCorsOptionsResponse } from "../../../lib/cors";

// FE-AUTH-002: this route mints a valid NextAuth sessionToken, so it must never
// be a public, unauthenticated oracle. It now (1) requires an authenticated
// session, (2) rate-limits per identity, and (3) uses strict (non-wildcard) CORS
// so the token body is not readable cross-origin.

// Best-effort in-memory fixed-window rate limit, keyed by the session identity.
// Single-process only (resets on redeploy, not shared across instances) — replace
// with a shared limiter (e.g. Redis) if the BFF is scaled horizontally.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(identity: string): boolean {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(identity);
  if (!bucket || now >= bucket.resetAt) {
    rateLimitBuckets.set(identity, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    const identity = session?.user?.email;
    if (!identity) {
      return createSecureCorsErrorResponse("Authentication required", request, 401);
    }
    if (isRateLimited(identity)) {
      return createSecureCorsErrorResponse("Too many requests", request, 429);
    }

    const body = await request.json();
    const refreshToken = body?.refreshToken;
    if (typeof refreshToken !== 'string' || !refreshToken.trim()) {
      return createSecureCorsErrorResponse("Refresh token is required", request, 400);
    }

    const token: Partial<JWT> = { refreshToken };
    const refreshed = await refreshAccessToken(token as JWT);

    if (refreshed.error || !refreshed.accessToken) {
      return createSecureCorsErrorResponse("Failed to refresh token", request, 400);
    }

    const maxAge = refreshed.accessTokenExpires
      ? Math.floor((refreshed.accessTokenExpires - Date.now()) / 1000)
      : 3600;
    const secret = process.env.NEXTAUTH_SECRET!;
    const sessionToken = await encode({
      token: refreshed as JWT,
      secret,
      maxAge,
    });

    const response = createSecureCorsResponse({
      accessToken: refreshed.accessToken,
      sessionToken: sessionToken,
      accessTokenExpires: refreshed.accessTokenExpires,
    }, request);
    response.headers.set('Cache-Control', 'no-store');

    response.cookies.set("refresh-token", refreshed.refreshToken ?? refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      path: "/",
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30,
    });

    response.cookies.set("access-token", refreshed.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      path: "/",
      sameSite: 'lax',
      maxAge,
    });

    return response;
  } catch (error) {
    console.error("Error in refresh-token endpoint:", error);
    return createSecureCorsErrorResponse("Failed to refresh token", request, 500);
  }
}

export async function OPTIONS(request: NextRequest) {
  return createSecureCorsOptionsResponse(request);
}
