import { getServerSession } from 'next-auth/next';
import { authOptions } from '../../lib/authOptions';
import { authorizeServiceRequest } from '../../lib/serviceApiAuth';
import { galileoFailureResponse, galileoPreflightResponse } from '../../lib/galileo/preflight.server';
import { readGalileoStepRequest } from '../../lib/galileo/stepRequest.server';
import { galileoStepResponse } from '../../lib/galileo/step.server';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session && !authorizeServiceRequest(request).ok) return galileoFailureResponse('SESSION_REQUIRED');
  return galileoPreflightResponse(new URL(request.url).searchParams.get('model'));
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session && !authorizeServiceRequest(request).ok) return galileoFailureResponse('SESSION_REQUIRED');

  try {
    const { raw, files } = await readGalileoStepRequest(request);
    return galileoStepResponse(raw, files, session, request.signal);
  } catch {
    return galileoFailureResponse('INVALID_STEP_REQUEST');
  }
}