import { useSession } from 'next-auth/react';

export interface ProjectFile {
    id: string;
    name: string;
    type: 'File' | 'Folder';
    mimeType?: string;
    size?: string;
    createdTime?: string;
    modifiedTime?: string;
    webViewLink?: string;
    thumbnailLink?: string;
    parents?: string[];
}

export interface ProjectContext {
    projectId: string;
    projectName: string;
    accessToken: string;
}

export class ProjectFileService {
    private static instance: ProjectFileService;
    private currentProject: ProjectContext | null = null;

    static getInstance(): ProjectFileService {
        if (!ProjectFileService.instance) {
            ProjectFileService.instance = new ProjectFileService();
        }
        return ProjectFileService.instance;
    }

    setProjectContext(context: ProjectContext) {
        this.currentProject = context;
    }

    getCurrentProject(): ProjectContext | null {
        return this.currentProject;
    }

    async getProjectContents(): Promise<ProjectFile[]> {
        if (!this.currentProject) {
            throw new Error('No project context available. Please select a project first.');
        }

        try {
            const response = await fetch(
                `/api/projects/${this.currentProject.projectId}/folders/folder_id/${this.currentProject.projectId}/contents`
            );

            if (!response.ok) {
                throw new Error(`Failed to load project contents: ${response.statusText}`);
            }

            const data = await response.json();

            console.log(`✅ Canvas: Loaded ${data.files?.length || 0} items from project root`);
            return data.files || [];
        } catch (error) {
            console.error('Error fetching project contents:', error);
            throw error;
        }
    }

    async getProjectFolders(): Promise<ProjectFile[]> {
        const allContents = await this.getProjectContents();
        return allContents.filter((file: ProjectFile) =>
            file.type === 'Folder'
        );
    }

    async getFolderContents(folderName: string): Promise<ProjectFile[]> {
        if (!this.currentProject) {
            throw new Error('No project context available. Please select a project first.');
        }

        try {
            const response = await fetch(
                `/api/projects/${this.currentProject.projectId}/folders/${folderName}/files`
            );

            if (!response.ok) {
                throw new Error(`Failed to load folder contents: ${response.statusText}`);
            }

            const data = await response.json();
            return data.files || [];
        } catch (error) {
            console.error(`Error fetching folder contents for ${folderName}:`, error);
            throw error;
        }
    }

    async getFolderContentsById(folderId: string): Promise<ProjectFile[]> {
        if (!this.currentProject) {
            throw new Error('No project context available. Please select a project first.');
        }

        try {
            const response = await fetch(
                `/api/projects/${this.currentProject.projectId}/folders/folder_id/${folderId}/contents`
            );

            if (!response.ok) {
                throw new Error(`Failed to load folder contents: ${response.statusText}`);
            }

            const data = await response.json();
            return data.files || [];
        } catch (error) {
            console.error(`Error fetching folder contents for ID ${folderId}:`, error);
            throw error;
        }
    }

    async searchFiles(query: string, fileTypes?: string[]): Promise<ProjectFile[]> {
        if (!this.currentProject) {
            throw new Error('No project context available. Please select a project first.');
        }

        try {
            const searchParams = new URLSearchParams();
            searchParams.set('project_id', this.currentProject.projectId);
            if (query) searchParams.set('q', query);
            if (fileTypes && fileTypes.length > 0) {
                searchParams.set('file_types', fileTypes.join(','));
            }

            const response = await fetch(`/api/files-search?${searchParams}`);

            if (!response.ok) {
                throw new Error(`Failed to search files: ${response.statusText}`);
            }

            const data = await response.json();
            return data.files || [];
        } catch (error) {
            console.error('Error searching files:', error);
            throw error;
        }
    }

    async getFileContent(fileId: string): Promise<{ content: string; mimeType: string }> {
        if (!this.currentProject) {
            throw new Error('No project context available. Please select a project first.');
        }

        try {
            const response = await fetch(
                `/api/projects/${this.currentProject.projectId}/files/${fileId}`
            );

            if (!response.ok) {
                throw new Error(`Failed to load file content: ${response.statusText}`);
            }

            const data = await response.json();
            return {
                content: data.content,
                mimeType: data.mimeType || 'text/plain'
            };
        } catch (error) {
            console.error(`Error fetching file content for ${fileId}:`, error);
            throw error;
        }
    }
}

export function useProjectContext() {
    const { data: session } = useSession();
    const fileService = ProjectFileService.getInstance();

    const initializeProjectContext = () => {
        if (!session?.accessToken) return null;

        const storedProjectFolder = localStorage.getItem('projectFolder');
        if (storedProjectFolder) {
            try {
                const projectFolder = JSON.parse(storedProjectFolder);

                if (projectFolder && projectFolder.projectId && projectFolder.folderName) {
                    const context: ProjectContext = {
                        projectId: projectFolder.projectId,
                        projectName: projectFolder.folderName,
                        accessToken: session.accessToken
                    };
                    fileService.setProjectContext(context);
                    console.log('✅ Canvas: Project context initialized:', context);
                    return context;
                } else {
                    console.warn('❌ Canvas: Invalid projectFolder structure:', projectFolder);
                }
            } catch (error) {
                console.warn('❌ Canvas: Failed to parse stored projectFolder:', error);
            }
        } else {
            console.log('📋 Canvas: No projectFolder found in localStorage');
        }

        return null;
    };

    const refreshProjectContext = () => {
        console.log('🔄 Canvas: Refreshing project context...');
        return initializeProjectContext();
    };

    const isProjectContextStale = () => {
        const currentContext = fileService.getCurrentProject();
        if (!currentContext) return true;

        const storedProjectFolder = localStorage.getItem('projectFolder');
        if (!storedProjectFolder) return true;

        try {
            const projectFolder = JSON.parse(storedProjectFolder);
            return projectFolder.projectId !== currentContext.projectId;
        } catch {
            return true;
        }
    };

    return {
        initializeProjectContext,
        refreshProjectContext,
        isProjectContextStale,
        fileService,
        hasProjectContext: () => fileService.getCurrentProject() !== null,
        currentProject: fileService.getCurrentProject()
    };
} 