import { NextResponse } from 'next/server';

export async function POST(): Promise<NextResponse> {
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
