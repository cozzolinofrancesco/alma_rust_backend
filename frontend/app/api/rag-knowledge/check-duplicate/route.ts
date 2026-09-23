import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { google } from 'googleapis';

export async function POST(request: Request) {
  try {
    const session = await getApiSession(request);
    
    if (!session?.accessToken) {
      return NextResponse.json(
        { error: 'Authentication required. Please sign in with Google.' },
        { status: 401 }
      );
    }

    const { fileName } = await request.json();
    
    if (!fileName) {
      return NextResponse.json(
        { error: 'fileName is required' },
        { status: 400 }
      );
    }

    const auth = new google.auth.OAuth2();
    auth.setCredentials({
      access_token: session.accessToken,
      refresh_token: session.refreshToken
    });

    const drive = google.drive({ version: 'v3', auth });
    
    const baseName = fileName.replace(/\.pdf$/i, '');
    const folderName = `${baseName}_Chunks`;
    
    console.log(`🔍 [RAG Check] Checking for duplicate: ${folderName}`);

    const response = await drive.files.list({
      q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name, createdTime)'
    });

    const existingFolders = response.data.files || [];
    
    if (existingFolders.length > 0) {
      const existingFolder = existingFolders[0];
      console.log(`⚠️ [RAG Check] Duplicate found: ${folderName} (ID: ${existingFolder.id})`);
      
      return NextResponse.json({
        exists: true,
        folderName: folderName,
        folderId: existingFolder.id,
        createdTime: existingFolder.createdTime,
        message: `A RAG knowledge folder for "${fileName}" already exists.`
      });
    } else {
      console.log(`✅ [RAG Check] No duplicate found for: ${folderName}`);
      
      return NextResponse.json({
        exists: false,
        folderName: folderName,
        message: `No existing RAG knowledge folder found for "${fileName}".`
      });
    }

  } catch (error) {
    console.error('❌ [RAG Check] Error checking for duplicate:', error);
    return NextResponse.json(
      { 
        error: 'Failed to check for duplicate knowledge folder',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
