'use client';

import React, { useState, useEffect } from 'react';
import { FaDatabase, FaTrash, FaSync, FaInfoCircle } from 'react-icons/fa';

interface CacheStats {
  memoryUsage: number;
  storageUsage: number;
  memoryFiles: number;
  storageFiles: number;
  maxMemory: number;
  maxStorage: number;
}

const FileCacheManagerComponent: React.FC = () => {
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getUsagePercentage = (used: number, max: number): number => {
    return Math.round((used / max) * 100);
  };

  const getUsageColor = (percentage: number): string => {
    if (percentage < 50) return 'bg-green-500';
    if (percentage < 80) return 'bg-yellow-500';
    return 'bg-red-500';
  };

  const loadCacheStats = async () => {
    setIsLoading(true);
    try {
      const { getCacheStats } = await import('../lib/fileCacheManager');
      const stats = await getCacheStats();
      setCacheStats(stats);
      setLastUpdated(new Date());
    } catch (error) {
      console.error('Error loading cache stats:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const clearCache = async () => {
    if (!confirm('Are you sure you want to clear all cached files? This will remove all downloaded files from cache.')) {
      return;
    }

    setIsLoading(true);
    try {
      const { clearCache } = await import('../lib/fileCacheManager');
      await clearCache();
      await loadCacheStats();
      alert('Cache cleared successfully!');
    } catch (error) {
      console.error('Error clearing cache:', error);
      alert('Failed to clear cache');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadCacheStats();
  }, []);

  if (!cacheStats) {
    return (
      <div className="p-0">
        <div className="bg-gray-50 px-4 py-3 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <FaDatabase className="w-4 h-4 text-gray-600" />
            <span className="text-sm font-medium text-gray-900">Cache Manager</span>
          </div>
        </div>
        <div className="p-4 text-center">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 text-gray-600">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-400"></div>
              <span className="text-sm">Loading...</span>
            </div>
          ) : (
            <span className="text-sm text-gray-500">Unable to load statistics</span>
          )}
        </div>
      </div>
    );
  }

  const memoryPercentage = getUsagePercentage(cacheStats.memoryUsage, cacheStats.maxMemory);
  const storagePercentage = getUsagePercentage(cacheStats.storageUsage, cacheStats.maxStorage);

  return (
    <div className="p-0">
      {}
      <div className="bg-gray-50 px-4 py-3 border-b border-gray-100">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FaDatabase className="w-4 h-4 text-gray-600" />
            <span className="text-sm font-medium text-gray-900">Cache Manager</span>
          </div>
          <div className="flex gap-1">
            <button
              onClick={loadCacheStats}
              disabled={isLoading}
              className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-200 rounded-md transition-colors duration-200 disabled:opacity-50"
              title="Refresh stats"
            >
              <FaSync className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={clearCache}
              disabled={isLoading}
              className="p-1.5 text-red-500 hover:text-red-700 hover:bg-red-100 rounded-md transition-colors duration-200 disabled:opacity-50"
              title="Clear all cache"
            >
              <FaTrash className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>

      {}
      <div className="p-4 space-y-4">
        {}
        <div className="grid grid-cols-2 gap-3">
          <div className="text-center">
            <div className="text-xs text-gray-500 mb-1">Memory</div>
            <div className="text-sm font-medium text-gray-900">{formatBytes(cacheStats.memoryUsage)}</div>
            <div className="text-xs text-gray-500">{cacheStats.memoryFiles} files</div>
            <div className="w-full bg-gray-200 rounded-full h-1.5 mt-2">
              <div 
                className={`h-1.5 rounded-full transition-all duration-300 ${getUsageColor(memoryPercentage)}`}
                style={{ width: `${memoryPercentage}%` }}
              ></div>
            </div>
          </div>
          
          <div className="text-center">
            <div className="text-xs text-gray-500 mb-1">Storage</div>
            <div className="text-sm font-medium text-gray-900">{formatBytes(cacheStats.storageUsage)}</div>
            <div className="text-xs text-gray-500">{cacheStats.storageFiles} files</div>
            <div className="w-full bg-gray-200 rounded-full h-1.5 mt-2">
              <div 
                className={`h-1.5 rounded-full transition-all duration-300 ${getUsageColor(storagePercentage)}`}
                style={{ width: `${storagePercentage}%` }}
              ></div>
            </div>
          </div>
        </div>

        {}
        <div className="bg-gray-50 rounded-lg p-3">
          <div className="text-xs text-gray-500 mb-2">Usage Limits</div>
          <div className="space-y-1 text-xs">
            <div className="flex justify-between">
              <span>Memory limit:</span>
              <span className="font-medium">{formatBytes(cacheStats.maxMemory)}</span>
            </div>
            <div className="flex justify-between">
              <span>Storage limit:</span>
              <span className="font-medium">{formatBytes(cacheStats.maxStorage)}</span>
            </div>
          </div>
        </div>

        {}
        <div className="bg-blue-50 rounded-lg p-3">
          <div className="flex items-start gap-2">
            <FaInfoCircle className="w-3 h-3 text-blue-600 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-blue-800">
              <div className="font-medium mb-1">Benefits:</div>
              <ul className="space-y-0.5 text-xs">
                <li>• Reduces API calls</li>
                <li>• Faster file access</li>
                <li>• Works offline</li>
                <li>• Auto cleanup (24h TTL)</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {}
      {lastUpdated && (
        <div className="bg-gray-50 px-4 py-2 border-t border-gray-100">
          <div className="text-xs text-gray-400 text-center">
            Updated: {lastUpdated.toLocaleTimeString()}
          </div>
        </div>
      )}
    </div>
  );
};

export default FileCacheManagerComponent; 