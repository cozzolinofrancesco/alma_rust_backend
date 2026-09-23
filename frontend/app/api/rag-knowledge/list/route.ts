import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { google } from 'googleapis';

interface RAGKnowledgeItem {
  id: string;
  name: string;
  originalFileName: string;
  folderName: string;
  createdTime: string;
  themes: string[];
  totalChunks: number;
  projectId: string;
  projectName: string;
  description: string;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');

    if (!projectId) {
      return NextResponse.json(
        { error: 'Project ID is required. Please specify a project to search for RAG knowledge.' },
        { status: 400 }
      );
    }

    const session = await getApiSession(request);
    
    if (!session?.accessToken) {
      return NextResponse.json(
        { error: 'Authentication required. Please sign in with Google.' },
        { status: 401 }
      );
    }

    const auth = new google.auth.OAuth2();
    auth.setCredentials({
      access_token: session.accessToken,
      refresh_token: session.refreshToken
    });

    const drive = google.drive({ version: 'v3', auth });
    
    console.log(`🔍 [RAG Knowledge] Searching for chunk folders in current project: ${projectId}`);

    const { ProjectService } = await import('../../../lib/project-service');
    const projectService = new ProjectService(auth);

    const projectResponse = await drive.files.get({
      fileId: projectId,
      fields: 'id, name'
    });
    const projectName = projectResponse.data.name;
    
    console.log(`📁 [RAG Knowledge] Working with project: ${projectName} (${projectId})`);

    const ragFolderId = await projectService.ensureRAGKnowledgeFolder(projectId);
    console.log(`📁 [RAG Knowledge] RAG folder ID: ${ragFolderId}`);

    const chunkFolders = await projectService.listChunkFoldersInProject(ragFolderId);
    
    console.log(`🔍 [RAG Knowledge] Found ${chunkFolders.length} chunk folders in current project`);
    chunkFolders.forEach(folder => {
      console.log(`   📂 Chunk folder: ${folder.name} (${folder.id}) created: ${folder.createdTime}`);
    });
    
    const projectChunkFolders = chunkFolders.map(folder => ({
      ...folder,
      projectId: projectId,
      projectName: projectName,
      ragFolderId: ragFolderId
    }));

    const knowledgeItems: RAGKnowledgeItem[] = [];

    for (const folder of projectChunkFolders) {
      if (!folder.id || !folder.name) continue;

      try {
        const contentResponse = await drive.files.list({
          q: `'${folder.id}' in parents and trashed=false`,
          fields: 'files(id, name, mimeType)',
        });

        const files = contentResponse.data.files || [];
        
        const indexFile = files.find(f => f.name === '_complete_index.json');
        let metadata = {
          themes: [] as string[],
          totalChunks: 0,
          originalFile: folder.name.replace('_Chunks', '') + '.pdf'
        };

        if (indexFile?.id) {
          try {
            const indexResponse = await drive.files.get({
              fileId: indexFile.id,
              alt: 'media'
            });

            let indexData;
            const responseData = indexResponse.data;
            const dataType = typeof responseData;
            
            console.log(`🔍 [RAG Knowledge] Index file data type for ${folder.name}: ${dataType}`);
            
            if (dataType === 'string') {
              indexData = JSON.parse(responseData as string);
              console.log(`📝 [RAG Knowledge] Parsed JSON string for ${folder.name}`);
            } else if (dataType === 'object' && responseData !== null) {
              indexData = responseData;
              console.log(`📦 [RAG Knowledge] Used object directly for ${folder.name}`);
            } else {
              throw new Error(`Unexpected data format: ${dataType}, value: ${responseData}`);
            }

            if (indexData && typeof indexData === 'object') {
              metadata = {
                themes: Array.isArray(indexData.metadata?.themes) ? indexData.metadata.themes : [],
                totalChunks: typeof indexData.metadata?.totalChunks === 'number' ? indexData.metadata.totalChunks : 0,
                originalFile: typeof indexData.metadata?.originalFile === 'string' ? indexData.metadata.originalFile : metadata.originalFile
              };
              console.log(`✅ [RAG Knowledge] Successfully parsed metadata for ${folder.name}: ${metadata.totalChunks} chunks, ${metadata.themes.length} themes`);
            } else {
              throw new Error('Invalid index data structure');
            }
          } catch (indexError) {
            console.warn(`⚠️ [RAG Knowledge] Could not parse index file for ${folder.name}:`, indexError);
            console.warn(`🔧 [RAG Knowledge] Using fallback metadata for ${folder.name}`);
          }
        } else {
          const themeFiles = files.filter(f => 
            f.name?.endsWith('.json') && 
            f.name !== '_complete_index.json'
          );
          metadata.themes = themeFiles.map(f => f.name?.replace('.json', '') || '').filter(Boolean);
        }

        const originalFileName = metadata.originalFile;
        const description = generateDescription(metadata.themes, metadata.totalChunks);

        knowledgeItems.push({
          id: folder.id,
          name: folder.name || '',
          originalFileName,
          folderName: folder.name || '',
          createdTime: folder.createdTime || new Date().toISOString(),
          themes: metadata.themes,
          totalChunks: metadata.totalChunks,
          projectId: folder.projectId,
          projectName: folder.projectName || 'Unknown Project',
          description
        });

        console.log(`✅ [RAG Knowledge] Processed ${folder.name}: ${metadata.themes.length} themes, ${metadata.totalChunks} chunks`);

      } catch (folderError) {
        console.error(`❌ [RAG Knowledge] Error processing folder ${folder.name}:`, folderError);
      }
    }

    console.log(`🎉 [RAG Knowledge] Retrieved ${knowledgeItems.length} knowledge items`);

    return NextResponse.json({
      success: true,
      items: knowledgeItems
    });

  } catch (error) {
    console.error('❌ [RAG Knowledge] Error listing knowledge items:', error);
    return NextResponse.json(
      { 
        error: 'Failed to retrieve knowledge items',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

function generateDescription(themes: string[], totalChunks: number): string {
  if (themes.length === 0) {
    return `Document with ${totalChunks} processed chunks`;
  }

  const themeList = themes.slice(0, 3).join(', ');
  const moreThemes = themes.length > 3 ? ` +${themes.length - 3} more` : '';
  
  return `${totalChunks} chunks covering: ${themeList}${moreThemes}`;
}
