import { google } from 'googleapis';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ShareAgentEmailRequest {
  to: string;
  subject: string;
  message: string;
  attachmentFileName: string;
  attachmentJson: string;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function sanitizeHeaderValue(value: string): string {
  return (value || '').replace(/[\r\n]+/g, ' ').trim();
}

function buildRawEmail(opts: {
  fromEmail?: string;
  to: string[];
  subject: string;
  message: string;
  attachmentFileName: string;
  attachmentJson: string;
}): string {
  const boundary = `boundary_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const from = opts.fromEmail ? `Me <${opts.fromEmail}>` : 'Me';

  const headers = [
    `From: ${sanitizeHeaderValue(from)}`,
    `To: ${sanitizeHeaderValue(opts.to.join(', '))}`,
    `Subject: ${sanitizeHeaderValue(opts.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    opts.message || '',
    '',
    `--${boundary}`,
    'Content-Type: application/json; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${sanitizeHeaderValue(opts.attachmentFileName)}"`,
    '',
  ];

  const attachmentBase64 = Buffer.from(opts.attachmentJson, 'utf8').toString('base64');
  const footer = ['', `--${boundary}--`, ''];

  return [...headers, attachmentBase64, ...footer].join('\r\n');
}

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession(request);
    if (!session?.accessToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json()) as ShareAgentEmailRequest;
    const toRaw = (body.to || '').trim();
    const subject = (body.subject || '').trim();
    const message = body.message || '';
    const attachmentFileName = (body.attachmentFileName || 'agent.json').trim() || 'agent.json';
    const attachmentJson = body.attachmentJson || '';

    if (!toRaw) {
      return NextResponse.json({ error: 'Missing "to" recipients' }, { status: 400 });
    }
    if (!subject) {
      return NextResponse.json({ error: 'Missing subject' }, { status: 400 });
    }
    if (!attachmentJson) {
      return NextResponse.json({ error: 'Missing attachment JSON' }, { status: 400 });
    }

    const approxBytes = Buffer.byteLength(attachmentJson, 'utf8');
    if (approxBytes > 7 * 1024 * 1024) {
      return NextResponse.json({ error: 'Attachment too large' }, { status: 413 });
    }

    const toList = toRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID!,
      process.env.GOOGLE_CLIENT_SECRET!,
      process.env.GOOGLE_REDIRECT_URI!
    );
    oauth2Client.setCredentials({
      access_token: session.accessToken,
      refresh_token: session.refreshToken,
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const rawEmail = buildRawEmail({
      fromEmail: session.user?.email ?? undefined,
      to: toList,
      subject,
      message,
      attachmentFileName,
      attachmentJson,
    });

    const raw = base64UrlEncode(rawEmail);
    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });

    return NextResponse.json({
      success: true,
      messageId: res.data.id,
      threadId: res.data.threadId,
    });
  } catch (error) {
    console.error('Failed to send email via Gmail API:', error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

