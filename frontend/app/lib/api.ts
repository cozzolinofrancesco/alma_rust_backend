
import { AgentFile } from './types';

interface DriveFile {
  id: string;
  name: string;
  type: string;
  createdTime?: string;
  modifiedTime?: string;
  webViewLink?: string;
  size?: number;
}

interface DriveResponse {
  files?: DriveFile[];
}

export const AGENT_FILES_FETCH_TIMEOUT_MS = 20_000;

export const fetchAgentFiles = async (projectFolder?: string): Promise<AgentFile[]> => {
    console.log(`🔍 Fetching agent files${projectFolder ? ` for project: ${projectFolder}` : ' from all drives'}`);
    
    if (!projectFolder) {
        console.log('❌ No project folder specified, returning empty array');
        return [];
    }

    try {
        let agentFiles: AgentFile[] = [];
        
        try {
            console.log('📁 Trying to fetch from AF folder...');
            
            const fetchWithDeadline = async (url: string, deadlineMs: number) => {
                const remaining = deadlineMs - Date.now();
                if (remaining <= 0) {
                    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
                }
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), remaining);
                try {
                    const response = await fetch(url, { signal: controller.signal });
                    clearTimeout(timeoutId);
                    return response;
                } catch (error) {
                    clearTimeout(timeoutId);
                    throw error;
                }
            };

            const deadline = Date.now() + AGENT_FILES_FETCH_TIMEOUT_MS;

            const afResponse = await fetchWithDeadline(
                `/api/projects/${projectFolder}/folders/folder_id/${projectFolder}/contents`,
                deadline
            );
            
            if (afResponse.ok) {
                const afData: DriveResponse = await afResponse.json();
                console.log('📄 Project contents response:', afData);
                
                const afFolder = afData.files?.find((file: DriveFile) => 
                    file.type === 'Folder' && (file.name === 'AF' || file.name.toLowerCase() === 'agents')
                );
                
                if (afFolder) {
                    console.log('✅ Found AF folder:', afFolder.id);
                    const afContentsResponse = await fetchWithDeadline(
                        `/api/projects/${projectFolder}/folders/folder_id/${afFolder.id}/contents`,
                        deadline
                    );
                    
                    if (afContentsResponse.ok) {
                        const afContentsData: DriveResponse = await afContentsResponse.json();
                        console.log('📋 AF folder contents:', afContentsData);
                        
                        agentFiles = afContentsData.files
                            ?.filter((file: DriveFile) => {
                                if (file.type !== 'File' || !file.name.endsWith('.json')) {
                                    return false;
                                }
                                const lowerName = file.name.toLowerCase();
                                return (
                                    !lowerName.endsWith('_versioned.json') &&
                                    !lowerName.endsWith('.agentnodes-meta.json') &&
                                    !lowerName.endsWith('.agentnodes-graph.json') &&
                                    !lowerName.endsWith('.canvas272.json') &&
                                    !lowerName.endsWith('.reviews.json')
                                );
                            })
                            ?.map((file: DriveFile) => ({
                                id: file.id,
                                name: file.name.replace(/\.json$/i, ''),
                                createdTime: file.createdTime || new Date().toISOString(),
                                modifiedTime: file.modifiedTime || new Date().toISOString(),
                                createdAt: file.createdTime || new Date().toISOString(),
                                updatedAt: file.modifiedTime || new Date().toISOString(),
                                webViewLink: file.webViewLink,
                                size: file.size
                            })) || [];
                    } else {
                        console.log('❌ Failed to fetch AF folder contents');
                    }
                } else {
                    console.log('📁 No AF folder found, project might not have agents yet');
                }
            } else {
                console.log('❌ Failed to fetch project contents');
            }
        } catch (afError) {
            console.log('❌ AF folder approach failed:', afError);
        }

        console.log(`✅ Found ${agentFiles.length} agent files total`);
        return agentFiles;

    } catch (error) {
        console.error('❌ Error fetching agent files:', error);
        throw new Error(`Failed to fetch agent files: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
};

interface FileContentResponse {
  content?: string;
}

export const fetchFileContent = async (fileId: string, projectId: string = 'agents'): Promise<string> => {
    console.log(`Fetching content for file ID: ${fileId} in project: ${projectId}`);
    
    try {
        const response = await fetch(`/api/projects/${projectId}/files/${fileId}`);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data: FileContentResponse = await response.json();
        
        if (!data.content) {
            throw new Error('No content returned from API');
        }

        return data.content;

    } catch (error) {
        console.error(`Error fetching file content for ${fileId}:`, error);
        throw new Error(`Failed to fetch file content: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
};

