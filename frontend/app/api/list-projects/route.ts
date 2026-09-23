import { drive_v3, google } from 'googleapis';
import { getApiSession } from '../../lib/apiCaller.server';
import { NextResponse } from 'next/server';
import { cleanupRecentProjectsCache, recentProjectsCache } from '../../lib/recent-projects-cache';
import { getCleanProjectName } from '../../lib/project-constants';

interface ProjectCacheEntry {
  data: Array<ProcessedProjectItem>;
  timestamp: number;
  userEmail: string;
}

interface ProcessedProjectItem {
  id: string | null | undefined;
  name: string | null | undefined;
  displayName: string;
  owners: drive_v3.Schema$User[] | null | undefined;
  createdTime: string | null | undefined;
  modifiedTime: string | null | undefined;
  collaborators: string[];
  almaRootName?: string;
  almaRootOwner?: string;
  isOwnedByCurrentUser: boolean;
  hasUserAccess?: boolean;
  shared: boolean;
}

const projectCache = new Map<string, ProjectCacheEntry>();
const CACHE_TTL = 6 * 30 * 24 * 60 * 60 * 1000;

const generateCacheKey = (userEmail: string): string => {
  return `${userEmail}:GLOBAL`;
};

export async function GET(request: Request) {
  console.log("🚨🚨🚨 LIST-PROJECTS API CALLED!");

  try {
    const session = await getApiSession(request);
    const accessToken = session?.accessToken;
    const refreshToken = session?.refreshToken;

    if (!accessToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const url = new URL(request.url);
    const cacheBust = url.searchParams.get('_cacheBust');
    const userEmail = session?.user?.email;

    console.log(`🔍 LIST-PROJECTS: User ${userEmail}, Global Search Only`);
    if (cacheBust) {
      console.log(`🔥 CACHE BUST DETECTED: Will ignore cache and fetch fresh data`);
    }

    const cacheKey = generateCacheKey(userEmail || 'anonymous');
    const cached = projectCache.get(cacheKey);

    if (!cacheBust && cached && Date.now() - cached.timestamp < CACHE_TTL) {
      console.log(`Cache hit for key: ${cacheKey}`);
      return NextResponse.json({ projects: cached.data });
    }

    console.log(`Cache miss for key: ${cacheKey}, fetching from Google Drive for user: ${userEmail}...`);

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

    console.log("🌐 Global search: Finding ALMA root folders with specific pattern...");

    let allProjects: ProcessedProjectItem[] = [];

    try {
      console.log(`🌐 ENHANCED SEARCH: Looking for ALMA project folders (owned + shared with ${userEmail})`);

      const ownedAlmaQuery = `name contains 'alma_' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
      console.log(`🔍 OWNED ALMA QUERY: ${ownedAlmaQuery}`);
      const ownedResponse = await drive.files.list({
        q: ownedAlmaQuery,
        fields: 'files(id,name,owners,shared,createdTime,modifiedTime)',
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });

      const sharedAlmaQuery = `name contains 'alma_' and mimeType='application/vnd.google-apps.folder' and trashed=false and sharedWithMe=true`;
      console.log(`🔍 SHARED ALMA QUERY: ${sharedAlmaQuery}`);
      const sharedResponse = await drive.files.list({
        q: sharedAlmaQuery,
        fields: 'files(id,name,owners,shared,createdTime,modifiedTime)',
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });

      const ownedAlmaFolders = ownedResponse.data.files || [];
      const sharedAlmaFolders = sharedResponse.data.files || [];

      const isValidAlmaProject = (name: string): boolean => {
        const almaPattern = /^alma_[a-zA-Z0-9 _-]+_\d{13}$/;
        return almaPattern.test(name);
      };

      const validOwnedProjects = ownedAlmaFolders.filter(folder =>
        folder.name && isValidAlmaProject(folder.name)
      );
      const validSharedProjects = sharedAlmaFolders.filter(folder =>
        folder.name && isValidAlmaProject(folder.name)
      );

      console.log(`📁 OWNED ALMA PROJECTS: Found ${validOwnedProjects.length}/${ownedAlmaFolders.length} valid projects`);
      validOwnedProjects.forEach(f => console.log(`   ✅ ${f.name} (${f.id})`));

      console.log(`🤝 SHARED ALMA PROJECTS: Found ${validSharedProjects.length}/${sharedAlmaFolders.length} valid projects`);
      validSharedProjects.forEach(f => console.log(`   ✅ ${f.name} (${f.id})`));

      const seenIds = new Set<string>();
      const allValidProjects = [...validOwnedProjects, ...validSharedProjects].filter((f) => {
        if (!f.id || seenIds.has(f.id)) return false;
        seenIds.add(f.id);
        return true;
      });

      allProjects = allValidProjects.map(project => ({
        id: project.id,
        name: project.name,
        displayName: getCleanProjectName(project.name || ''),
        owners: project.owners,
        createdTime: project.createdTime,
        modifiedTime: project.modifiedTime,
        almaRootName: project.name,
        almaRootOwner: project.owners?.[0]?.emailAddress || project.owners?.[0]?.displayName || '',
        isOwnedByCurrentUser: project.owners?.some(owner => owner.emailAddress?.toLowerCase() === userEmail?.toLowerCase()) || false,
        hasUserAccess: true,
        shared: project.shared || false,
        collaborators: [],
      } as ProcessedProjectItem));
      console.log(`✅ Found ${allProjects.length} total projects across all ALMA roots`);

    } catch (error) {
      console.error('❌ Error during global ALMA root search:', error);
      return NextResponse.json(
        { error: 'Failed to perform global ALMA root search' },
        { status: 500 }
      );
    }

    const processedProjects: ProcessedProjectItem[] = await Promise.all(allProjects.map(async (project) => {
      const isOwnedByCurrentUser = project.owners?.some(owner => owner.emailAddress?.toLowerCase() === userEmail?.toLowerCase()) || false;
      let hasUserAccess = false;
      let collaborators: string[] = [];

      if (!isOwnedByCurrentUser) {
        try {
          const permissionsResponse = await drive.permissions.list({
            fileId: project.id!,
            fields: 'permissions(emailAddress,role)',
            supportsAllDrives: true,
          });
          hasUserAccess = permissionsResponse.data.permissions?.some(perm => perm.emailAddress?.toLowerCase() === userEmail?.toLowerCase()) || false;
          collaborators = permissionsResponse.data.permissions?.map(perm => perm.emailAddress).filter((email): email is string => Boolean(email)) || [];
        } catch (error) {
          console.warn(`⚠️ Could not check permissions for project ${project.name}:`, error);
          hasUserAccess = isOwnedByCurrentUser;
          collaborators = project.owners?.map(owner => owner.emailAddress).filter((email): email is string => Boolean(email)) || [];
        }
      } else {
        collaborators = project.owners?.map(owner => owner.emailAddress).filter((email): email is string => Boolean(email)) || [];
      }

      return {
        id: project.id,
        name: project.name,
        displayName: getCleanProjectName(project.name || ''),
        owners: project.owners,
        createdTime: project.createdTime,
        modifiedTime: project.modifiedTime,
        collaborators: collaborators,
        almaRootName: project.almaRootName,
        almaRootOwner: project.almaRootOwner,
        isOwnedByCurrentUser: isOwnedByCurrentUser,
        hasUserAccess: hasUserAccess,
        shared: project.shared || false,
      } as ProcessedProjectItem;
    }));

    cleanupRecentProjectsCache();
    const recentProjects: ProcessedProjectItem[] = [];

    for (const [projectId, cached] of recentProjectsCache.entries()) {
      if (cached.userEmail === userEmail) {
        const existsInResults = processedProjects.some(p => p.id === projectId);
        if (!existsInResults) {
          recentProjects.push({
            ...cached.project,
            modifiedTime: cached.project.createdTime,
          } as ProcessedProjectItem);
          console.log(`✅ Added recently created project from cache: ${cached.project.name}`);
        }
      }
    }

    const finalProjects = [...processedProjects, ...recentProjects];
    console.log(`📊 Final project count: ${finalProjects.length} (${processedProjects.length} from search + ${recentProjects.length} from cache)`);

    projectCache.set(cacheKey, { data: finalProjects, timestamp: Date.now(), userEmail: userEmail || 'anonymous' });

    return NextResponse.json({ projects: finalProjects });

  } catch (error) {
    console.error('General error in list-projects API:', error);
    return NextResponse.json(
      { error: `Internal server error: ${error instanceof Error ? error.message : 'Unknown error'}` },
      { status: 500 }
    );
  }
}
