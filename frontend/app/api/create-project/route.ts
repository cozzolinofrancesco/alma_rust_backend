import { drive_v3, google } from 'googleapis';
import { getApiSession } from '../../lib/apiCaller.server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { REQUIRED_FOLDERS, MAX_PROJECT_NAME_LENGTH, getCleanProjectName } from '../../lib/project-constants';
import { cleanupRecentProjectsCache, recentProjectsCache } from '../../lib/recent-projects-cache';

const errorResponse = (message: string, status: number = 500) =>
  NextResponse.json({ error: message }, { status });

const requestSchema = z.object({
  project_name: z.string(),
  collaborators: z
    .array(
      z.object({
        email: z.string().email(),
        role: z.string().optional(),
      }),
    )
    .optional(),
});

export async function POST(request: Request) {
  try {
    const session = await getApiSession(request);
    if (!session?.accessToken) {
      return errorResponse('Not authenticated', 401);
    }
    const { accessToken, refreshToken } = session;
    const userEmail = session.user?.email;

    const parsedBody = requestSchema.safeParse(await request.json());
    if (!parsedBody.success) {
      return errorResponse('Invalid request: project_name (string) and optional collaborators[].email are required', 400);
    }
    const { project_name, collaborators } = parsedBody.data;
    const rawName = project_name.trim();
    if (!rawName) {
      return errorResponse('Project name is required', 400);
    }
    const sanitizedName = rawName.replace(/[^\w -]/g, '');
    if (!sanitizedName) {
      return errorResponse('Invalid project name after sanitization', 400);
    }
    if (sanitizedName.length > MAX_PROJECT_NAME_LENGTH) {
      return errorResponse(`Project name must be at most ${MAX_PROJECT_NAME_LENGTH} characters`, 400);
    }

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID!,
      process.env.GOOGLE_CLIENT_SECRET!,
      process.env.GOOGLE_REDIRECT_URI!
    );
    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const timestamp = Date.now();
    const almaProjectName = `alma_${sanitizedName}_${timestamp}`;
    console.log(`🏗️ Creating ALMA project: ${almaProjectName}`);

    // Prevent duplicate projects with the same base name. The folder name is
    // always alma_<name>_<timestamp>, so match on the prefix and confirm the
    // cleaned base name equals sanitizedName ('contains' is a loose substring
    // match, so the in-code check is required to avoid false positives).
    const duplicateRes = await drive.files.list({
      q: `name contains 'alma_${sanitizedName}_' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id,name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const hasDuplicate = (duplicateRes.data.files ?? []).some(
      (f) => f.name != null && getCleanProjectName(f.name) === sanitizedName,
    );
    if (hasDuplicate) {
      return errorResponse('A project with this name already exists', 400);
    }

    const createRes = await drive.files.create({
      requestBody: {
        name: almaProjectName,
        mimeType: 'application/vnd.google-apps.folder',
      },
      fields: 'id,name',
      supportsAllDrives: true,
    });
    const projectFolder = createRes.data;
    if (!projectFolder.id) {
      return errorResponse('Failed to create project folder', 500);
    }
    const folderId: string = projectFolder.id;

    console.log(`📁 Creating ${REQUIRED_FOLDERS.length} required folders inside ALMA project "${almaProjectName}"`);
    const folderCreationResults: { folderName: string; success: boolean; error?: string }[] = [];

    await Promise.all(
      REQUIRED_FOLDERS.map(async (folderName) => {
        try {
          console.log(`📁 Creating folder: ${folderName}`);
          const folderRes = await drive.files.create({
            requestBody: {
              name: folderName,
              mimeType: 'application/vnd.google-apps.folder',
              parents: [folderId],
            },
            fields: 'id,name',
            supportsAllDrives: true,
          });

          if (folderRes.data.id) {
            folderCreationResults.push({ folderName, success: true });
            console.log(`✅ Successfully created folder: ${folderName}`);
          } else {
            folderCreationResults.push({ folderName, success: false, error: 'No folder ID returned' });
            console.error(`❌ Failed to create folder: ${folderName} - no ID returned`);
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Unknown error';
          folderCreationResults.push({ folderName, success: false, error: errorMsg });
          console.error(`❌ Error creating folder ${folderName}:`, err);
        }
      })
    );

    const successfulFolders = folderCreationResults.filter(r => r.success).length;
    const failedFolders = folderCreationResults.filter(r => !r.success).length;
    console.log(`📊 Folder creation summary: ${successfulFolders} successful, ${failedFolders} failed`);

    const collaboratorResults: { email: string; success: boolean; error?: string }[] = [];
    if (Array.isArray(collaborators) && collaborators.length) {
      console.log(`🤝 Adding ${collaborators.length} collaborators to project "${sanitizedName}"`);

      await Promise.all(
        collaborators.map(async (c) => {
          if (!c.email) {
            console.warn('⚠️ Skipping collaborator with missing email:', c);
            return;
          }

          const permission: drive_v3.Schema$Permission = {
            type: 'user',
            role: c.role || 'reader',
            emailAddress: c.email,
          };

          try {
            console.log(`📧 Adding collaborator: ${c.email} with role: ${permission.role}`);
            await drive.permissions.create({
              fileId: folderId,
              requestBody: permission,
              supportsAllDrives: true,
            } as drive_v3.Params$Resource$Permissions$Create);

            collaboratorResults.push({ email: c.email, success: true });
            console.log(`✅ Successfully added collaborator: ${c.email}`);
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : 'Unknown error';
            collaboratorResults.push({ email: c.email, success: false, error: errorMsg });
            console.error(`❌ Error adding collaborator ${c.email}:`, err);
          }
        })
      );

      const successCount = collaboratorResults.filter(r => r.success).length;
      const failureCount = collaboratorResults.filter(r => !r.success).length;
      console.log(`📊 Collaborator summary: ${successCount} successful, ${failureCount} failed`);
    }

    const successfulCollaborators = collaboratorResults.filter(r => r.success);
    const failedCollaborators = collaboratorResults.filter(r => !r.success);

    let message = 'Project created successfully!';
    if (successfulFolders === REQUIRED_FOLDERS.length) {
      message += ` All ${REQUIRED_FOLDERS.length} required folders created.`;
    } else {
      message += ` ${successfulFolders}/${REQUIRED_FOLDERS.length} folders created.`;
    }

    if (collaboratorResults.length > 0) {
      message += ` Shared with ${successfulCollaborators.length} collaborator(s).`;
      if (failedCollaborators.length > 0) {
        message += ` Failed to share with ${failedCollaborators.length} collaborator(s).`;
      }
    }

    const projectData = {
      id: folderId,
      name: projectFolder.name || sanitizedName,
      displayName: getCleanProjectName(projectFolder.name || sanitizedName),
      owners: [{ emailAddress: userEmail || 'unknown' }],
      createdTime: new Date().toISOString(),
      collaborators: [],
      isOwnedByCurrentUser: true,
      hasUserAccess: true,
      shared: false,
      almaRootName: projectFolder.name || sanitizedName,
      almaRootOwner: userEmail || 'unknown'
    };

    cleanupRecentProjectsCache();
    recentProjectsCache.set(folderId, {
      project: projectData,
      timestamp: Date.now(),
      userEmail: userEmail || 'unknown'
    });

    return NextResponse.json({
      project_id: folderId,
      project_name: projectFolder.name,
      message,
      folders: {
        total: REQUIRED_FOLDERS.length,
        successful: successfulFolders,
        failed: failedFolders,
        details: folderCreationResults
      },
      collaborators: {
        total: collaboratorResults.length,
        successful: successfulCollaborators.length,
        failed: failedCollaborators.length,
        details: collaboratorResults
      }
    });
  } catch (error) {
    console.error('Error creating project:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
