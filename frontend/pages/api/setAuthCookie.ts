// pages/api/setAuthCookie.ts

import type { NextApiRequest, NextApiResponse } from 'next';
import { corsHeaders } from '../../app/lib/cors';

// FE-AUTH-002 (Part B): this endpoint previously wrote an `Authorization: Bearer
// <token>` httpOnly cookie taken verbatim from the request header, with no
// validation against the session. That cookie had no readers anywhere in the app
// (confirmed dead write) and enabled cookie fixation, so the write has been
// removed. The endpoint only validates the Bearer header shape and is otherwise
// a no-op — kept so its public route contract does not break.
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

  // No cookie is written — see the FE-AUTH-002 note above.
  return res.status(200).json({ message: 'OK' });
}
