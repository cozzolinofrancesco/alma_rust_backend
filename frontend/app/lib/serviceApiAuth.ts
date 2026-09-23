const SERVICE_API_KEY = process.env.SERVICE_API_KEY;

export type ServiceAuthResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

export function authorizeServiceRequest(request: Request, bodyApiKey?: string): ServiceAuthResult {
  const userApiKey = request.headers.get('x-api-key') || bodyApiKey || '';

  if (!userApiKey) {
    return {
      ok: false,
      status: 401,
      error: 'API key is required. Provide it in the request body as "api_key" or in the "x-api-key" header.',
    };
  }

  if (!SERVICE_API_KEY || userApiKey !== SERVICE_API_KEY) {
    return { ok: false, status: 401, error: 'Invalid API key provided.' };
  }

  return { ok: true };
}
