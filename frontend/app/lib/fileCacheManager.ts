
interface CachedFile {
  id: string;
  fileName: string;
  mimeType: string;
  blob: Blob;
  timestamp: number;
  size: number;
}

interface FileMetadata {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  downloadUrl?: string;
}

class FileCacheManager {
  private memoryCache = new Map<string, CachedFile>();
  private metadataCache = new Map<string, FileMetadata>();
  private dbName = 'GoogleDriveFileCache';
  private dbVersion = 1;
  private maxMemoryCacheSize = 50 * 1024 * 1024;
  private maxStorageCacheSize = 200 * 1024 * 1024;
  private defaultTTL = 24 * 60 * 60 * 1000;
  
  private async openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        
        if (!db.objectStoreNames.contains('files')) {
          const filesStore = db.createObjectStore('files', { keyPath: 'id' });
          filesStore.createIndex('timestamp', 'timestamp');
          filesStore.createIndex('size', 'size');
        }
        
        if (!db.objectStoreNames.contains('metadata')) {
          const metadataStore = db.createObjectStore('metadata', { keyPath: 'id' });
          metadataStore.createIndex('modifiedTime', 'modifiedTime');
        }
      };
    });
  }

  private getCurrentMemoryUsage(): number {
    let totalSize = 0;
    for (const [, file] of this.memoryCache) {
      totalSize += file.size;
    }
    return totalSize;
  }

  private async getCurrentStorageUsage(): Promise<number> {
    try {
      const db = await this.openDB();
      const transaction = db.transaction(['files'], 'readonly');
      const store = transaction.objectStore('files');
      const request = store.getAll();
      
      return new Promise((resolve, reject) => {
        request.onsuccess = () => {
          const files = request.result as CachedFile[];
          const totalSize = files.reduce((sum, file) => sum + file.size, 0);
          resolve(totalSize);
        };
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.warn('Error calculating storage usage:', error);
      return 0;
    }
  }

  private async evictOldestMemory(): Promise<void> {
    if (this.memoryCache.size === 0) return;
    
    let oldestTimestamp = Date.now();
    let oldestKey = '';
    
    for (const [key, file] of this.memoryCache) {
      if (file.timestamp < oldestTimestamp) {
        oldestTimestamp = file.timestamp;
        oldestKey = key;
      }
    }
    
    if (oldestKey) {
      this.memoryCache.delete(oldestKey);
      console.log(`Evicted file from memory cache: ${oldestKey}`);
    }
  }

  private async evictOldestStorage(): Promise<void> {
    try {
      const db = await this.openDB();
      const transaction = db.transaction(['files'], 'readwrite');
      const store = transaction.objectStore('files');
      const index = store.index('timestamp');
      const request = index.openCursor();
      
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          const file = cursor.value as CachedFile;
          console.log(`Evicting file from storage: ${file.id}`);
          cursor.delete();
          return;
        }
      };
    } catch (error) {
      console.warn('Error evicting from storage:', error);
    }
  }

  async cacheFileMetadata(metadata: FileMetadata): Promise<void> {
    this.metadataCache.set(metadata.id, metadata);
    
    try {
      const db = await this.openDB();
      const transaction = db.transaction(['metadata'], 'readwrite');
      const store = transaction.objectStore('metadata');
      await store.put(metadata);
    } catch (error) {
      console.warn('Error caching metadata:', error);
    }
  }

  async getFileMetadata(fileId: string): Promise<FileMetadata | null> {
    if (this.metadataCache.has(fileId)) {
      return this.metadataCache.get(fileId)!;
    }
    
    try {
      const db = await this.openDB();
      const transaction = db.transaction(['metadata'], 'readonly');
      const store = transaction.objectStore('metadata');
      const request = store.get(fileId);
      
      return new Promise((resolve, reject) => {
        request.onsuccess = () => {
          const metadata = request.result as FileMetadata;
          if (metadata) {
            this.metadataCache.set(fileId, metadata);
            resolve(metadata);
          } else {
            resolve(null);
          }
        };
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.warn('Error retrieving metadata:', error);
      return null;
    }
  }

  async cacheFile(fileId: string, fileName: string, mimeType: string, blob: Blob): Promise<void> {
    const cachedFile: CachedFile = {
      id: fileId,
      fileName,
      mimeType,
      blob,
      timestamp: Date.now(),
      size: blob.size
    };

    const currentMemoryUsage = this.getCurrentMemoryUsage();
    if (currentMemoryUsage + blob.size > this.maxMemoryCacheSize) {
      await this.evictOldestMemory();
    }
    
    this.memoryCache.set(fileId, cachedFile);
    console.log(`Cached file in memory: ${fileName} (${blob.size} bytes)`);

    try {
      const currentStorageUsage = await this.getCurrentStorageUsage();
      if (currentStorageUsage + blob.size > this.maxStorageCacheSize) {
        await this.evictOldestStorage();
      }

      const db = await this.openDB();
      const transaction = db.transaction(['files'], 'readwrite');
      const store = transaction.objectStore('files');
      await store.put(cachedFile);
      console.log(`Cached file in storage: ${fileName}`);
    } catch (error) {
      console.warn('Error caching file to storage:', error);
    }
  }

  async getCachedFile(fileId: string, maxAge: number = this.defaultTTL): Promise<File | null> {
    const now = Date.now();
    
    if (this.memoryCache.has(fileId)) {
      const cachedFile = this.memoryCache.get(fileId)!;
      if (now - cachedFile.timestamp < maxAge) {
        console.log(`Retrieved file from memory cache: ${cachedFile.fileName}`);
        return new File([cachedFile.blob], cachedFile.fileName, { type: cachedFile.mimeType });
      } else {
        this.memoryCache.delete(fileId);
      }
    }

    try {
      const db = await this.openDB();
      const transaction = db.transaction(['files'], 'readonly');
      const store = transaction.objectStore('files');
      const request = store.get(fileId);
      
      return new Promise((resolve, reject) => {
        request.onsuccess = () => {
          const cachedFile = request.result as CachedFile;
          if (cachedFile && now - cachedFile.timestamp < maxAge) {
            this.memoryCache.set(fileId, cachedFile);
            console.log(`Retrieved file from storage cache: ${cachedFile.fileName}`);
            resolve(new File([cachedFile.blob], cachedFile.fileName, { type: cachedFile.mimeType }));
          } else if (cachedFile) {
            this.invalidateFile(fileId);
            resolve(null);
          } else {
            resolve(null);
          }
        };
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.warn('Error retrieving from cache:', error);
      return null;
    }
  }

  async invalidateFile(fileId: string): Promise<void> {
    this.memoryCache.delete(fileId);
    this.metadataCache.delete(fileId);
    
    try {
      const db = await this.openDB();
      const transaction = db.transaction(['files', 'metadata'], 'readwrite');
      const filesStore = transaction.objectStore('files');
      const metadataStore = transaction.objectStore('metadata');
      
      await Promise.all([
        filesStore.delete(fileId),
        metadataStore.delete(fileId)
      ]);
      console.log(`Invalidated cached file: ${fileId}`);
    } catch (error) {
      console.warn('Error invalidating cache:', error);
    }
  }

  async clearCache(): Promise<void> {
    this.memoryCache.clear();
    this.metadataCache.clear();
    
    try {
      const db = await this.openDB();
      const transaction = db.transaction(['files', 'metadata'], 'readwrite');
      await Promise.all([
        transaction.objectStore('files').clear(),
        transaction.objectStore('metadata').clear()
      ]);
      console.log('Cleared all cached files');
    } catch (error) {
      console.warn('Error clearing cache:', error);
    }
  }

  async getCacheStats(): Promise<{
    memoryUsage: number;
    storageUsage: number;
    memoryFiles: number;
    storageFiles: number;
    maxMemory: number;
    maxStorage: number;
  }> {
    const memoryUsage = this.getCurrentMemoryUsage();
    const storageUsage = await this.getCurrentStorageUsage();
    
    let storageFiles = 0;
    try {
      const db = await this.openDB();
      const transaction = db.transaction(['files'], 'readonly');
      const store = transaction.objectStore('files');
      const request = store.count();
      
      storageFiles = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.warn('Error getting storage file count:', error);
    }

    return {
      memoryUsage,
      storageUsage,
      memoryFiles: this.memoryCache.size,
      storageFiles,
      maxMemory: this.maxMemoryCacheSize,
      maxStorage: this.maxStorageCacheSize
    };
  }

  async batchGetMetadata(fileIds: string[]): Promise<Map<string, FileMetadata>> {
    const results = new Map<string, FileMetadata>();
    const uncachedIds: string[] = [];
    
    for (const id of fileIds) {
      if (this.metadataCache.has(id)) {
        results.set(id, this.metadataCache.get(id)!);
      } else {
        uncachedIds.push(id);
      }
    }
    
    if (uncachedIds.length === 0) return results;
    
    try {
      const db = await this.openDB();
      const transaction = db.transaction(['metadata'], 'readonly');
      const store = transaction.objectStore('metadata');
      
      const promises = uncachedIds.map(id => 
        new Promise<void>((resolve, reject) => {
          const request = store.get(id);
          request.onsuccess = () => {
            if (request.result) {
              const metadata = request.result as FileMetadata;
              results.set(id, metadata);
              this.metadataCache.set(id, metadata);
            }
            resolve();
          };
          request.onerror = () => reject(request.error);
        })
      );
      
      await Promise.all(promises);
    } catch (error) {
      console.warn('Error batch fetching metadata:', error);
    }
    
    return results;
  }

  async preloadFiles(fileIds: string[], token: string): Promise<void> {
    const uncachedFiles = [];
    
    for (const fileId of fileIds) {
      const cached = await this.getCachedFile(fileId);
      if (!cached) {
        uncachedFiles.push(fileId);
      }
    }
    
    if (uncachedFiles.length === 0) return;
    
    console.log(`Preloading ${uncachedFiles.length} uncached files...`);
    
    const BATCH_SIZE = 3;
    for (let i = 0; i < uncachedFiles.length; i += BATCH_SIZE) {
      const batch = uncachedFiles.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async fileId => {
          try {
            const metadata = await this.getFileMetadata(fileId);
            if (metadata) {
              const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
                headers: { 'Authorization': `Bearer ${token}` }
              });
              
              if (response.ok) {
                const blob = await response.blob();
                await this.cacheFile(fileId, metadata.name, metadata.mimeType, blob);
              }
            }
          } catch (error) {
            console.warn(`Error preloading file ${fileId}:`, error);
          }
        })
      );
    }
  }
}

export const fileCacheManager = new FileCacheManager();

export const getCachedFile = (fileId: string, maxAge?: number) => 
  fileCacheManager.getCachedFile(fileId, maxAge);

export const cacheFile = (fileId: string, fileName: string, mimeType: string, blob: Blob) =>
  fileCacheManager.cacheFile(fileId, fileName, mimeType, blob);

export const invalidateFile = (fileId: string) =>
  fileCacheManager.invalidateFile(fileId);

export const getCacheStats = () =>
  fileCacheManager.getCacheStats();

export const clearCache = () =>
  fileCacheManager.clearCache();

export default fileCacheManager; 