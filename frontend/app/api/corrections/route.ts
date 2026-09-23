import { createCorsErrorResponse, createCorsOptionsResponse, createCorsResponse } from '../../lib/cors';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const fromDate = searchParams.get('fromDate') ?? undefined;
  const toDate = searchParams.get('toDate') ?? undefined;
  const cfrRef = searchParams.get('cfrRef') ?? undefined;

  const params = new URLSearchParams();

  const dateParam = toDate || fromDate;
  if (dateParam) {
    params.set('date', dateParam);
  }

  if (cfrRef) {
    if (/^\d+$/.test(cfrRef)) {
      params.set('title', cfrRef);
    } else {
      params.set('cfr_reference', cfrRef);
    }
  }

  try {
    const apiRes = await fetch(
      `https://www.ecfr.gov/api/admin/v1/corrections.json?${params.toString()}`,
      { cache: 'no-store' }
    );

    let body: unknown;
    try {
      body = await apiRes.json();
    } catch {
      const textBody = await apiRes.text();
      return createCorsErrorResponse(
        `ECFR API Error: ${apiRes.status} - ${textBody}`,
        apiRes.status
      );
    }

    if (!apiRes.ok) {
      return createCorsResponse(body, apiRes.status);
    }

    return createCorsResponse(body);
  } catch (err: unknown) {
    return createCorsErrorResponse(
      err instanceof Error ? err.message : 'Unknown proxy error',
      500
    );
  }
}

export async function OPTIONS() {
  return createCorsOptionsResponse();
}
