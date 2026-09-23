import { NextRequest, NextResponse } from 'next/server';
import { google } from 'googleapis';
import { createCorsOptionsResponse, addCorsHeaders, createCorsErrorResponse } from "../../../../../../../../lib/cors";
import { getApiSession } from '@/app/lib/apiCaller.server';

export async function OPTIONS() {
  return createCorsOptionsResponse();
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ project_id: string; folder_name: string; file_id: string }> }
) {
  try {

    const { project_id, folder_name, file_id } = await params;
    
    console.log(`🔍 Download API: Fetching file ${file_id} from folder ${folder_name} in project ${project_id}`);
    
    const session = await getApiSession(request);
    if (!session?.accessToken) return createCorsErrorResponse('Unauthorized', 401);
    const accessToken = session.accessToken;

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    const drive = google.drive({ version: 'v3', auth });

    console.log(`📋 Download API: Getting file metadata for ${file_id}`);
    
    const fileMetadata = await drive.files.get({
      fileId: file_id,
      fields: 'name, mimeType, size',
      supportsAllDrives: true,
    });

    const fileName = fileMetadata.data.name || 'unknown';
    const mimeType = fileMetadata.data.mimeType || 'application/octet-stream';
    const fileSize = fileMetadata.data.size;

    console.log(`📄 Download API: File details - Name: ${fileName}, Type: ${mimeType}, Size: ${fileSize} bytes`);

    const isGoogleWorkspaceFile = mimeType.startsWith('application/vnd.google-apps.');
    
    let response;
    let exportMimeType = mimeType;

    if (isGoogleWorkspaceFile) {
      if (mimeType === 'application/vnd.google-apps.folder') {
        console.log(`📁 Download API: Folder detected - cannot download`);
        return createCorsErrorResponse('Folders cannot be previewed. Please browse the folder contents instead.', 400);
      } else if (mimeType === 'application/vnd.google-apps.form') {
        console.log(`📝 Download API: Google Form detected - cannot preview`);
        return createCorsErrorResponse('Google Forms cannot be previewed in this interface.', 400);
      } else if (mimeType === 'application/vnd.google-apps.site') {
        console.log(`🌐 Download API: Google Site detected - cannot preview`);
        return createCorsErrorResponse('Google Sites cannot be previewed in this interface.', 400);
      } else if (mimeType === 'application/vnd.google-apps.map') {
        console.log(`🗺️ Download API: Google Map detected - cannot preview`);
        return createCorsErrorResponse('Google Maps cannot be previewed in this interface.', 400);
      }

      console.log(`📤 Download API: Exporting Google Workspace file: ${fileName} (${mimeType})`);
      
      if (mimeType === 'application/vnd.google-apps.document') {
        exportMimeType = 'application/pdf';
      } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
        exportMimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      } else if (mimeType === 'application/vnd.google-apps.presentation') {
        exportMimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      } else if (mimeType === 'application/vnd.google-apps.drawing') {
        exportMimeType = 'application/pdf';
      } else {
        console.error(`❌ Download API: Unsupported Google Workspace file type: ${mimeType}`);
        return createCorsErrorResponse(`Unsupported Google Workspace file type: ${mimeType}`, 400);
      }

      console.log(`🔄 Download API: Exporting ${mimeType} as ${exportMimeType}`);
      response = await drive.files.export({
        fileId: file_id,
        mimeType: exportMimeType,
      }, {
        responseType: 'stream'
      });
    } else {
      console.log(`📥 Download API: Downloading binary file: ${fileName} (${mimeType})`);
      response = await drive.files.get({
        fileId: file_id,
        alt: 'media',
        supportsAllDrives: true,
      }, {
        responseType: 'stream'
      });
    }

    console.log(`✅ Download API: Google Drive API call successful, processing stream...`);

    const chunks: Buffer[] = [];
    const stream = response.data as NodeJS.ReadableStream;
    
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    
    const buffer = Buffer.concat(chunks);

    console.log(`📦 Download API: Stream processed, buffer size: ${buffer.length} bytes`);

    const downloadResponse = new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': exportMimeType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': buffer.length.toString(),
      },
    });

    console.log(`🎉 Download API: Successfully returning file ${fileName}`);
    return addCorsHeaders(downloadResponse);

  } catch (error) {
    console.error('❌ Download API: Error downloading file:', error);
    
    let errorMessage = 'Failed to download file';
    let statusCode = 500;
    
    if (error instanceof Error) {
      const errorString = error.message;
      console.error('❌ Download API: Error details:', errorString);
      
      if (errorString.includes('invalid_grant') || errorString.includes('Invalid Credentials')) {
        errorMessage = 'Authentication token expired. Please refresh the page and try again.';
        statusCode = 401;
      } else if (errorString.includes('insufficient_scope')) {
        errorMessage = 'Insufficient permissions to access this file. Please re-authenticate.';
        statusCode = 403;
      } else if (errorString.includes('rate_limit') || errorString.includes('quotaExceeded')) {
        errorMessage = 'API rate limit exceeded. Please try again in a moment.';
        statusCode = 429;
      } else if (errorString.includes('file_not_found') || errorString.includes('File not found') || errorString.includes('notFound')) {
        errorMessage = 'File not found in Google Drive. The file may have been deleted or moved.';
        statusCode = 404;
      } else if (errorString.includes('forbidden') || errorString.includes('Forbidden')) {
        errorMessage = 'Access forbidden. You may not have permission to access this file.';
        statusCode = 403;
      } else if (errorString.includes('invalid_request')) {
        errorMessage = 'Invalid request to Google Drive API. Please try again.';
        statusCode = 400;
      } else {
        errorMessage = `Failed to download file: ${errorString}`;
      }
    }
    
    console.error(`❌ Download API: Returning error - Status: ${statusCode}, Message: ${errorMessage}`);
    return createCorsErrorResponse(errorMessage, statusCode);
  }
} 