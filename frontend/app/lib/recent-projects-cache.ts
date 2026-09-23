interface CachedProjectData {
  id: string;
  name: string;
  displayName: string;
  owners: Array<{ emailAddress: string }>;
  createdTime: string;
  collaborators: string[];
  isOwnedByCurrentUser: boolean;
  hasUserAccess: boolean;
  shared: boolean;
  almaRootName: string;
  almaRootOwner: string;
}

const recentProjectsCache = new Map<string, {
    project: CachedProjectData;
    timestamp: number;
    userEmail: string;
}>();

const cleanupRecentProjectsCache = () => {
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    for (const [key, value] of recentProjectsCache.entries()) {
        if (value.timestamp < fiveMinutesAgo) {
            recentProjectsCache.delete(key);
        }
    }
};

export { cleanupRecentProjectsCache, recentProjectsCache, type CachedProjectData };
