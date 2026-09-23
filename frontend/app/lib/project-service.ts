import { drive_v3, google } from 'googleapis';
import { REQUIRED_FOLDERS } from './project-constants';

export interface ProjectContext {
  projectFolderId: string;
  projectName: string;
  ragFolderId: string;
}

const ALMA_PROJECT_PATTERN = /^alma_[a-zA-Z0-9 _-]+_\d{13}$/;

// Enumerate the alma_ project folders the caller can access (owned + sharedWithMe),
// deduped by id. Reused by the corpus rename/delete fan-out to update every project's
// shared corpusLinks. Mirrors the query pair in app/api/list-projects/route.ts.
export async function listUserProjectFolders(
  drive: drive_v3.Drive,
): Promise<Array<{ id: string; name: string }>> {
  const fields = 'files(id,name)';
  const base = "name contains 'alma_' and mimeType='application/vnd.google-apps.folder' and trashed=false";
  const [owned, shared] = await Promise.all([
    drive.files.list({ q: base, fields, pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true }),
    drive.files.list({ q: `${base} and sharedWithMe=true`, fields, pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true }),
  ]);
  const seen = new Set<string>();
  const out: Array<{ id: string; name: string }> = [];
  for (const f of [...(owned.data.files ?? []), ...(shared.data.files ?? [])]) {
    if (!f.id || !f.name || seen.has(f.id) || !ALMA_PROJECT_PATTERN.test(f.name)) continue;
    seen.add(f.id);
    out.push({ id: f.id, name: f.name });
  }
  return out;
}

export class ProjectService {
  private drive: drive_v3.Drive;

  constructor(auth: drive_v3.Options['auth']) {
    this.drive = google.drive({ version: 'v3', auth });
  }

  async initializeProjectFolders(projectFolderId: string): Promise<void> {
    try {
      console.log(`📁 [ProjectService] Initializing project folders in: ${projectFolderId}`);

      const folderCreationResults = await Promise.allSettled(
        REQUIRED_FOLDERS.map(async (folderName) => {
          console.log(`📁 [ProjectService] Creating folder: ${folderName}`);
          const folderRes = await this.drive.files.create({
            requestBody: {
              name: folderName,
              mimeType: 'application/vnd.google-apps.folder',
              parents: [projectFolderId],
            },
            fields: 'id,name',
          });

          if (folderRes.data.id) {
            console.log(`✅ [ProjectService] Successfully created folder: ${folderName}`);
            return { folderName, success: true };
          } else {
            console.error(`❌ [ProjectService] Failed to create folder: ${folderName} - no ID returned`);
            return { folderName, success: false, error: 'No folder ID returned' };
          }
        })
      );

      const successful = folderCreationResults.filter(result => result.status === 'fulfilled').length;
      const failed = folderCreationResults.filter(result => result.status === 'rejected').length;

      console.log(`📊 [ProjectService] Project initialization complete: ${successful} folders created, ${failed} failed`);

    } catch (error) {
      console.error('❌ [ProjectService] Error initializing project folders:', error);
      throw error;
    }
  }

