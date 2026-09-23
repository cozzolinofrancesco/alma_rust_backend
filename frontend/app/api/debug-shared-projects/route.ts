import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import { getServerSession } from "next-auth/next";
import { authOptions } from "../../lib/authOptions";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    const accessToken = session?.accessToken;
    const refreshToken = session?.refreshToken;
    const userEmail = session?.user?.email;

    if (!accessToken || !userEmail) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    console.log(`🔍 FIND-ALL-SHARED: Searching for ALL shared content with ${userEmail}`);

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
    
    interface SearchResult {
      search: number | string;
      title: string;
      query?: string;
      totalFound?: number;
      error?: string;
      [key: string]: unknown;
    }

    const investigation = {
      userEmail,
      timestamp: new Date().toISOString(),
      searches: [] as SearchResult[]
    };

    console.log(`📁 SEARCH 1: Finding ALL folders (owned + shared)`);
    try {
      const allFoldersResponse = await drive.files.list({
        q: `mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id,name,owners,shared,capabilities,parents,createdTime)',
        orderBy: 'modifiedTime desc',
        pageSize: 200,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });

      const allFolders = allFoldersResponse.data.files || [];
      const ownedFolders = allFolders.filter(f => 
        f.owners?.some(o => o.emailAddress?.toLowerCase() === userEmail.toLowerCase())
      );
      const notOwnedFolders = allFolders.filter(f => 
        !f.owners?.some(o => o.emailAddress?.toLowerCase() === userEmail.toLowerCase())
      );

      investigation.searches.push({
        search: 1,
        title: "ALL Folders Discovery",
        query: "mimeType='application/vnd.google-apps.folder' and trashed=false",
        totalFound: allFolders.length,
        ownedByUser: ownedFolders.length,
        notOwnedByUser: notOwnedFolders.length,
        sampleNotOwned: notOwnedFolders.slice(0, 10).map(f => ({
          id: f.id,
          name: f.name,
          owner: f.owners?.[0]?.emailAddress || 'Unknown',
          isShared: f.shared,
          hasParents: f.parents && f.parents.length > 0
        }))
      });

      console.log(`✅ SEARCH 1: Found ${allFolders.length} total folders (${ownedFolders.length} owned, ${notOwnedFolders.length} not owned)`);

    } catch (error) {
      investigation.searches.push({
        search: 1,
        title: "ALL Folders Discovery",
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      console.error(`❌ SEARCH 1 failed:`, error);
    }

    console.log(`🤝 SEARCH 2: Finding folders explicitly shared with user`);
    try {
      const sharedWithMeResponse = await drive.files.list({
        q: `mimeType='application/vnd.google-apps.folder' and trashed=false and sharedWithMe=true`,
        fields: 'files(id,name,owners,shared,capabilities,parents,createdTime,sharingUser)',
        orderBy: 'modifiedTime desc',
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });

      const sharedFolders = sharedWithMeResponse.data.files || [];

      investigation.searches.push({
        search: 2,
        title: "Explicitly Shared Folders",
        query: "mimeType='application/vnd.google-apps.folder' and trashed=false and sharedWithMe=true",
        totalFound: sharedFolders.length,
        folders: sharedFolders.map(f => ({
          id: f.id,
          name: f.name,
          owner: f.owners?.[0]?.emailAddress || 'Unknown',
          sharingUser: f.sharingUser?.emailAddress || 'Unknown',
          isShared: f.shared,
          hasParents: f.parents && f.parents.length > 0,
          almaPattern: /^alma_\d+_[a-z0-9]+$/i.test(f.name || '')
        }))
      });

      console.log(`✅ SEARCH 2: Found ${sharedFolders.length} explicitly shared folders`);

    } catch (error) {
      investigation.searches.push({
        search: 2,
        title: "Explicitly Shared Folders",
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      console.error(`❌ SEARCH 2 failed:`, error);
    }

    console.log(`💾 SEARCH 3: Finding shared drives`);
    try {
      const sharedDrivesResponse = await drive.drives.list({
        fields: 'drives(id,name,capabilities,createdTime)'
      });

      const sharedDrives = sharedDrivesResponse.data.drives || [];

      investigation.searches.push({
        search: 3,
        title: "Shared Drives",
        totalFound: sharedDrives.length,
        drives: sharedDrives.map(d => ({
          id: d.id,
          name: d.name,
          capabilities: d.capabilities,
          createdTime: d.createdTime
        }))
      });

      console.log(`✅ SEARCH 3: Found ${sharedDrives.length} shared drives`);

      if (sharedDrives.length > 0) {
        console.log(`🔍 SEARCH 3b: Searching inside shared drives for folders`);
        
        for (const sharedDrive of sharedDrives.slice(0, 3)) {
          try {
            if (!sharedDrive.id) {
              console.error(`❌ Shared drive ${sharedDrive.name} has no ID`);
              continue;
            }

            const driveContentsResponse = await drive.files.list({
              q: `mimeType='application/vnd.google-apps.folder' and trashed=false`,
              fields: 'files(id,name,owners,shared,parents)',
              corpora: 'drive',
              driveId: sharedDrive.id,
              includeItemsFromAllDrives: true,
              supportsAllDrives: true,
              pageSize: 50
            });

            const driveFolders = driveContentsResponse.data.files || [];
            
            investigation.searches.push({
              search: `3b-${sharedDrive.id}`,
              title: `Inside Shared Drive: ${sharedDrive.name}`,
              totalFound: driveFolders.length,
              folders: driveFolders.map(f => ({
                id: f.id,
                name: f.name,
                owner: f.owners?.[0]?.emailAddress || 'Drive',
                almaPattern: /^alma_\d+_[a-z0-9]+$/i.test(f.name || '')
              }))
            });

            console.log(`✅ SEARCH 3b: Found ${driveFolders.length} folders in shared drive "${sharedDrive.name}"`);

          } catch (error) {
            console.error(`❌ Error searching shared drive ${sharedDrive.name}:`, error);
          }
        }
      }

    } catch (error) {
      investigation.searches.push({
        search: 3,
        title: "Shared Drives",
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      console.error(`❌ SEARCH 3 failed:`, error);
    }

    console.log(`🔐 SEARCH 4: Permission-based folder discovery`);
    try {
      const permissionBasedResponse = await drive.files.list({
        q: `mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id,name,owners,shared,permissions)',
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });

      const permissionFolders = permissionBasedResponse.data.files || [];
      
      const foldersWithUserPermissions = [];
      
      for (const folder of permissionFolders.slice(0, 20)) {
        const isOwner = folder.owners?.some(o => o.emailAddress?.toLowerCase() === userEmail.toLowerCase());
        
        if (!isOwner && folder.permissions) {
          const userHasPermission = folder.permissions.some(p => 
            p.emailAddress?.toLowerCase() === userEmail.toLowerCase()
          );
          
          if (userHasPermission) {
            foldersWithUserPermissions.push({
              id: folder.id,
              name: folder.name,
              owner: folder.owners?.[0]?.emailAddress || 'Unknown',
              userPermissions: folder.permissions.filter(p => 
                p.emailAddress?.toLowerCase() === userEmail.toLowerCase()
              ).map(p => ({ role: p.role, type: p.type }))
            });
          }
        }
      }

      investigation.searches.push({
        search: 4,
        title: "Permission-Based Discovery",
        totalSampled: Math.min(20, permissionFolders.length),
        foldersWithUserPermissions: foldersWithUserPermissions.length,
        folders: foldersWithUserPermissions
      });

      console.log(`✅ SEARCH 4: Found ${foldersWithUserPermissions.length} folders with user permissions`);

    } catch (error) {
      investigation.searches.push({
        search: 4,
        title: "Permission-Based Discovery",
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      console.error(`❌ SEARCH 4 failed:`, error);
    }

    console.log(`🔍 SEARCH 4: SPECIFIC FOLDER DEBUGGING`);
    const robertoFolderId = '1cFZZEORlLNTEBc9tK2BV3ir_-odngJ8e';
    
    try {
      console.log(`📁 Testing access to Roberto's folder: ${robertoFolderId}`);
      const folderResponse = await drive.files.get({
        fileId: robertoFolderId,
        fields: 'id,name,owners,shared,capabilities,permissions',
        supportsAllDrives: true
      });
      
      console.log(`✅ FOLDER ACCESS SUCCESS:`, {
        name: folderResponse.data.name,
        owners: folderResponse.data.owners?.map(o => o.emailAddress),
        shared: folderResponse.data.shared,
        capabilities: folderResponse.data.capabilities
      });
      
      console.log(`📂 Testing contents inside Roberto's folder...`);
      const contentsResponse = await drive.files.list({
        q: `'${robertoFolderId}' in parents and trashed=false`,
        fields: 'files(id,name,mimeType,owners)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });
      
      const contents = contentsResponse.data.files || [];
      console.log(`📊 FOLDER CONTENTS (${contents.length} items):`, 
        contents.map(f => ({
          name: f.name,
          type: f.mimeType === 'application/vnd.google-apps.folder' ? 'FOLDER' : 'FILE',
          owner: f.owners?.[0]?.emailAddress
        }))
      );
      
      const projectFolders = contents.filter(f => 
        f.mimeType === 'application/vnd.google-apps.folder'
      );
      console.log(`📁 PROJECT FOLDERS (${projectFolders.length}):`, 
        projectFolders.map(f => f.name)
      );
      
      investigation.searches.push({
        search: 4,
        title: "Roberto's Folder Debug",
        query: `'${robertoFolderId}' in parents`,
        totalFound: contents.length,
        projectFolders: projectFolders.length,
        details: {
          folderName: folderResponse.data.name,
          folderOwner: folderResponse.data.owners?.[0]?.emailAddress,
          isShared: folderResponse.data.shared,
          contents: contents.map(f => ({
            name: f.name,
            type: f.mimeType === 'application/vnd.google-apps.folder' ? 'FOLDER' : 'FILE'
          }))
        }
      });
      
    } catch (error) {
      console.error(`❌ ROBERTO FOLDER DEBUG FAILED:`, error);
      investigation.searches.push({
        search: 4,
        title: "Roberto's Folder Debug",
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }

    const totalSharedFound = investigation.searches.reduce((total, search) => {
      if (search.title === "Explicitly Shared Folders") return total + (search.totalFound || 0);
      if (search.title === "Permission-Based Discovery") {
        const userPermissions = typeof search.foldersWithUserPermissions === 'number' ? search.foldersWithUserPermissions : 0;
        return total + userPermissions;
      }
      if (search.title?.includes("Shared Drive")) return total + (search.totalFound || 0);
      return total;
    }, 0);

    const summary = {
      totalSharedFoldersFound: totalSharedFound,
      hasSharedDrives: investigation.searches.some(s => s.title === "Shared Drives" && (s.totalFound || 0) > 0),
      hasExplicitlySharedFolders: investigation.searches.some(s => s.title === "Explicitly Shared Folders" && (s.totalFound || 0) > 0),
      hasPermissionBasedFolders: investigation.searches.some(s => {
        if (s.title === "Permission-Based Discovery") {
          const userPermissions = typeof s.foldersWithUserPermissions === 'number' ? s.foldersWithUserPermissions : 0;
          return userPermissions > 0;
        }
        return false;
      }),
      
      issues: [] as string[]
    };

    if (totalSharedFound === 0) {
      summary.issues.push("❌ NO SHARED FOLDERS FOUND AT ALL - This indicates a fundamental issue");
      summary.issues.push("🔍 Check: Google Drive API scopes, authentication, or account permissions");
    }

    if (!summary.hasExplicitlySharedFolders) {
      summary.issues.push("⚠️ No folders found with sharedWithMe=true - colleague may not have shared correctly");
    }

    if (!summary.hasSharedDrives) {
      summary.issues.push("ℹ️ No shared drives found - content may be in regular folders");
    }

    console.log(`📊 FINAL SUMMARY: Found ${totalSharedFound} total shared folders across all methods`);

    return NextResponse.json({
      investigation,
      summary,
      quickTest: {
        instruction: "If you see 0 shared folders across ALL methods, the issue is likely:",
        possibleCauses: [
          "1. OAuth scopes missing (need full Google Drive access)",
          "2. Colleague hasn't actually shared folders with your email",
          "3. Folders are shared but in a different Google account",
          "4. Google Drive API permissions issue"
        ]
      }
    });

  } catch (error: unknown) {
    console.error('❌ Comprehensive shared folder search failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
} 