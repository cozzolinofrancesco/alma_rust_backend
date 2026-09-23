'use client';

import React, { useState } from 'react';

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

interface SearchResponse {
  files: FileResult[];
  cached: boolean;
  count: number;
  query?: string;
}

export default function OptimizedFileSearch() {
  const [searchParams, setSearchParams] = useState({
    projectId: '',
    folderId: '',
    query: '',
    fileTypes: [] as string[],
    includeSubfolders: true,
    maxResults: 50
  });

  const [searchResults, setSearchResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileTypeOptions = [
    { value: 'pdf', label: 'PDF Files' },
    { value: 'image', label: 'Images' },
    { value: 'document', label: 'Documents' },
    { value: 'spreadsheet', label: 'Spreadsheets' },
    { value: 'presentation', label: 'Presentations' },
    { value: 'video', label: 'Videos' },
    { value: 'audio', label: 'Audio' },
    { value: 'text', label: 'Text Files' },
    { value: 'folder', label: 'Folders' }
  ];

  const handleSearch = async () => {
    if (!searchParams.projectId && !searchParams.folderId) {
      setError('Please provide either a Project ID or Folder ID');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const queryParams = new URLSearchParams();
      
      if (searchParams.projectId) queryParams.set('project_id', searchParams.projectId);
      if (searchParams.folderId) queryParams.set('folder_id', searchParams.folderId);
      if (searchParams.query) queryParams.set('q', searchParams.query);
      if (searchParams.fileTypes.length > 0) queryParams.set('file_types', searchParams.fileTypes.join(','));
      queryParams.set('include_subfolders', searchParams.includeSubfolders.toString());
      queryParams.set('max_results', searchParams.maxResults.toString());

      const response = await fetch(`/api/files-search?${queryParams}`);
      
      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`);
      }

      const data: SearchResponse = await response.json();
      setSearchResults(data);

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleAdvancedSearch = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/files-search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          projectId: searchParams.projectId,
          advanced: true,
          searchCriteria: {
            nameContains: searchParams.query,
            fileTypes: searchParams.fileTypes,
            maxResults: searchParams.maxResults
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Advanced search failed: ${response.statusText}`);
      }

      const data = await response.json();
      setSearchResults({
        files: data.files,
        cached: false,
        count: data.count,
        query: data.query
      });

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleFileTypeChange = (fileType: string) => {
    setSearchParams(prev => ({
      ...prev,
      fileTypes: prev.fileTypes.includes(fileType)
        ? prev.fileTypes.filter(t => t !== fileType)
        : [...prev.fileTypes, fileType]
    }));
  };

  const formatDate = (dateString?: string): string => {
    if (!dateString) return 'N/A';
    return new Date(dateString).toLocaleDateString();
  };

  return (
    <div className="max-w-6xl mx-auto p-6 bg-white rounded-lg shadow-lg">
      <h2 className="text-2xl font-bold mb-6 text-gray-800">
        🚀 Optimized File Search
      </h2>

      {}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Project ID
          </label>
          <input
            type="text"
            value={searchParams.projectId}
            onChange={(e) => setSearchParams(prev => ({ ...prev, projectId: e.target.value }))}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Enter Google Drive folder ID"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Search Query
          </label>
          <input
            type="text"
            value={searchParams.query}
            onChange={(e) => setSearchParams(prev => ({ ...prev, query: e.target.value }))}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Search file names and content..."
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Folder ID (Optional)
          </label>
          <input
            type="text"
            value={searchParams.folderId}
            onChange={(e) => setSearchParams(prev => ({ ...prev, folderId: e.target.value }))}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Specific folder to search in"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Max Results
          </label>
          <input
            type="number"
            value={searchParams.maxResults}
            onChange={(e) => setSearchParams(prev => ({ ...prev, maxResults: parseInt(e.target.value) || 50 }))}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            min="1"
            max="1000"
          />
        </div>
      </div>

      {}
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          File Types (leave empty for all files)
        </label>
        <div className="flex flex-wrap gap-2">
          {fileTypeOptions.map(option => (
            <label key={option.value} className="flex items-center">
              <input
                type="checkbox"
                checked={searchParams.fileTypes.includes(option.value)}
                onChange={() => handleFileTypeChange(option.value)}
                className="mr-2"
              />
              <span className="text-sm">{option.label}</span>
            </label>
          ))}
        </div>
      </div>

      {}
      <div className="mb-6">
        <label className="flex items-center">
          <input
            type="checkbox"
            checked={searchParams.includeSubfolders}
            onChange={(e) => setSearchParams(prev => ({ ...prev, includeSubfolders: e.target.checked }))}
            className="mr-2"
          />
          <span className="text-sm font-medium">Include subfolders (recursive search)</span>
        </label>
      </div>

      {}
      <div className="flex gap-4 mb-6">
        <button
          onClick={handleSearch}
          disabled={loading}
          className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Searching...' : '🔍 Smart Search'}
        </button>

        <button
          onClick={handleAdvancedSearch}
          disabled={loading}
          className="px-6 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Searching...' : '⚡ Advanced Search'}
        </button>
      </div>

      {}
      {error && (
        <div className="mb-4 p-4 bg-red-100 border border-red-400 text-red-700 rounded">
          {error}
        </div>
      )}

      {}
      {searchResults && (
        <div>
          <div className="mb-4 p-4 bg-gray-100 rounded">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-semibold">
                Search Results ({searchResults.count} files)
              </h3>
              <div className="flex gap-4 text-sm text-gray-600">
                {searchResults.cached && (
                  <span className="bg-yellow-200 px-2 py-1 rounded">📋 Cached</span>
                )}
                <span>Query: {searchResults.query}</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 max-h-96 overflow-y-auto">
            {searchResults.files.map((file) => (
              <div key={file.id} className="p-4 border border-gray-200 rounded-lg hover:shadow-md transition-shadow">
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-lg">
                        {file.type === 'Folder' ? '📁' : 
                         file.mimeType.includes('image') ? '🖼️' :
                         file.mimeType.includes('pdf') ? '📄' :
                         file.mimeType.includes('document') ? '📝' :
                         file.mimeType.includes('spreadsheet') ? '📊' :
                         file.mimeType.includes('presentation') ? '📺' :
                         file.mimeType.includes('video') ? '🎥' :
                         file.mimeType.includes('audio') ? '🎵' : '📄'}
                      </span>
                      <h4 className="font-semibold text-gray-800">{file.name}</h4>
                      <span className="text-xs bg-gray-200 px-2 py-1 rounded">{file.type}</span>
                    </div>
                    
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-sm text-gray-600">
                      <div>
                        <span className="font-medium">Folder:</span> {file.folderPath || 'Root'}
                      </div>
                      <div>
                        <span className="font-medium">Created:</span> {formatDate(file.createdTime)}
                      </div>
                      <div>
                        <span className="font-medium">Modified:</span> {formatDate(file.modifiedTime)}
                      </div>
                    </div>
                  </div>
                  
                  {file.webViewLink && (
                    <a
                      href={file.webViewLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-4 px-3 py-1 bg-blue-100 text-blue-700 rounded hover:bg-blue-200 text-sm"
                    >
                      Open
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {}
      <div className="mt-8 p-4 bg-gray-50 rounded-lg">
        <h4 className="font-semibold mb-2">🎯 Smart Features:</h4>
        <ul className="text-sm text-gray-700 space-y-1">
          <li>• <strong>Recursive Search:</strong> Finds files in ALL subfolders with a single API call</li>
          <li>• <strong>Content Search:</strong> Searches inside file content, not just names</li>
          <li>• <strong>Smart Caching:</strong> Results cached for 3 minutes for instant responses</li>
          <li>• <strong>Type Filtering:</strong> Filter by PDF, images, documents, etc.</li>
          <li>• <strong>Batch Processing:</strong> Optimized for large result sets</li>
          <li>• <strong>Native Google Search:</strong> Uses Google Drive's powerful query engine</li>
        </ul>
      </div>
    </div>
  );
} 