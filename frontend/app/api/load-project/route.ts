import { NextRequest, NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { google } from 'googleapis';

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession(request);
    if (!session?.accessToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');

    if (!projectId) {
      return NextResponse.json({ error: 'Project ID required' }, { status: 400 });
    }

    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: session.accessToken });

    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const fileResponse = await drive.files.get({
      fileId: projectId,
      alt: 'media',
    });

    const projectData = JSON.parse(fileResponse.data as string);

    const metadataResponse = await drive.files.get({
      fileId: projectId,
      fields: 'id, name, createdTime, modifiedTime, size',
    });

    return NextResponse.json({
      success: true,
      projectData,
      metadata: {
        id: metadataResponse.data.id,
        name: metadataResponse.data.name,
        createdTime: metadataResponse.data.createdTime,
        modifiedTime: metadataResponse.data.modifiedTime,
        size: metadataResponse.data.size,
      },
    });

  } catch (error) {
    console.error('Load project error:', error);
    return NextResponse.json(
      { error: 'Failed to load project', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
} 