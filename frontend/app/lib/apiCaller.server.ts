import type { Session } from 'next-auth';
import { getServerSession } from 'next-auth/next';
import { z } from 'zod';
import { authOptions } from './authOptions';
import { authorizeServiceRequest } from './serviceApiAuth';

const googleIdentitySchema = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  email_verified: z.literal(true),
  name: z.string().optional(),
});

export async function getApiSession(request: Request): Promise<Session | null> {
  const authorization = request.headers.get('authorization');
  const bearer = authorization ? /^Bearer ([^\s]+)$/i.exec(authorization)?.[1] : undefined;
  if (authorization && (!bearer || bearer.length > 16384)) return null;

  if (!request.headers.has('x-api-key')) {
    const session = await getServerSession(authOptions);
    if (bearer && bearer !== session?.accessToken) return null;
    return session;
  }

  if (!authorizeServiceRequest(request).ok || !bearer) return null;
  try {
    const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
      redirect: 'error',
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const identity = googleIdentitySchema.safeParse(await response.json());
    if (!identity.success) return null;
    return {
      user: { email: identity.data.email.toLowerCase(), name: identity.data.name },
      accessToken: bearer,
      expires: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}