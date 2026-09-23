import { NextRequest } from 'next/server';
import { google } from 'googleapis';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { createCorsOptionsResponse, createCorsResponse, createCorsErrorResponse } from "../../../../../../../lib/cors";

export async function OPTIONS() {
  return createCorsOptionsResponse();
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ project_id: string; folder_name: string; file_id: string }> }
) {
  try {

    const { project_id, folder_name, file_id } = await params;
    
    console.log(`🔍 API: Fetching file ${file_id} from folder ${folder_name} in project ${project_id}`);
    
    const session = await getApiSession(request);
    if (!session?.accessToken) return createCorsErrorResponse('Unauthorized', 401);
    const accessToken = session.accessToken;
    
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    const drive = google.drive({ version: 'v3', auth });

    const response = await drive.files.get({
      fileId: file_id,
      alt: 'media',
      supportsAllDrives: true,
    });

    let content = response.data;
    if (typeof content === 'string') {
      try {
        content = JSON.parse(content);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (parseError) {
        console.log('File is not JSON, returning as string');
      }
    }

    return createCorsResponse(content);

  } catch (error) {
    console.error('Error fetching file:', error);
    
    const { file_id: errorFileId } = await params;
    
    let errorMessage = 'Failed to fetch file';
    let statusCode = 500;
    
    if (error && typeof error === 'object' && 'code' in error) {
      const googleError = error as { code: number; message: string };
      switch (googleError.code) {
        case 401:
          errorMessage = 'Authentication failed - token may be expired';
          statusCode = 401;
          break;
        case 403:
          errorMessage = 'Access denied - insufficient permissions';
          statusCode = 403;
          break;
        case 404:
          errorMessage = 'File not found';
          statusCode = 404;
          break;
        case 429:
          errorMessage = 'Rate limit exceeded';
          statusCode = 429;
          break;
        default:
          errorMessage = `Google Drive API error: ${googleError.message}`;
      }
    }
    
    console.error(`Detailed error for file ${errorFileId}:`, {
      message: errorMessage,
      code: statusCode,
      originalError: error
    });
    
    return createCorsErrorResponse(errorMessage, statusCode);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ project_id: string; folder_name: string; file_id: string }> }
) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { project_id, folder_name, file_id } = await params;
    
    const session = await getApiSession(request);
    if (!session?.accessToken) {
      return createCorsErrorResponse('Unauthorized', 401);
    }

    const accessToken = session.accessToken;
    
    const formData = await request.formData();
    const file = formData.get('file') as File;
    
    if (!file) {
      return createCorsErrorResponse('No file provided', 400);
    }

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    const drive = google.drive({ version: 'v3', auth });

    const buffer = Buffer.from(await file.arrayBuffer());

    const response = await drive.files.update({
      fileId: file_id,
      media: {
        mimeType: file.type,
        body: buffer,
      },
      supportsAllDrives: true,
    });

    return createCorsResponse({
      message: 'File updated successfully',
      fileId: response.data.id,
    });

  } catch (error) {
    console.error('Error updating file:', error);
    return createCorsErrorResponse('Failed to update file', 500);
  }
} 