import { drive_v3, google } from 'googleapis';
import { TextChunk } from './rag';

interface ChunkFileData {
  metadata: {
    originalFile: string;
    title: string;
    theme: string;
    pages: string;
    processedAt: string;
    totalChunks: number;
    description: string;
    embeddingStatus?: 'complete' | 'partial' | 'missing';
    chunksWithEmbeddings?: number;
    chunksWithoutEmbeddings?: number;
    embeddingsFixedAt?: string;
    version?: number;
  };
  chunks: TextChunk[];
}

export async function checkExistingChunkFolder(drive: drive_v3.Drive, folderName: string, parentFolderId?: string): Promise<{ exists: boolean; folderId?: string }> {
  try {
    let query = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;

    if (parentFolderId) {
      query += ` and '${parentFolderId}' in parents`;
    }

    const response = await drive.files.list({
      q: query,
      fields: 'files(id, name)'
    });

    const existingFolders = response.data.files || [];
    if (existingFolders.length > 0) {
      return { exists: true, folderId: existingFolders[0].id ?? undefined };
    }
    return { exists: false };
  } catch (error) {
    console.error('❌ [RAG-GDRIVE] Error checking existing folders:', error);
    return { exists: false };
  }
}

async function deleteChunkFolder(drive: drive_v3.Drive, folderId: string, folderName: string): Promise<void> {
  try {
    console.log(`🗑️ [RAG-GDRIVE] Deleting existing folder: ${folderName}`);
    await drive.files.delete({ fileId: folderId });
    console.log(`✅ [RAG-GDRIVE] Deleted existing folder: ${folderName}`);
  } catch (error) {
    console.error(`❌ [RAG-GDRIVE] Error deleting folder ${folderName}:`, error);
    throw new Error(`Failed to delete existing folder: ${error}`);
  }
}

export async function createChunksFolder(
  originalFileName: string,
  chunks: TextChunk[],
  auth: drive_v3.Options['auth'],
  replaceExisting: boolean = false,
  parentFolderId?: string
): Promise<string> {
  const drive = google.drive({ version: 'v3', auth });
  const baseName = originalFileName.replace(/\.pdf$/i, '');
  const folderName = `${baseName}_Chunks`;

  const parentContext = parentFolderId ? ` in project RAG folder ${parentFolderId}` : ' in root';
  console.log(`📁 [RAG-GDRIVE] Checking for existing chunk folder: ${folderName}${parentContext}`);

  const existingFolder = await checkExistingChunkFolder(drive, folderName, parentFolderId);

  if (existingFolder.exists) {
    console.log(`⚠️ [RAG-GDRIVE] Chunk folder already exists: ${folderName}`);

    if (!replaceExisting) {
      console.log(`📋 [RAG-GDRIVE] Skipping creation - folder already exists: ${folderName}`);
      return folderName;
    }

    await deleteChunkFolder(drive, existingFolder.folderId!, folderName);
    console.log(`🔄 [RAG-GDRIVE] Replacing existing folder: ${folderName}`);
  }

  console.log(`📁 [RAG-GDRIVE] Creating chunk folder: ${folderName}${parentContext}`);

  const folderRequest: drive_v3.Schema$File = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder'
  };

  if (parentFolderId) {
    folderRequest.parents = [parentFolderId];
  }

  const folder = await drive.files.create({
    requestBody: folderRequest
  });

  const folderId = folder.data.id!;
  console.log(`✅ [RAG-GDRIVE] Created folder with ID: ${folderId}`);

  const themeGroups = groupChunksByTheme(chunks);
  console.log(`🎯 [RAG-GDRIVE] Detected themes: ${Object.keys(themeGroups).join(', ')}`);

  for (const [theme, themeChunks] of Object.entries(themeGroups)) {
    const chunksWithoutEmbeddings = themeChunks.filter(chunk => !chunk.embedding);
    if (chunksWithoutEmbeddings.length > 0) {
      console.warn(`⚠️ [RAG-GDRIVE] Theme ${theme} has ${chunksWithoutEmbeddings.length} chunks without embeddings - they will need fixing later`);
    }

    const chunkFile: ChunkFileData = {
      metadata: {
        originalFile: originalFileName,
        title: `${theme} Analysis`,
        theme: theme,
        pages: getPageRange(themeChunks),
        processedAt: new Date().toISOString(),
        totalChunks: themeChunks.length,
        description: getThemeDescription(theme),
        embeddingStatus: chunksWithoutEmbeddings.length > 0 ? 'partial' : 'complete',
        chunksWithEmbeddings: themeChunks.length - chunksWithoutEmbeddings.length,
        chunksWithoutEmbeddings: chunksWithoutEmbeddings.length
      },
      chunks: themeChunks
    };

    console.log(`💾 [RAG-GDRIVE] Saving ${theme}.json with ${themeChunks.length} chunks (${chunkFile.metadata.chunksWithEmbeddings} with embeddings)`);

    await drive.files.create({
      requestBody: {
        name: `${theme}.json`,
        parents: [folderId]
      },
      media: {
        mimeType: 'application/json',
        body: JSON.stringify(chunkFile, null, 2)
      }
    });
  }

  console.log(`📋 [RAG-GDRIVE] Creating complete index with ${chunks.length} total chunks`);

  await drive.files.create({
    requestBody: {
      name: '_complete_index.json',
      parents: [folderId]
    },
    media: {
      mimeType: 'application/json',
      body: JSON.stringify({
        metadata: {
          originalFile: originalFileName,
          totalChunks: chunks.length,
          processedAt: new Date().toISOString(),
          themes: Object.keys(themeGroups)
        },
        allChunks: chunks
      }, null, 2)
    }
  });

  console.log(`🎉 [RAG-GDRIVE] Successfully created chunk folder: ${folderName}`);
  return folderName;
}

