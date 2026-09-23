import { NextResponse } from 'next/server';
import { getGalileoCatalog } from '../../../lib/galileo/catalog.server';
import { addGalileoAvailability } from '../../../lib/galileo/availability.server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const catalog = addGalileoAvailability(await getGalileoCatalog(new URL(request.url).searchParams.get('refresh') === '1'));
  return NextResponse.json(catalog, {
    status: catalog.state === 'unavailable' ? 503 : 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}