import { NextRequest, NextResponse } from 'next/server';
import { google } from 'googleapis';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { z } from 'zod';

const requestSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
});

function extractVersion(raw: unknown): string | null {
  if (raw && typeof raw === 'object' && 'version' in raw) {
    const v = (raw as { version?: unknown }).version;
    return typeof v === 'string' ? v : null;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as { version?: unknown };
      return typeof parsed.version === 'string' ? parsed.version : null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function POST(request: NextRequest) {
  const session = await getApiSession(request);
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'ids[] is required' }, { status: 400 });
  }
  const { ids } = parsed.data;

  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: session.accessToken });
  const drive = google.drive({ version: 'v3', auth });

  const entries = await Promise.all(
    ids.map(async (id) => {
      try {
        const res = await drive.files.get({ fileId: id, alt: 'media', supportsAllDrives: true });
        return [id, extractVersion(res.data)] as const;
      } catch {
        return [id, null] as const;
      }
    })
  );

  return NextResponse.json({ versions: Object.fromEntries(entries) });
}
