
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresAt: number;
}

const CACHE_DURATION = 24 * 60 * 60 * 1000;

export class CacheManager {
  static set<T>(key: string, data: T, durationMs: number = CACHE_DURATION): void {
    const now = Date.now();
    const entry: CacheEntry<T> = {
      data,
      timestamp: now,
      expiresAt: now + durationMs,
    };
    
    try {
      localStorage.setItem(key, JSON.stringify(entry));
    } catch (error) {
      console.warn('[CacheManager] Failed to store in cache:', error);
    }
  }

  static get<T>(key: string): T | null {
    try {
      const item = localStorage.getItem(key);
      if (!item) return null;

      const entry: CacheEntry<T> = JSON.parse(item);
      const now = Date.now();

      if (now > entry.expiresAt) {
        console.log(`[CacheManager] Cache expired for key: ${key}`);
        this.remove(key);
        return null;
      }

      console.log(`[CacheManager] Cache hit for key: ${key}, age: ${Math.round((now - entry.timestamp) / 1000 / 60)} minutes`);
      return entry.data;
    } catch (error) {
      console.warn('[CacheManager] Failed to read from cache:', error);
      return null;
    }
  }

  static has(key: string): boolean {
    return this.get(key) !== null;
  }

  static remove(key: string): void {
    try {
      localStorage.removeItem(key);
      console.log(`[CacheManager] Removed cache for key: ${key}`);
    } catch (error) {
      console.warn('[CacheManager] Failed to remove from cache:', error);
    }
  }

  static clearExpired(): number {
    let cleared = 0;
    const now = Date.now();

    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;

        try {
          const item = localStorage.getItem(key);
          if (!item) continue;

          const entry: CacheEntry<unknown> = JSON.parse(item);
          
          if (entry.expiresAt && now > entry.expiresAt) {
            localStorage.removeItem(key);
            cleared++;
            console.log(`[CacheManager] Cleared expired cache: ${key}`);
          }
        } catch {
          continue;
        }
      }

      if (cleared > 0) {
        console.log(`[CacheManager] Cleared ${cleared} expired cache entries`);
      }
    } catch (error) {
      console.warn('[CacheManager] Failed to clear expired caches:', error);
    }

    return cleared;
  }

  static clearApplicationCache(): void {
    try {
      const appCacheKeys = [
        'alma-videos-registry',
        'alma-videos-channels',
        'alma-videos-',
      ];
      
      let cleared = 0;
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (!key) continue;
        
        const isAppCache = appCacheKeys.some(prefix => key.startsWith(prefix));
        
        if (isAppCache) {
          localStorage.removeItem(key);
          cleared++;
          console.log(`[CacheManager] Cleared application cache: ${key}`);
        }
      }
      
      console.log(`[CacheManager] Cleared ${cleared} application cache entries (auth preserved)`);
    } catch (error) {
      console.warn('[CacheManager] Failed to clear application caches:', error);
    }
  }

  static clearAll(): void {
    try {
      localStorage.clear();
      console.log('[CacheManager] localStorage cleared');
      
      sessionStorage.clear();
      console.log('[CacheManager] sessionStorage cleared');
      
      const cookies = document.cookie.split(';');
      for (let i = 0; i < cookies.length; i++) {
        const cookie = cookies[i];
        const eqPos = cookie.indexOf('=');
        const name = eqPos > -1 ? cookie.substring(0, eqPos).trim() : cookie.trim();
        
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
        
        const domain = window.location.hostname;
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=${domain};`;
        
        const parts = domain.split('.');
        if (parts.length > 1) {
          const parentDomain = parts.slice(-2).join('.');
          document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=.${parentDomain};`;
        }
      }
      console.log(`[CacheManager] ${cookies.length} cookies cleared`);
      
      if ('caches' in window) {
        caches.keys().then((names) => {
          names.forEach((name) => {
            caches.delete(name);
          });
          console.log(`[CacheManager] ${names.length} service worker caches cleared`);
        });
      }
      
      if ('indexedDB' in window) {
        indexedDB.databases?.().then((databases) => {
          databases.forEach((db) => {
            if (db.name) {
              indexedDB.deleteDatabase(db.name);
              console.log(`[CacheManager] IndexedDB '${db.name}' cleared`);
            }
          });
        }).catch((error) => {
          console.warn('[CacheManager] Failed to clear IndexedDB:', error);
        });
      }
      
      console.log('[CacheManager] All caches and cookies cleared (like "Delete saved data")');
    } catch (error) {
      console.warn('[CacheManager] Failed to clear all caches:', error);
    }
  }

  static getCacheAge(key: string): number | null {
    try {
      const item = localStorage.getItem(key);
      if (!item) return null;

      const entry: CacheEntry<unknown> = JSON.parse(item);
      const now = Date.now();
      const ageMinutes = Math.round((now - entry.timestamp) / 1000 / 60);
      
      return ageMinutes;
    } catch {
      return null;
    }
  }

  static getTimeUntilExpiry(key: string): number | null {
    try {
      const item = localStorage.getItem(key);
      if (!item) return null;

      const entry: CacheEntry<unknown> = JSON.parse(item);
      const now = Date.now();
      
      if (now > entry.expiresAt) {
        return 0;
      }
      
      const minutesRemaining = Math.round((entry.expiresAt - now) / 1000 / 60);
      return minutesRemaining;
    } catch {
      return null;
    }
  }

  static async fetchWithCache<T>(
    key: string,
    fetcher: () => Promise<T>,
    forceRefresh = false
  ): Promise<T> {
    if (!forceRefresh) {
      const cached = this.get<T>(key);
      if (cached !== null) {
        return cached;
      }
    }

    const data = await fetcher();
    
    this.set(key, data);
    
    return data;
  }
}

if (typeof window !== 'undefined') {
  CacheManager.clearExpired();
  
  setInterval(() => {
    CacheManager.clearExpired();
  }, 60 * 60 * 1000);
}

