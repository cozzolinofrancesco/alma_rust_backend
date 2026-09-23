import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import { getApiSession } from '@/app/lib/apiCaller.server';

export const runtime = 'nodejs';

interface RouteParams {
  project_id: string;
  file_id: string;
}

interface FileResponse {
  file_id: string;
  project_id: string;
  content?: string;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<RouteParams> }
): Promise<Response> {
  try {
    const { project_id, file_id } = await params;

    const session = await getApiSession(request);
    if (!session || !session.accessToken) {
      return NextResponse.json({ error: 'User not authenticated' }, { status: 401 });
    }
    const { accessToken, refreshToken } = session;

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const fileRes = await drive.files.get(
      {
        fileId: file_id,
        alt: 'media',
        supportsAllDrives: true,
      },
      { responseType: 'arraybuffer' }
    );

    let content = '';
    if (fileRes.data) {
      const buffer = new Uint8Array(fileRes.data as ArrayBuffer);
      content = new TextDecoder('utf-8').decode(buffer);
    }

    const responseBody: FileResponse = {
      file_id,
      project_id,
      content,
    };
    return NextResponse.json(responseBody);
  } catch (error: unknown) {
    console.error('Error retrieving file:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<RouteParams> }
): Promise<Response> {
  try {
    const { project_id, file_id } = await params;

    const session = await getApiSession(request);
    if (!session || !session.accessToken) {
      return NextResponse.json({ error: 'User not authenticated' }, { status: 401 });
    }
    const { accessToken, refreshToken } = session;

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const formData = await request.formData();
    const file = formData.get('file') as File;
    
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const updateResponse = await drive.files.update({
      fileId: file_id,
      media: {
        mimeType: 'application/json',
        body: buffer,
      },
      supportsAllDrives: true,
    });

    return NextResponse.json({
      success: true,
      file_id,
      project_id,
      updated: new Date().toISOString(),
      driveResponse: updateResponse.data
    });

  } catch (error: unknown) {
    console.error('Error updating file:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<RouteParams> }
): Promise<Response> {
  try {
    const { project_id, file_id } = await params;

    const session = await getApiSession(request);
    if (!session || !session.accessToken) {
      return NextResponse.json({ error: 'User not authenticated' }, { status: 401 });
    }
    const { accessToken, refreshToken } = session;

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const body = await request.json();
    const { name } = body;
    if (!name) {
      return NextResponse.json({ error: 'No name provided' }, { status: 400 });
    }

    const cleanedName = name.trim();
    const finalName = cleanedName.toLowerCase().endsWith('.json') ? cleanedName : `${cleanedName}.json`;

    const updateResponse = await drive.files.update({
      fileId: file_id,
      requestBody: {
        name: finalName,
      },
      supportsAllDrives: true,
    });

    return NextResponse.json({
      success: true,
      file_id,
      project_id,
      newName: finalName,
      driveResponse: updateResponse.data,
    });

  } catch (error: unknown) {
    console.error('Error renaming file:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
