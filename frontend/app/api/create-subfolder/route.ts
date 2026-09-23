import { NextResponse } from 'next/server';
import { google, drive_v3 } from 'googleapis';
import { getApiSession } from '@/app/lib/apiCaller.server';

const errorResponse = (message: string, status: number = 500) =>
  NextResponse.json({ error: message }, { status });

interface CreateSubfolderPayload {
  projectId?: string;
  parentFolderId: string;
  subfolderName: string;
}

export const config = { api: { bodyParser: true } };

async function createSubfolder(
  drive: drive_v3.Drive,
  parentFolderId: string,
  subfolderName: string
): Promise<drive_v3.Schema$File> {
  const metadata: drive_v3.Params$Resource$Files$Create['requestBody'] = {
    name: subfolderName,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentFolderId],
  };
  const res = await drive.files.create({
    requestBody: metadata,
    fields: 'id,name,parents',
  });
  return res.data;
}

export async function POST(request: Request) {
  try {
    const session = await getApiSession(request);
    if (!session?.accessToken) {
      return errorResponse('Not authenticated', 401);
    }
    const { accessToken, refreshToken } = session;

    const { parentFolderId, subfolderName } = (await request.json()) as CreateSubfolderPayload;
    if (!parentFolderId) {
      return errorResponse('parentFolderId is required', 400);
    }
    if (!subfolderName?.trim()) {
      return errorResponse('subfolderName is required', 400);
    }

    if (!/^[A-Za-z0-9_-]+$/.test(parentFolderId)) {
      return errorResponse('Invalid parentFolderId format', 400);
    }
    const sanitizedName = subfolderName.trim().replace(/[^\w -]/g, '');
    if (!sanitizedName) {
      return errorResponse('Invalid subfolder name after sanitization', 400);
    }

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID!,
      process.env.GOOGLE_CLIENT_SECRET!,
      process.env.GOOGLE_REDIRECT_URI!
    );
    oauth2Client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const query = `'${parentFolderId}' in parents and name='${sanitizedName}' and mimeType='application/vnd.google-apps.folder'`;
    const existing = await drive.files.list({ q: query, fields: 'files(id,name)' });
    if (existing.data.files?.length) {
      const file = existing.data.files[0];
      return NextResponse.json({
        subfolder_id: file.id!,
        subfolder_name: file.name!,
        parent_folder_id: parentFolderId,
        message: 'Subfolder already exists and was skipped.',
      });
    }

    const subfolder = await createSubfolder(drive, parentFolderId, sanitizedName);
    if (!subfolder.id) {
      return errorResponse('Failed to create subfolder', 500);
    }

    return NextResponse.json({
      subfolder_id: subfolder.id,
      subfolder_name: subfolder.name,
      parent_folder_id: parentFolderId,
      message: 'Subfolder created successfully!',
    });
  } catch (err) {
    console.error('Error creating subfolder:', err);
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return errorResponse(msg, 500);
  }
}
