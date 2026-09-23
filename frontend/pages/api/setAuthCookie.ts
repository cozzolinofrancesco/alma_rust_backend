// pages/api/setAuthCookie.ts

import type { NextApiRequest, NextApiResponse } from 'next';
import cookie from 'cookie';
import { corsHeaders } from '../../app/lib/cors';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  // Set consistent CORS headers
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Allow only GET requests for this endpoint (modify if needed)
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Only GET method is allowed' });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'No Authorization header provided' });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res
      .status(400)
      .json({ error: 'Invalid Authorization header format' });
  }

  const token = parts[1];

  // Set the cookie with the token in the "Authorization2" header format.
  res.setHeader(
    'Set-Cookie',
    cookie.serialize('Authorization', `Bearer ${token}`, {
      httpOnly: true, // Makes cookie inaccessible to client-side JavaScript.
      secure: process.env.NODE_ENV === 'production', // Only send cookie over HTTPS in production.
      maxAge: 60 * 60 * 24 * 7, // 1 week
      path: '/',
      sameSite: 'strict',
    })
  );

  return res.status(200).json({ message: 'Cookie set successfully' });
}
