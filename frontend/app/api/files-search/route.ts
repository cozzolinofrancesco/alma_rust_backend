import { NextResponse } from 'next/server';
import { google, drive_v3 } from 'googleapis';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { createCorsResponse, createCorsErrorResponse } from '../../lib/cors';

interface CacheEntry {
  data: FileResult[];
  timestamp: number;
}
const searchCache = new Map<string, CacheEntry>();
const CACHE_TTL = 3 * 60 * 1000;

interface SearchParams {
  projectId?: string;
  folderId?: string;
  query?: string;
  fileTypes?: string[];
  includeSubfolders?: boolean;
  maxResults?: number;
}

interface FileResult {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdTime?: string;
  modifiedTime?: string;
  folderPath: string;
  webViewLink?: string;
  thumbnailLink?: string;
  type: 'File' | 'Folder';
}

export async function GET(request: Request) {
  try {
    const session = await getApiSession(request);
    if (!session?.accessToken) {
      return createCorsErrorResponse('Not authenticated', 401);
    }

    const url = new URL(request.url);
    const searchParams: SearchParams = {
      projectId: url.searchParams.get('project_id') || undefined,
      folderId: url.searchParams.get('folder_id') || undefined,
      query: url.searchParams.get('q') || undefined,
      fileTypes: url.searchParams.get('file_types')?.split(',') || undefined,
      includeSubfolders: url.searchParams.get('include_subfolders') !== 'false',
      maxResults: parseInt(url.searchParams.get('max_results') || '100')
    };

    const cacheKey = `search_${JSON.stringify(searchParams)}_${session.user?.email}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      console.log('Returning cached search results');
      return createCorsResponse({ 
        files: cached.data, 
        cached: true,
        count: cached.data.length 
      });
    }

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

    const searchResults = await searchFilesOptimized(drive, searchParams);

    searchCache.set(cacheKey, {
      data: searchResults,
      timestamp: Date.now()
    });

    console.log(`Found ${searchResults.length} files matching search criteria`);
    return createCorsResponse({ 
      files: searchResults, 
      cached: false,
      count: searchResults.length,
      query: buildSearchQuery(searchParams)
    });

  } catch (error: unknown) {
    console.error('Error in optimized file search:', error);
    return createCorsErrorResponse(
      error instanceof Error ? error.message : 'Unknown error',
      500
    );
  }
}

function buildSearchQuery(params: SearchParams): string {
  const { projectId, folderId, query, fileTypes, includeSubfolders } = params;

  let searchQuery = 'trashed = false';

  if (projectId || folderId) {
    const parentId = folderId || projectId;
    if (includeSubfolders) {
      searchQuery += ` and '${parentId}' in parents`;
    } else {
      searchQuery += ` and '${parentId}' in parents`;
    }
  }

  if (fileTypes && fileTypes.length > 0) {
    const mimeTypeQueries = fileTypes.map(type => {
      switch (type.toLowerCase()) {
        case 'pdf': return "mimeType='application/pdf'";
        case 'image': return "mimeType contains 'image/'";
        case 'document': return "mimeType contains 'document'";
        case 'spreadsheet': return "mimeType contains 'spreadsheet'";
        case 'presentation': return "mimeType contains 'presentation'";
        case 'folder': return "mimeType='application/vnd.google-apps.folder'";
        case 'text': return "mimeType='text/plain'";
        case 'video': return "mimeType contains 'video/'";
        case 'audio': return "mimeType contains 'audio/'";
        default: return `mimeType contains '${type}'`;
      }
    });
    searchQuery += ` and (${mimeTypeQueries.join(' or ')})`;
  } else {
    searchQuery += ` and mimeType != 'application/vnd.google-apps.folder'`;
  }

  if (query) {
    const escapedQuery = query.replace(/'/g, "\\'");
    searchQuery += ` and (name contains '${escapedQuery}' or fullText contains '${escapedQuery}')`;
  }

  return searchQuery;
}

async function getAllFolderIds(drive: drive_v3.Drive, rootFolderId: string): Promise<string[]> {
  const folderIds = [rootFolderId];
  const processedIds = new Set<string>();
  
  for (let i = 0; i < folderIds.length; i++) {
    const currentId = folderIds[i];
    if (processedIds.has(currentId)) continue;
    
    processedIds.add(currentId);
    
    try {
      const response = await drive.files.list({
        q: `'${currentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      
      const subfolders = response.data.files || [];
      for (const folder of subfolders) {
        if (folder.id && !processedIds.has(folder.id)) {
          folderIds.push(folder.id);
        }
      }
    } catch (error) {
      console.error(`Error fetching subfolders for ${currentId}:`, error);
    }
  }
  
  return folderIds;
}