  async ensureRAGKnowledgeFolder(projectFolderId: string): Promise<string> {
    try {
      console.log(`🔍 [ProjectService] Ensuring RAG-Knowledge folder exists in project: ${projectFolderId}`);

      try {
        const projectInfo = await this.drive.files.get({
          fileId: projectFolderId,
          fields: 'id, name, capabilities, parents'
        });
        console.log(`✅ [ProjectService] Confirmed project access: ${projectInfo.data.name}`);
      } catch (projectError) {
        console.error(`❌ [ProjectService] Cannot access project ${projectFolderId}:`, projectError);
        throw new Error(`Cannot access project folder. Please ensure you have proper permissions to the selected project.`);
      }

      const existingResponse = await this.drive.files.list({
        q: `'${projectFolderId}' in parents and name='RAG-Knowledge' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id, name)'
      });

      const existingFolders = existingResponse.data.files || [];
      if (existingFolders.length > 0 && existingFolders[0].id) {
        console.log(`📁 [ProjectService] Found existing RAG-Knowledge folder: ${existingFolders[0].id}`);
        return existingFolders[0].id;
      }

      console.log(`📁 [ProjectService] Creating RAG-Knowledge folder in project: ${projectFolderId}`);

      try {
        const folderResponse = await this.drive.files.create({
          requestBody: {
            name: 'RAG-Knowledge',
            mimeType: 'application/vnd.google-apps.folder',
            parents: [projectFolderId]
          },
          fields: 'id, name'
        });

        const ragFolderId = folderResponse.data.id!;
        console.log(`✅ [ProjectService] Created RAG-Knowledge folder: ${ragFolderId}`);
        return ragFolderId;
      } catch (createError) {
        console.error('❌ [ProjectService] Failed to create RAG-Knowledge folder:', createError);

        if ((createError as { code?: number }).code === 400) {
          throw new Error(`Cannot create RAG-Knowledge folder in this project. This may be because: 1) The project folder is read-only, 2) You don't have write permissions, or 3) The project structure is invalid. Please check your project permissions.`);
        } else if ((createError as { code?: number }).code === 403) {
          throw new Error(`Permission denied: You don't have write access to create folders in this project. Please ensure you have editor access to the project.`);
        } else {
          const message = createError instanceof Error ? createError.message : 'Unknown error';
          throw new Error(`Failed to create RAG-Knowledge folder: ${message}`);
        }
      }

    } catch (error) {
      if (error instanceof Error && error.message.includes('Cannot create RAG-Knowledge folder')) {
        throw error;
      }
      console.error('❌ [ProjectService] Error ensuring RAG-Knowledge folder:', error);
      throw new Error(`Failed to ensure RAG-Knowledge folder: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async detectProjectContext(fileName: string, explicitProjectId?: string): Promise<ProjectContext | null> {
    try {
      let projectFolderId: string;
      let projectName: string;

      if (explicitProjectId) {
        const projectResponse = await this.drive.files.get({
          fileId: explicitProjectId,
          fields: 'id, name'
        });

        projectFolderId = explicitProjectId;
        projectName = projectResponse.data.name || 'Unknown Project';
        console.log(`🎯 [ProjectService] Using explicit project: ${projectName} (${projectFolderId})`);
      } else {
        console.log('🔍 [ProjectService] No explicit project ID, searching for ALMA projects...');
        const almaProjectsResponse = await this.drive.files.list({
          q: "name contains 'alma_' and mimeType='application/vnd.google-apps.folder' and trashed=false",
          fields: 'files(id, name, createdTime)',
          orderBy: 'createdTime desc',
          pageSize: 5
        });

        const almaProjects = almaProjectsResponse.data.files || [];
        console.log(`🔍 [ProjectService] Found ${almaProjects.length} ALMA projects`);

        if (almaProjects.length > 0) {
          projectFolderId = almaProjects[0].id!;
          projectName = almaProjects[0].name!;
          console.log(`📁 [ProjectService] Using most recent ALMA project: ${projectName} (${projectFolderId})`);

          try {
            await this.drive.files.get({
              fileId: projectFolderId,
              fields: 'id, name, capabilities'
            });
            console.log(`✅ [ProjectService] Confirmed access to project: ${projectName}`);
          } catch (accessError) {
            console.error(`❌ [ProjectService] Cannot access project ${projectName}:`, accessError);
            throw new Error(`Cannot access the selected project: ${projectName}. Please ensure you have proper permissions.`);
          }
        } else {
          throw new Error('No ALMA projects found. Please create an ALMA project first before using RAG processing. You can create a project from the Projects page.');
        }
      }

      const ragFolderId = await this.ensureRAGKnowledgeFolder(projectFolderId);

      return {
        projectFolderId,
        projectName,
        ragFolderId
      };

    } catch (error) {
      console.error('❌ [ProjectService] Error detecting project context:', error);
      return null;
    }
  }

  async listProjectsWithRAG(): Promise<Array<{ id: string; name: string; ragFolderId: string }>> {
    try {
      const almaProjectsResponse = await this.drive.files.list({
        q: "name contains 'alma_' and mimeType='application/vnd.google-apps.folder' and trashed=false",
        fields: 'files(id, name, createdTime)',
        orderBy: 'createdTime desc'
      });

      const almaProjects = almaProjectsResponse.data.files || [];
      console.log(`📁 [ProjectService] Found ${almaProjects.length} ALMA projects`);

      const projects: Array<{ id: string; name: string; ragFolderId: string }> = [];

      for (const project of almaProjects) {
        if (!project.id || !project.name) continue;

        try {
          const ragFolderResponse = await this.drive.files.list({
            q: `'${project.id}' in parents and name='RAG-Knowledge' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
            fields: 'files(id, name)'
          });

          const ragFolders = ragFolderResponse.data.files || [];
          if (ragFolders.length > 0) {
            console.log(`✅ [ProjectService] Found RAG-Knowledge folder in project: ${project.name}`);
            projects.push({
              id: project.id,
              name: project.name,
              ragFolderId: ragFolders[0].id!
            });
          } else {
            console.log(`⚠️ [ProjectService] No RAG-Knowledge folder in project: ${project.name}`);
          }
        } catch (error) {
          console.warn(`⚠️ [ProjectService] Could not check RAG folder for project ${project.name}:`, error);
        }
      }

      console.log(`📊 [ProjectService] Found ${projects.length} ALMA projects with RAG-Knowledge folders`);
      return projects;
    } catch (error) {
      console.error('❌ [ProjectService] Error listing projects with RAG:', error);
      return [];
    }
  }

  async listChunkFoldersInProject(ragFolderId: string): Promise<Array<{ id: string; name: string; createdTime: string }>> {
    try {
      const response = await this.drive.files.list({
        q: `'${ragFolderId}' in parents and name contains '_Chunks' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id, name, createdTime)',
        orderBy: 'createdTime desc'
      });

      const files = response.data.files || [];
      return files
        .filter((file): file is { id: string; name: string; createdTime: string } =>
          !!file.id && !!file.name && !!file.createdTime
        );
    } catch (error) {
      console.error('❌ [ProjectService] Error listing chunk folders in project:', error);
      return [];
    }
  }
}
