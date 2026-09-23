import { NextRequest, NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { google } from 'googleapis';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession(request);
    
    if (!session?.accessToken) {
      return NextResponse.json(
        { found: false, message: 'Authentication required. Please sign in with Google.' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { fileName, filePath, projectId } = body;

    if (!fileName && !filePath) {
      return NextResponse.json(
        { found: false, message: 'fileName or filePath is required' },
        { status: 400 }
      );
    }

    const searchName = fileName || extractFileName(filePath);
    
    if (!searchName) {
      return NextResponse.json(
        { found: false, message: 'Could not determine file name to search' },
        { status: 400 }
      );
    }

    console.log(`🔍 [Bibliography Verify] Searching for file: ${searchName}`);

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID!,
      process.env.GOOGLE_CLIENT_SECRET!,
      process.env.GOOGLE_REDIRECT_URI!
    );
    oauth2Client.setCredentials({
      access_token: session.accessToken,
      refresh_token: session.refreshToken!,
    });

    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    let searchQuery = `name='${searchName.replace(/'/g, "\\'")}' and trashed=false`;
    
    if (projectId) {
      searchQuery = `name='${searchName.replace(/'/g, "\\'")}' and '${projectId}' in parents and trashed=false`;
    }

    const exactResponse = await drive.files.list({
      q: searchQuery,
      fields: 'files(id, name, mimeType, webViewLink, modifiedTime, size)',
      pageSize: 5,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    if (exactResponse.data.files && exactResponse.data.files.length > 0) {
      const file = exactResponse.data.files[0];
      console.log(`✅ [Bibliography Verify] Found exact match: ${file.name} (${file.id})`);
      return NextResponse.json({
        found: true,
        fileId: file.id,
        fileName: file.name,
        mimeType: file.mimeType,
        webViewLink: file.webViewLink,
        modifiedTime: file.modifiedTime,
        size: file.size,
        message: `File found in Google Drive`,
        matchType: 'exact'
      });
    }

    const containsQuery = `name contains '${searchName.replace(/'/g, "\\'").replace(/\.pdf$/i, '')}' and trashed=false`;
    const containsResponse = await drive.files.list({
      q: containsQuery,
      fields: 'files(id, name, mimeType, webViewLink, modifiedTime, size)',
      pageSize: 10,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    if (containsResponse.data.files && containsResponse.data.files.length > 0) {
      const files = containsResponse.data.files;
      console.log(`🔶 [Bibliography Verify] Found ${files.length} partial matches for: ${searchName}`);
      return NextResponse.json({
        found: true,
        fileId: files[0].id,
        fileName: files[0].name,
        mimeType: files[0].mimeType,
        webViewLink: files[0].webViewLink,
        modifiedTime: files[0].modifiedTime,
        size: files[0].size,
        message: `Found similar file: "${files[0].name}"`,
        matchType: 'partial',
        alternatives: files.slice(1, 5).map(f => ({ id: f.id, name: f.name }))
      });
    }

    console.log(`❌ [Bibliography Verify] File not found: ${searchName}`);
    
    const isGDrive = isGoogleDrivePath(filePath);
    const isLocal = isPureLocalPath(filePath);
    
    if (isGDrive) {
      return NextResponse.json({
        found: false,
        pathType: 'gdrive',
        message: `File "${searchName}" not found in your Google Drive. Please check the file name or ensure the file is in your Drive.`,
        searchedName: searchName
      });
    } else if (isLocal) {
      return NextResponse.json({
        found: false,
        pathType: 'local',
        message: `"${searchName}" appears to be a local file path. We searched Google Drive but didn't find it. If this is a local-only file, please verify it exists on your machine.`,
        searchedName: searchName,
        note: 'Browser security prevents direct local filesystem access. Upload the file to Google Drive for full verification.'
      });
    } else {
      return NextResponse.json({
        found: false,
        pathType: 'unknown',
        message: `File "${searchName}" not found in Google Drive. Please upload it or check the file name.`,
        searchedName: searchName
      });
    }

  } catch (error) {
    console.error('❌ [Bibliography Verify] Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    return NextResponse.json(
      { found: false, message: `Verification failed: ${message}` },
      { status: 500 }
    );
  }
}

function extractFileName(filePath: string): string | null {
  if (!filePath) return null;

  const normalizedPath = filePath.replace(/\\/g, '/');
  
  const segments = normalizedPath.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  
  const lastSegment = segments[segments.length - 1];
  
  if (lastSegment.includes('.')) {
    return lastSegment;
  }
  
  return lastSegment;
}

function isGoogleDrivePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.includes('my drive') ||
    lower.includes('google drive') ||
    lower.includes('drive.google.com') ||
    lower.includes('shared drives') ||
    lower.includes('shared with me')
  );
}

function isPureLocalPath(filePath: string): boolean {
  if (isGoogleDrivePath(filePath)) return false;
  
  if (filePath.match(/^[A-Z]:\\/)) return true;
  
  if (filePath.startsWith('/Users/') || filePath.startsWith('/home/')) return true;
  
  return false;
}