async function searchFilesOptimized(
  drive: drive_v3.Drive, 
  params: SearchParams
): Promise<FileResult[]> {
  const { maxResults, includeSubfolders, projectId, folderId } = params;
  
  let searchQueries: string[] = [];
  
  if (includeSubfolders && (projectId || folderId)) {
    const rootId = folderId || projectId!;
    const allFolderIds = await getAllFolderIds(drive, rootId);
    console.log(`Found ${allFolderIds.length} folders to search in`);
    
    searchQueries = allFolderIds.map(fId => {
      const baseParams = { ...params, folderId: fId, includeSubfolders: false };
      return buildSearchQuery(baseParams);
    });
  } else {
    searchQueries = [buildSearchQuery(params)];
  }

  console.log(`Optimized search queries: ${searchQueries.length} queries`);

  const allFiles: drive_v3.Schema$File[] = [];
  
  for (const searchQuery of searchQueries) {
    let pageToken: string | undefined = undefined;

  do {
    try {
      const { data }: { data: drive_v3.Schema$FileList } = await drive.files.list({
        q: searchQuery,
        fields: 'nextPageToken, files(id, name, mimeType, size, createdTime, modifiedTime, parents, webViewLink, thumbnailLink)',
        pageSize: Math.min(1000, maxResults || 1000),
        pageToken,
        orderBy: 'modifiedTime desc',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      const files = data.files || [];
      allFiles.push(...files);
      pageToken = data.nextPageToken || undefined;

      console.log(`Fetched ${files.length} files in this page, total: ${allFiles.length}`);

      if (maxResults && allFiles.length >= maxResults) {
        break;
      }

    } catch (error: unknown) {
      console.error('Error in search page:', error);
      if (error instanceof Error && 'response' in error) {
        const apiError = error as Error & { response?: { status?: number; data?: unknown } };
        if (apiError.response?.status === 400) {
          console.error('Invalid query syntax:', searchQuery);
          console.error('Error details:', apiError.response.data);
        }
      }
      break;
    }
  } while (pageToken);
  
  if (maxResults && allFiles.length >= maxResults) {
    break;
  }
}

  console.log(`Found ${allFiles.length} files total`);

  const enhancedFiles = await processBatch(
    allFiles.slice(0, maxResults || 100),
    async (file) => {
      let folderPath = '';
      if (file.parents && file.parents.length > 0) {
        try {
          const parentFolder = await drive.files.get({
            fileId: file.parents[0],
            fields: 'name',
            supportsAllDrives: true,
          });
          folderPath = parentFolder.data.name || '';
        } catch {
          folderPath = 'Unknown Folder';
        }
      }

      return {
        id: file.id!,
        name: file.name!,
        mimeType: file.mimeType!,
        size: file.size ? parseInt(file.size) : 0,
        createdTime: file.createdTime,
        modifiedTime: file.modifiedTime,
        folderPath,
        webViewLink: file.webViewLink,
        thumbnailLink: file.thumbnailLink,
        type: file.mimeType === 'application/vnd.google-apps.folder' ? 'Folder' : 'File'
      } as FileResult;
    },
    5
  );

  return enhancedFiles;
}

async function processBatch<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  batchSize: number = 5
): Promise<R[]> {
  const results: R[] = [];
  
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(processor)
    );
    results.push(...batchResults);
  }
  
  return results;
}

export async function POST(request: Request) {
  try {
    const session = await getApiSession(request);
    if (!session?.accessToken) {
      return createCorsErrorResponse('Not authenticated', 401);
    }

    const body = await request.json();
    const {
      projectId,
      searchCriteria = {},
      advanced = false
    } = body;

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

    if (advanced) {
      return await advancedFileSearch(drive, projectId, searchCriteria);
    }

    return createCorsErrorResponse('Invalid request', 400);

  } catch (error: unknown) {
    console.error('Error in advanced file search:', error);
    return createCorsErrorResponse(
      error instanceof Error ? error.message : 'Unknown error',
      500
    );
  }
}

interface AdvancedSearchCriteria {
  nameContains?: string;
  contentContains?: string;
  fileTypes?: string[];
  dateRange?: {
    from?: string;
    to?: string;
  };
  sizeRange?: {
    min?: number;
    max?: number;
  };
  sharedWith?: string;
  modifiedBy?: string;
  starred?: boolean;
  maxResults?: number;
}

async function advancedFileSearch(
  drive: drive_v3.Drive,
  projectId: string,
  criteria: AdvancedSearchCriteria
): Promise<NextResponse> {
  const {
    nameContains,
    contentContains,
    fileTypes = [],
    dateRange,
    starred = false,
    maxResults = 100
  } = criteria;

  const queries: string[] = ['trashed = false'];

  if (projectId) {
    queries.push(`'${projectId}' in parents`);
  }

  if (nameContains) {
    queries.push(`name contains '${nameContains.replace(/'/g, "\\'")}'`);
  }

  if (contentContains) {
    queries.push(`fullText contains '${contentContains.replace(/'/g, "\\'")}'`);
  }

  if (fileTypes.length > 0) {
    const typeQueries = fileTypes.map((type: string) => `mimeType contains '${type}'`);
    queries.push(`(${typeQueries.join(' or ')})`);
  }

  if (dateRange?.from) {
    queries.push(`modifiedTime >= '${dateRange.from}'`);
  }

  if (dateRange?.to) {
    queries.push(`modifiedTime <= '${dateRange.to}'`);
  }

  if (starred) {
    queries.push('starred = true');
  }

  const finalQuery = queries.join(' and ');
  console.log(`Advanced search query: ${finalQuery}`);

  const response = await drive.files.list({
    q: finalQuery,
    fields: 'files(id, name, mimeType, size, createdTime, modifiedTime, starred, shared, webViewLink)',
    pageSize: maxResults,
    orderBy: 'modifiedTime desc',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  return NextResponse.json({ 
    files: response.data.files || [],
    query: finalQuery,
    count: response.data.files?.length || 0,
    searchCriteria: criteria
  });
} 