function groupChunksByTheme(chunks: TextChunk[]): Record<string, TextChunk[]> {
  const themes: Record<string, TextChunk[]> = {
    'Overview': [],
    'Endpoints': [],
    'Statistics': [],
    'Results': [],
    'Safety': [],
    'References': []
  };

  chunks.forEach(chunk => {
    const text = chunk.text.toLowerCase();

    if (text.includes('primary endpoint') || text.includes('secondary endpoint') || text.includes('outcome measure')) {
      themes.Endpoints.push(chunk);
    } else if (text.includes('adverse') || text.includes('safety') || text.includes('tolerability') || text.includes('side effect')) {
      themes.Safety.push(chunk);
    } else if (text.includes('statistical') || text.includes('analysis plan') || text.includes('methodology') || text.includes('power calculation')) {
      themes.Statistics.push(chunk);
    } else if (text.includes('results') || text.includes('efficacy') || text.includes('findings') || text.includes('outcome')) {
      themes.Results.push(chunk);
    } else if (text.includes('reference') || text.includes('bibliography') || text.includes('citation') || text.includes('appendix')) {
      themes.References.push(chunk);
    } else {
      themes.Overview.push(chunk);
    }
  });

  return Object.fromEntries(
    Object.entries(themes).filter(([, chunks]) => chunks.length > 0)
  );
}

function getPageRange(chunks: TextChunk[]): string {
  const pageNumbers: number[] = [];

  chunks.forEach(chunk => {
    const pageMatch = chunk.source.match(/pages?\s+(\d+)(?:-(\d+))?/i);
    if (pageMatch) {
      const startPage = parseInt(pageMatch[1]);
      const endPage = pageMatch[2] ? parseInt(pageMatch[2]) : startPage;
      pageNumbers.push(startPage, endPage);
    }
  });

  if (pageNumbers.length === 0) return 'unknown';

  const minPage = Math.min(...pageNumbers);
  const maxPage = Math.max(...pageNumbers);

  return minPage === maxPage ? `${minPage}` : `${minPage}-${maxPage}`;
}

function getThemeDescription(theme: string): string {
  const descriptions: Record<string, string> = {
    'Overview': 'Study design, methodology, and background information',
    'Endpoints': 'Primary and secondary endpoints, outcome measures',
    'Statistics': 'Statistical methodology, analysis plans, and power calculations',
    'Results': 'Efficacy results, primary outcomes, and key findings',
    'Safety': 'Adverse events, safety monitoring, and tolerability data',
    'References': 'Bibliography, citations, and supporting literature'
  };

  return descriptions[theme] || 'Document content and analysis';
}

async function updateChunkFilesWithEmbeddings(
  drive: drive_v3.Drive,
  filesToUpdate: Array<{ file: drive_v3.Schema$File; chunkData: ChunkFileData; chunks: TextChunk[] }>
): Promise<void> {
  console.log(`💾 [RAG-GDRIVE] Updating ${filesToUpdate.length} files with new embeddings...`);

  for (const { file, chunkData, chunks } of filesToUpdate) {
    try {
      const fileChunks = chunks.filter(chunk =>
        file.name && (chunk.source === file.name || chunk.source.includes(file.name))
      );

      chunkData.chunks = fileChunks;

      if (chunkData.metadata) {
        chunkData.metadata.embeddingsFixedAt = new Date().toISOString();
        chunkData.metadata.version = (chunkData.metadata.version || 1) + 0.1;
      }

      if (file.id) {
        await drive.files.update({
          fileId: file.id,
          media: {
            mimeType: 'application/json',
            body: JSON.stringify(chunkData, null, 2)
          }
        });
      }

      console.log(`✅ [RAG-GDRIVE] Updated ${file.name} with embeddings`);

    } catch (updateError) {
      console.error(`❌ [RAG-GDRIVE] Failed to update ${file.name}:`, updateError);
    }
  }

  console.log(`🎉 [RAG-GDRIVE] Completed embedding updates`);
}

