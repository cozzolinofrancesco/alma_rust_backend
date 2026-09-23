import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import { getServerSession } from "next-auth/next";
import { authOptions } from "../../lib/authOptions";

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    const accessToken = session?.accessToken;
    const refreshToken = session?.refreshToken;
    const userEmail = session?.user?.email;

    if (!accessToken || !userEmail) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    console.log(`🔍 OAUTH-SCOPE-DIAGNOSTIC: Checking permissions for ${userEmail}`);

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID!,
      process.env.GOOGLE_CLIENT_SECRET!,
      process.env.GOOGLE_REDIRECT_URI!
    );

    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
      scope: 'https://www.googleapis.com/auth/drive',
      token_type: 'Bearer',
    });

    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    
    interface DiagnosticTest {
      test: number;
      title: string;
      success: boolean;
      data?: Record<string, unknown>;
      error?: string;
      testedFolderId?: string;
    }

    const diagnostic = {
      userEmail,
      timestamp: new Date().toISOString(),
      tests: [] as DiagnosticTest[]
    };

    console.log(`🔐 TEST 1: Checking token info and granted scopes`);
    try {
      const tokenInfo = await oauth2.tokeninfo({ access_token: accessToken });
      
      diagnostic.tests.push({
        test: 1,
        title: "Token Info & Scopes",
        success: true,
        data: {
          scope: tokenInfo.data.scope,
          grantedScopes: tokenInfo.data.scope?.split(' ') || [],
          audience: tokenInfo.data.audience,
          userId: tokenInfo.data.user_id,
          email: tokenInfo.data.email,
          expiresIn: tokenInfo.data.expires_in
        }
      });

      console.log(`✅ TEST 1: Token valid, scopes: ${tokenInfo.data.scope}`);

    } catch (error) {
      diagnostic.tests.push({
        test: 1,
        title: "Token Info & Scopes",
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      console.error(`❌ TEST 1 failed:`, error);
    }

    console.log(`📁 TEST 2: Testing basic Drive API access`);
    try {
      const aboutResponse = await drive.about.get({
        fields: 'user,storageQuota,canCreateDrives'
      });

      diagnostic.tests.push({
        test: 2,
        title: "Basic Drive API Access",
        success: true,
        data: {
          userName: aboutResponse.data.user?.displayName,
          userEmail: aboutResponse.data.user?.emailAddress,
          canCreateDrives: aboutResponse.data.canCreateDrives,
          storageQuota: aboutResponse.data.storageQuota
        }
      });

      console.log(`✅ TEST 2: Drive API accessible for ${aboutResponse.data.user?.emailAddress}`);

    } catch (error) {
      diagnostic.tests.push({
        test: 2,
        title: "Basic Drive API Access",
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      console.error(`❌ TEST 2 failed:`, error);
    }

    console.log(`🤝 TEST 3: Testing sharedWithMe query capability`);
    try {
      const sharedResponse = await drive.files.list({
        q: 'sharedWithMe=true',
        fields: 'files(id,name,owners,sharingUser)',
        pageSize: 10,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });

      const sharedFiles = sharedResponse.data.files || [];

      diagnostic.tests.push({
        test: 3,
        title: "SharedWithMe Query Test",
        success: true,
        data: {
          totalSharedFiles: sharedFiles.length,
          sampleFiles: sharedFiles.slice(0, 5).map(f => ({
            id: f.id,
            name: f.name,
            owner: f.owners?.[0]?.emailAddress,
            sharingUser: f.sharingUser?.emailAddress
          }))
        }
      });

      console.log(`✅ TEST 3: Found ${sharedFiles.length} items shared with user`);

    } catch (error) {
      diagnostic.tests.push({
        test: 3,
        title: "SharedWithMe Query Test",
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      console.error(`❌ TEST 3 failed:`, error);
    }

    console.log(`💾 TEST 4: Testing shared drives access`);
    try {
      const drivesResponse = await drive.drives.list({
        fields: 'drives(id,name)'
      });

      const sharedDrives = drivesResponse.data.drives || [];

      diagnostic.tests.push({
        test: 4,
        title: "Shared Drives Access Test",
        success: true,
        data: {
          totalSharedDrives: sharedDrives.length,
          drives: sharedDrives.map(d => ({
            id: d.id,
            name: d.name
          }))
        }
      });

      console.log(`✅ TEST 4: Found ${sharedDrives.length} shared drives`);

    } catch (error) {
      diagnostic.tests.push({
        test: 4,
        title: "Shared Drives Access Test",
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      console.error(`❌ TEST 4 failed:`, error);
    }

    const url = new URL(request.url);
    const testFolderId = url.searchParams.get('test_folder_id');
    
    if (testFolderId) {
      console.log(`📂 TEST 5: Testing direct folder access for ${testFolderId}`);
      try {
        const folderResponse = await drive.files.get({
          fileId: testFolderId,
          fields: 'id,name,owners,shared,capabilities,permissions',
          supportsAllDrives: true
        });

        const contentsResponse = await drive.files.list({
          q: `'${testFolderId}' in parents and trashed=false`,
          fields: 'files(id,name,owners)',
          pageSize: 10,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true
        });

        diagnostic.tests.push({
          test: 5,
          title: "Direct Folder Access Test",
          success: true,
          data: {
            folder: {
              id: folderResponse.data.id,
              name: folderResponse.data.name,
              owners: folderResponse.data.owners?.map(o => ({ name: o.displayName, email: o.emailAddress })),
              isShared: folderResponse.data.shared,
              capabilities: folderResponse.data.capabilities
            },
            contents: {
              itemCount: contentsResponse.data.files?.length || 0,
              items: contentsResponse.data.files?.slice(0, 5).map(f => ({
                id: f.id,
                name: f.name,
                owner: f.owners?.[0]?.emailAddress
              })) || []
            }
          }
        });

        console.log(`✅ TEST 5: Can access folder "${folderResponse.data.name}" with ${contentsResponse.data.files?.length || 0} items`);

      } catch (error) {
        diagnostic.tests.push({
          test: 5,
          title: "Direct Folder Access Test",
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          testedFolderId: testFolderId
        });
        console.error(`❌ TEST 5 failed for folder ${testFolderId}:`, error);
      }
    }

    const test3Data = diagnostic.tests.find(t => t.test === 3)?.data;
    const totalSharedFiles = test3Data && typeof test3Data.totalSharedFiles === 'number' 
      ? test3Data.totalSharedFiles 
      : 0;

    const summary = {
      hasValidToken: diagnostic.tests.find(t => t.test === 1)?.success || false,
      hasDriveAccess: diagnostic.tests.find(t => t.test === 2)?.success || false,
      canQuerySharedFiles: diagnostic.tests.find(t => t.test === 3)?.success || false,
      canAccessSharedDrives: diagnostic.tests.find(t => t.test === 4)?.success || false,
      totalSharedItems: totalSharedFiles,
      
      issues: [] as string[],
      recommendations: [] as string[]
    };

    if (!summary.hasValidToken) {
      summary.issues.push("❌ Token is invalid or expired");
      summary.recommendations.push("Re-authenticate the user");
    }

    if (!summary.hasDriveAccess) {
      summary.issues.push("❌ No basic Drive API access");
      summary.recommendations.push("Check OAuth scopes and API enablement");
    }

    if (!summary.canQuerySharedFiles) {
      summary.issues.push("❌ Cannot query shared files");
      summary.recommendations.push("Check if 'drive' scope includes shared access");
    }

    if (summary.totalSharedItems === 0) {
      summary.issues.push("⚠️ No shared items found - colleague may not have shared correctly");
      summary.recommendations.push("Verify sharing was done with correct email address");
    }

    if (summary.canQuerySharedFiles && summary.totalSharedItems > 0) {
      summary.recommendations.push("✅ Shared content exists - check if it matches your search criteria");
    }

    console.log(`📊 OAUTH DIAGNOSTIC COMPLETE: ${summary.totalSharedItems} shared items found`);

    return NextResponse.json({
      diagnostic,
      summary,
      instructions: {
        forceReauth: "If scopes are missing, add ?prompt=consent to force re-authentication",
        testSpecificFolder: "Add ?test_folder_id=FOLDER_ID to test access to a specific folder",
        nextSteps: summary.recommendations
      }
    });

  } catch (error: unknown) {
    console.error('❌ OAuth scope diagnostic failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
} 