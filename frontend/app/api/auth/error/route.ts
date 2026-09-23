import { NextRequest, NextResponse } from "next/server";

export function GET(request: NextRequest) {
  const dest = request.nextUrl.clone();
  dest.pathname = "/auth/error";
  return NextResponse.redirect(dest);
}
