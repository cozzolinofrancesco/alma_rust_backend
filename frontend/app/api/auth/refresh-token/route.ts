import type { NextRequest } from "next/server";
import { JWT, encode } from "next-auth/jwt";
import { refreshAccessToken } from "../../../lib/refreshAccessToken";
import { createCorsResponse, createCorsErrorResponse, createCorsOptionsResponse } from "../../../lib/cors";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const refreshToken = body?.refreshToken;
    if (typeof refreshToken !== 'string' || !refreshToken.trim()) {
      return createCorsErrorResponse("Refresh token is required", 400);
    }

    const token: Partial<JWT> = { refreshToken };
    const refreshed = await refreshAccessToken(token as JWT);

    if (refreshed.error || !refreshed.accessToken) {
      return createCorsErrorResponse("Failed to refresh token", 400);
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

    const response = createCorsResponse({
      accessToken: refreshed.accessToken,
      sessionToken: sessionToken,
      accessTokenExpires: refreshed.accessTokenExpires,
    });
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
    return createCorsErrorResponse("Failed to refresh token", 500);
  }
}

export async function OPTIONS() {
  return createCorsOptionsResponse();
}
