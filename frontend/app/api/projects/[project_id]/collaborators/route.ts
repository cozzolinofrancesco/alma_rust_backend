import { NextResponse } from 'next/server';
import { drive_v3, google } from 'googleapis';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { z } from 'zod';

export const runtime = 'nodejs';

interface RouteParams {
  project_id: string;
}

const addCollaboratorSchema = z.object({
  email: z.string().email(),
  role: z.enum(['reader', 'writer']).optional(),
});

const buildDrive = (accessToken: string, refreshToken?: string) => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  return google.drive({ version: 'v3', auth: oauth2Client });
};

export async function GET(
  request: Request,
  { params }: { params: Promise<RouteParams> }
): Promise<Response> {
  try {
    const { project_id } = await params;

    const session = await getApiSession(request);
    if (!session?.accessToken) {
      return NextResponse.json({ error: 'User not authenticated' }, { status: 401 });
    }

    const drive = buildDrive(session.accessToken, session.refreshToken);

    const permissionsRes = await drive.permissions.list({
      fileId: project_id,
      fields: 'permissions(id,emailAddress,role,type)',
      supportsAllDrives: true,
    });

    const collaborators = (permissionsRes.data.permissions ?? [])
      .filter((perm) => perm.type === 'user' && Boolean(perm.emailAddress))
      .map((perm) => ({ email: perm.emailAddress as string, role: perm.role ?? 'reader' }));

    return NextResponse.json({ collaborators });
  } catch (error) {
    console.error('Error listing collaborators:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<RouteParams> }
): Promise<Response> {
  try {
    const { project_id } = await params;

    const session = await getApiSession(request);
    if (!session?.accessToken) {
      return NextResponse.json({ error: 'User not authenticated' }, { status: 401 });
    }

    const parsed = addCollaboratorSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
    }
    const { email } = parsed.data;
    const role = parsed.data.role ?? 'reader';

    const drive = buildDrive(session.accessToken, session.refreshToken);

    const permission: drive_v3.Schema$Permission = {
      type: 'user',
      role,
      emailAddress: email,
    };

    await drive.permissions.create({
      fileId: project_id,
      requestBody: permission,
      sendNotificationEmail: true,
      supportsAllDrives: true,
    });

    return NextResponse.json({ success: true, email, role });
  } catch (error) {
    console.error('Error adding collaborator:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
