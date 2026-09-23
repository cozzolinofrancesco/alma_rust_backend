// app/api/rust-demo/route.ts
// -----------------------------------------------------------------------------
// Demonstrates the Next.js app actually calling the alma_2 Rust backend through
// the typed client in app/lib/almaRustApi.ts. Hitting GET /api/rust-demo makes a
// live server-side request to the Rust API and relays what it returns.
// -----------------------------------------------------------------------------
import { NextResponse } from 'next/server';
import almaRust, { agentnodes, templatesPolicy } from '@/app/lib/almaRustApi';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    // Two real, parameter-free calls against the Rust backend.
    const [capabilities, studyTypes] = await Promise.all([
      agentnodes.capabilities(),
      templatesPolicy.listStudyTypes(),
    ]);

    return NextResponse.json({
      usingBackend: almaRust.baseUrl,
      capabilities,
      studyTypes,
    });
  } catch (error) {
    return NextResponse.json(
      { usingBackend: almaRust.baseUrl, error: (error as Error).message },
      { status: 502 },
    );
  }
}
