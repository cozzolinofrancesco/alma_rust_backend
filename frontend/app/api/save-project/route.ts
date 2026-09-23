import { NextRequest, NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { google } from 'googleapis';

interface SaveProjectPayload {
  projectName: string;
  projectData: {
    projectName: string;
    currentVersion: string;
    createdAt: string;
    entries: unknown[];
    settings?: Record<string, unknown>;
  };
  projectId: string;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession(request);
    if (!session?.accessToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { projectName, projectData, projectId } = await request.json() as SaveProjectPayload;

    if (!projectId) {
      return NextResponse.json({ 
        error: 'No project selected. Please select a project from the Projects page first.' 
      }, { status: 400 });
    }

    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: session.accessToken });

    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const rootId = projectId;

    const json3dSearch = await drive.files.list({
      q: `name='json3dprojects' and parents='${rootId}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)',
    });

    let json3dFolderId: string;
    if ((json3dSearch.data.files?.length ?? 0) === 0) {
      const createFolder = await drive.files.create({
        requestBody: {
          name: 'json3dprojects',
          mimeType: 'application/vnd.google-apps.folder',
          parents: [rootId],
        },
        fields: 'id',
      });
      json3dFolderId = createFolder.data.id!;
    } else {
      json3dFolderId = json3dSearch.data.files![0].id!;
    }

    const stlSearch = await drive.files.list({
      q: `name='stl' and parents='${rootId}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)',
    });

    if ((stlSearch.data.files?.length ?? 0) === 0) {
      await drive.files.create({
        requestBody: {
          name: 'stl',
          mimeType: 'application/vnd.google-apps.folder',
          parents: [rootId],
        },
        fields: 'id',
      });
    }

    const baseFileName = `${projectName.replace(/[^a-zA-Z0-9-_]/g, '_')}.json`;
    
    const existingFilesSearch = await drive.files.list({
      q: `name='${baseFileName}' and parents='${json3dFolderId}' and trashed=false`,
      fields: 'files(id, name)',
    });

    const fileContent = JSON.stringify(projectData, null, 2);

    let savedFile;
    if ((existingFilesSearch.data.files?.length ?? 0) > 0) {
      const existingFileId = existingFilesSearch.data.files![0].id!;
      
      const media = {
        mimeType: 'application/json',
        body: fileContent,
      };

      savedFile = await drive.files.update({
        fileId: existingFileId,
        media: media,
        fields: 'id, name, modifiedTime',
      });
    } else {
      const fileMetadata = {
        name: baseFileName,
        parents: [json3dFolderId],
      };

      const media = {
        mimeType: 'application/json',
        body: fileContent,
      };

      savedFile = await drive.files.create({
        requestBody: fileMetadata,
        media: media,
        fields: 'id, name, createdTime',
      });
    }

    return NextResponse.json({
      success: true,
      fileId: savedFile.data.id,
      fileName: savedFile.data.name,
      updatedFile: (existingFilesSearch.data.files?.length ?? 0) > 0,
      timestamp: savedFile.data.modifiedTime || savedFile.data.createdTime,
      foldersCreated: {
        json3dprojects: (json3dSearch.data.files?.length ?? 0) === 0,
        stl: (stlSearch.data.files?.length ?? 0) === 0,
      },
    });

  } catch (error) {
    console.error('Save project error:', error);
    return NextResponse.json(
      { error: 'Failed to save project', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
} 