export async function loadChunkFile(file: File): Promise<TextChunk[]> {
  try {
    const content = await file.text();
    const chunkData = JSON.parse(content) as ChunkFileData;

    if (!chunkData.chunks || !Array.isArray(chunkData.chunks)) {
      throw new Error('Invalid chunk file format - missing chunks array');
    }

    if (!chunkData.metadata) {
      throw new Error('Invalid chunk file format - missing metadata');
    }

    console.log(`📚 [RAG-GDRIVE] Loaded ${chunkData.chunks.length} pre-computed chunks from ${chunkData.metadata.theme || file.name}`);
    console.log(`📄 [RAG-GDRIVE] Theme: ${chunkData.metadata.theme}, Pages: ${chunkData.metadata.pages}`);

    return chunkData.chunks;
  } catch (error) {
    console.error(`❌ [RAG-GDRIVE] Failed to load chunk file ${file.name}:`, error);
    throw new Error(`Invalid chunk file: ${file.name} - ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export function isChunkFile(file: File): boolean {
  if (!file.name.endsWith('.json')) {
    return false;
  }

  if (file.webkitRelativePath && file.webkitRelativePath.includes('_Chunks/')) {
    return true;
  }

  const themeFilePattern = /^(Overview|Endpoints|Statistics|Results|Safety|References|_complete_index)\.json$/;
  return themeFilePattern.test(file.name);
}

export async function getChunkFilesFromDrive(ragKnowledgeId: string, auth: drive_v3.Options['auth'], options?: { readOnly?: boolean; strict?: boolean }): Promise<TextChunk[]> {
  const drive = google.drive({ version: 'v3', auth });

  console.log(`📂 [RAG-GDRIVE] Loading chunk files from folder ID: ${ragKnowledgeId}`);

  try {
    const filesResponse = await drive.files.list({
      q: `'${ragKnowledgeId}' in parents and mimeType='application/json' and name != '_complete_index.json' and trashed=false`,
      fields: 'files(id, name)',
      orderBy: 'name asc'
    });

    const chunkFiles = filesResponse.data.files || [];
    console.log(`📄 [RAG-GDRIVE] Found ${chunkFiles.length} chunk files`);

    const allChunks: TextChunk[] = [];
    const filesToUpdate: Array<{ file: drive_v3.Schema$File; chunkData: ChunkFileData; chunks: TextChunk[] }> = [];

    for (const file of chunkFiles) {
      try {
        const fileResponse = await drive.files.get({
          fileId: file.id!,
          alt: 'media'
        });

        const chunkData = typeof fileResponse.data === 'string'
          ? (JSON.parse(fileResponse.data) as ChunkFileData)
          : (fileResponse.data as ChunkFileData);

        const chunks = chunkData.chunks.map((chunk) => ({
          ...chunk,
          source: file.name || chunk.source,
        }));

        if (chunks.length === 0) {
          console.warn(`⚠️ [RAG-GDRIVE] Chunk file ${file.name} is empty`);
        }

        const missingEmbeddings = chunks.filter(chunk => !chunk.embedding);
        if (missingEmbeddings.length > 0) {
          console.warn(`⚠️ [RAG-GDRIVE] ${file.name} has ${missingEmbeddings.length} chunks without embeddings`);
          filesToUpdate.push({ file, chunkData, chunks });
        }

        allChunks.push(...chunks);

      } catch (fileError) {
        if (options?.strict) throw new Error('Could not read every selected source chunk.');
        console.error(`❌ [RAG-GDRIVE] Failed to load chunk file ${file.name}:`, fileError instanceof Error ? fileError.message : 'Unknown error');
        continue;
      }
    }

    if (filesToUpdate.length > 0 && !options?.readOnly) {
      console.log(`🔧 [RAG-GDRIVE] Fixing embeddings for ${filesToUpdate.length} files...`);
      await updateChunkFilesWithEmbeddings(drive, filesToUpdate);
    }

    console.log(`✅ [RAG-GDRIVE] Loaded ${allChunks.length} total chunks`);
    return allChunks;

  } catch (error) {
    console.error('❌ [RAG-GDRIVE] Failed to load chunk files:', error instanceof Error ? error.message : 'Unknown error');
    throw error;
  }
}
