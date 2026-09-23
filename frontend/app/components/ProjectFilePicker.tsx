'use client';

import React, { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { FaChevronDown, FaChevronUp, FaFile, FaFilePdf, FaFileWord, FaFileAlt, FaTimes } from 'react-icons/fa';
import { useProjectState } from './ProjectStateContext';
import { isPickableFile, MAX_FILE_SIZE_BYTES } from '../lib/fileValidation';

interface ProjectFile {
  id: string;
  name: string;
  mimeType: string;
  type: 'File' | 'Folder';
  size?: number;
}

interface ProjectFolder {
  id: string;
  name: string;
  files?: ProjectFile[];
}

export interface SelectedFile {
  id: string;
  name: string;
  mimeType: string;
  folderId: string;
  folderName: string;
  size?: number;
}

interface ProjectFilePickerProps {
  onFilesSelected: (files: SelectedFile[]) => void;
  selectedFiles: SelectedFile[];
  acceptsFile?: (mimeType: string, name: string) => boolean;
}

const getFileIcon = (mimeType: string) => {
  if (!mimeType) return <FaFile className="text-gray-400" />;
  
  if (mimeType === 'application/pdf') return <FaFilePdf className="text-red-500" />;
  if (mimeType === 'application/vnd.google-apps.document' || 
      mimeType === 'application/msword' || 
      mimeType.includes('wordprocessingml')) return <FaFileWord className="text-blue-500" />;
  if (mimeType.startsWith('image/')) return <FaFile className="text-green-500" />;
  if (mimeType.startsWith('text/')) return <FaFileAlt className="text-gray-500" />;
  return <FaFile className="text-gray-400" />;
};

const getFileValidation = (file: ProjectFile, acceptsFile: (mimeType: string, name: string) => boolean = isPickableFile): { isValid: boolean; warning?: string } => {
  if (!acceptsFile(file.mimeType, file.name)) {
    return {
      isValid: false,
      warning: `Unsupported format for AI agents. Supported formats: Images, PDF, Audio, Video files.`
    };
  }

  if (file.size && file.size > MAX_FILE_SIZE_BYTES) {
    return {
      isValid: false,
      warning: `File exceeds the 30MB limit.`
    };
  }

  return { isValid: true };
};

const ProjectFilePicker: React.FC<ProjectFilePickerProps> = ({
  onFilesSelected,
  selectedFiles,
  acceptsFile = isPickableFile,
}) => {
  const { data: session } = useSession();
  const { projectFolder } = useProjectState();
  const [projectFolders, setProjectFolders] = useState<ProjectFolder[]>([]);
  const [folderContents, setFolderContents] = useState<Record<string, ProjectFile[]>>({});
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<ProjectFile[]>([]);
  const [searchLoading, setSearchLoading] = useState<boolean>(false);
  const [showMoreFolders, setShowMoreFolders] = useState<boolean>(false);

  const token = session?.accessToken as string | undefined;

  const primaryFolders = ['PDFs', 'Audio', 'Video', 'Images', 'Code'];

  const isPrimaryFolder = (folderName: string) => primaryFolders.includes(folderName);

  const primaryFoldersList = projectFolders.filter(folder => isPrimaryFolder(folder.name));
  const secondaryFoldersList = projectFolders.filter(folder => !isPrimaryFolder(folder.name));

  const fetchProjectFolders = async () => {
    if (!projectFolder?.projectId) return;

    setLoading(true);
    try {
      const response = await fetch(
        `/api/projects/${projectFolder.projectId}/folders/folder_id/${projectFolder.projectId}/contents`,
        { cache: 'no-store' }
      );
      
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error((data as { error?: string })?.error || `Failed to fetch folders (${response.status})`);
      }
      const folders = (data as { files?: ProjectFile[] }).files?.filter((file: ProjectFile) => file.type === 'Folder') || [];
      setProjectFolders(folders.map((folder: ProjectFile) => ({
        id: folder.id,
        name: folder.name,
        files: undefined
      })));
    } catch (error) {
      console.error('Error fetching project folders:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchFolderContents = async (folderId: string) => {
    if (folderContents[folderId]) return;

    try {
      const response = await fetch(
        `/api/projects/${projectFolder?.projectId}/folders/folder_id/${folderId}/contents`,
        { cache: 'no-store' }
      );
      
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error((data as { error?: string })?.error || `Failed to fetch folder contents (${response.status})`);
      }
      setFolderContents(prev => ({ ...prev, [folderId]: (data as { files?: ProjectFile[] }).files || [] }));
    } catch (error) {
      console.error('Error fetching folder contents:', error);
    }
  };

  const toggleFolder = async (folderId: string) => {
    if (!expandedFolders.has(folderId)) {
      await fetchFolderContents(folderId);
    }
    
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  };

  const toggleFileSelection = (file: ProjectFile, folderId: string, folderName: string) => {
    const fileId = file.id;
    const isSelected = selectedFiles.some(f => f.id === fileId);
    
    let newSelectedFiles: SelectedFile[];
    if (isSelected) {
      newSelectedFiles = selectedFiles.filter(f => f.id !== fileId);
    } else {
      newSelectedFiles = [...selectedFiles, {
        id: fileId,
        name: file.name,
        mimeType: file.mimeType,
        folderId,
        folderName,
        size: file.size
      }];
    }
    
    onFilesSelected(newSelectedFiles);
  };

  const clearAllSelections = () => {
    onFilesSelected([]);
  };

  const toggleSearchFileSelection = (file: ProjectFile) => {
    const fileId = file.id;
    const isSelected = selectedFiles.some(f => f.id === fileId);
    
    let newSelectedFiles: SelectedFile[];
    if (isSelected) {
      newSelectedFiles = selectedFiles.filter(f => f.id !== fileId);
    } else {
      newSelectedFiles = [...selectedFiles, {
        id: fileId,
        name: file.name,
        mimeType: file.mimeType,
        folderId: 'search-result',
        folderName: 'Search Result',
        size: file.size
      }];
    }
    
    onFilesSelected(newSelectedFiles);
  };

  const searchGoogleDrive = async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }

    setSearchLoading(true);
    try {
      const params = new URLSearchParams({
        project_id: projectFolder?.projectId || '',
        q: query.trim(),
        max_results: '50'
      });
      const response = await fetch(`/api/files-search?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error((data as { error?: string })?.error || `Search failed (${response.status})`);
      }
      const files = ((data as { files?: Array<{ id: string; name: string; mimeType: string; size?: number }> }).files || []).map((file) => ({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        type: 'File' as const
      }));
      setSearchResults(files);
    } catch (error) {
      console.error('Error searching Google Drive:', error);
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  };

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (searchQuery.trim()) {
        searchGoogleDrive(searchQuery);
      } else {
        setSearchResults([]);
      }
    }, 500);

    return () => clearTimeout(timeoutId);
  }, [searchQuery, token]);

  useEffect(() => {
    if (!projectFolder?.projectId) {
      setLoading(false);
      return;
    }
    fetchProjectFolders().catch((err) => {
      console.warn('ProjectFilePicker: Could not load folders:', err?.message || err);
    });
  }, [projectFolder?.projectId, token]);

  if (!session) return <p>Please sign in to browse project files.</p>;

  return (
    <div className="project-file-picker">
      <h2 className="collection-header">
        Project Files
      </h2>
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      
      {selectedFiles.length > 0 && (
        <div style={{ 
          marginBottom: '1rem', 
          padding: '0.75rem', 
          backgroundColor: '#f0f9ff', 
          border: '1px solid #11074A',
          borderRadius: '8px',
          fontSize: '0.9rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}>
          <span style={{ color: '#11074A', fontWeight: '600' }}>
            <strong>Selected:</strong> {selectedFiles.length} file{selectedFiles.length !== 1 ? 's' : ''}
          </span>
          <button
            onClick={clearAllSelections}
            style={{
              background: 'none',
              border: 'none',
              color: '#ef4444',
              cursor: 'pointer',
              padding: '0.5rem',
              borderRadius: '6px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.2s ease'
            }}
            onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#fee2e2'}
            onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            title="Clear all selections"
          >
            <FaTimes size={16} />
          </button>
        </div>
      )}

      {}
      <input
        type="text"
        placeholder="Search Google Drive files..."
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        style={{
          width: '100%',
          padding: '0.75rem',
          border: '1px solid #AFA8BA',
          borderRadius: '8px',
          fontSize: '0.9rem',
          outline: 'none',
          transition: 'all 0.2s ease',
          marginBottom: '50px'
        }}
        onFocus={(e) => e.target.style.borderColor = '#11074A'}
        onBlur={(e) => e.target.style.borderColor = '#AFA8BA'}
      />

        {}
        {searchQuery.trim() && (
          <div style={{ marginBottom: '0' }}>
            {searchLoading ? (
              <div style={{ 
                textAlign: 'center', 
                padding: '1rem', 
                color: '#6b7280',
                fontStyle: 'italic'
              }}>
                Searching Google Drive...
              </div>
            ) : searchResults.length > 0 ? (
              <div>
                <h4 style={{ 
                  margin: '0 0 0.5rem 0', 
                  fontSize: '0.95rem', 
                  color: '#374151',
                  fontWeight: '600'
                }}>
                  Search Results ({searchResults.length})
                </h4>
                <div style={{ maxHeight: '200px', overflowY: 'auto', width: '99%' }}>
                  {searchResults.map(file => {
                    const isSelected = selectedFiles.some(f => f.id === file.id);
                    const validation = getFileValidation(file, acceptsFile);
                    
                    return (
                      <div
                        key={file.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          padding: '0',
                          marginBottom: '0',
                          backgroundColor: isSelected ? '#f0f4fc' : (!validation.isValid ? '#fef3f2' : '#ffffff'),
                          border: `1px solid ${isSelected ? '#11074A' : (!validation.isValid ? '#f87171' : '#AFA8BA')}`,
                          borderRadius: '4px',
                          cursor: 'pointer',
                          transition: 'all 0.2s',
                          fontSize: '0.9rem',
                          opacity: !validation.isValid ? 0.7 : 1,
                          width: '100%'
                        }}
                        onClick={() => {
                          if (!validation.isValid) {
                            alert(`${file.name}\n\n${validation.warning}`);
                            return;
                          }
                          toggleSearchFileSelection(file);
                        }}
                        onMouseOver={(e) => {
                          if (!isSelected && validation.isValid) {
                            e.currentTarget.style.backgroundColor = '#f8fafc';
                            e.currentTarget.style.borderColor = '#4A4453';
                          }
                        }}
                        onMouseOut={(e) => {
                          if (!isSelected) {
                            e.currentTarget.style.backgroundColor = validation.isValid ? '#ffffff' : '#fef3f2';
                            e.currentTarget.style.borderColor = validation.isValid ? '#AFA8BA' : '#f87171';
                          }
                        }}
                        title={!validation.isValid ? validation.warning : undefined}
                      >
                      {getFileIcon(file.mimeType)}
                      <span style={{ marginLeft: '0.5rem', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {file.name}
                      </span>
                      {file.size !== undefined && (
                        <span style={{ fontSize: '0.75rem', color: '#6c757d', marginRight: '8px', whiteSpace: 'nowrap' }}>
                          {(file.size / (1024 * 1024)).toFixed(1)} MB
                        </span>
                      )}
                      {!validation.isValid && (
                          <span style={{ 
                            color: '#dc2626', 
                            fontSize: '0.7rem', 
                            fontWeight: '500',
                            marginLeft: '0.5rem',
                            backgroundColor: '#fee2e2',
                            padding: '2px 6px',
                            borderRadius: '4px'
                          }}>
                            ⚠ Unsupported
                          </span>
                        )}
                        {isSelected && validation.isValid && (
                          <span style={{ 
                            color: '#11074A', 
                            fontSize: '0.8rem', 
                            fontWeight: '600',
                            marginLeft: '0.5rem'
                          }}>
                            ✓ Selected
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div style={{ 
                textAlign: 'center', 
                padding: '1rem', 
                color: '#6b7280',
                fontStyle: 'italic'
              }}>
                No files found for "{searchQuery}"
              </div>
            )}
          </div>
        )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '2rem', color: '#666' }}>
          Loading project folders...
        </div>
      ) : projectFolders.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '2rem', color: '#666' }}>
          No folders found in project
        </div>
              ) : (
        <div className="folders-list">
          {primaryFoldersList.map(folder => {
            const files = folderContents[folder.id] || [];
            const allFiles = files.filter(file => file.type === 'File');
            const isExpanded = expandedFolders.has(folder.id);

            return (
            <div key={folder.id} className="folder-container" style={{ marginBottom: '0', width: '100%' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0.5rem',
                  border: '0px solid #e5e7eb',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  transition: 'background-color 0.2s'
                }}
                onClick={() => toggleFolder(folder.id)}
                onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#f0f4fc'}
                onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
              >
                {isExpanded ? <FaChevronUp style={{ marginRight: '0.5rem' }} /> : <FaChevronDown style={{ marginRight: '0.5rem' }} />}
                <span style={{ fontWeight: '500' }}>{folder.name}</span>
                {isExpanded && allFiles.length > 0 && (
                  <span style={{ 
                    marginLeft: 'auto', 
                    fontSize: '0.8rem', 
                    color: '#11074A',
                    backgroundColor: '#f0f4fc',
                    padding: '4px 8px',
                    borderRadius: '12px',
                    fontWeight: '500'
                  }}>
                    {allFiles.length} file{allFiles.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>

              {isExpanded && (
                <div style={{ marginLeft: '0', marginTop: '0.5rem' }}>
                  {files.length === 0 ? (
                    <div style={{ padding: '0.5rem', color: '#6b7280', fontSize: '0.9rem' }}>
                      No files in this folder
                    </div>
                  ) : allFiles.length === 0 ? (
                    <div style={{ padding: '0.5rem', color: '#6b7280', fontSize: '0.9rem' }}>
                      No files in this folder
                    </div>
                  ) : (
                    allFiles.map(file => {
                      const isSelected = selectedFiles.some(f => f.id === file.id);
                      const validation = getFileValidation(file, acceptsFile);
                      
                      return (
                        <div
                          key={file.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            padding: '0',
                            marginBottom: '0',
                            backgroundColor: isSelected ? '#f0f4fc' : (!validation.isValid ? '#fef3f2' : '#ffffff'),
                            border: `1px solid ${isSelected ? '#11074A' : (!validation.isValid ? '#f87171' : '#AFA8BA')}`,
                            borderRadius: '6px',
                            cursor: 'pointer',
                            transition: 'all 0.2s',
                            fontSize: '0.9rem',
                            opacity: !validation.isValid ? 0.7 : 1,
                            width: '100%'
                          }}
                          onClick={() => {
                            if (!validation.isValid) {
                              alert(`${file.name}\n\n${validation.warning}`);
                              return;
                            }
                            toggleFileSelection(file, folder.id, folder.name);
                          }}
                          onMouseOver={(e) => {
                            if (!isSelected && validation.isValid) {
                              e.currentTarget.style.backgroundColor = '#f8fafc';
                              e.currentTarget.style.borderColor = '#4A4453';
                            }
                          }}
                          onMouseOut={(e) => {
                            if (!isSelected) {
                              e.currentTarget.style.backgroundColor = validation.isValid ? '#ffffff' : '#fef3f2';
                              e.currentTarget.style.borderColor = validation.isValid ? '#AFA8BA' : '#f87171';
                            }
                          }}
                          title={!validation.isValid ? validation.warning : undefined}
                        >
                          {getFileIcon(file.mimeType)}
                          <span style={{ marginLeft: '0.5rem', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {file.name}
                          </span>
                          {file.size !== undefined && (
                            <span style={{ fontSize: '0.75rem', color: '#6c757d', marginRight: '8px', whiteSpace: 'nowrap' }}>
                              {(file.size / (1024 * 1024)).toFixed(1)} MB
                            </span>
                          )}
                          {!validation.isValid && (
                            <span style={{ 
                              color: '#dc2626', 
                              fontSize: '0.7rem', 
                              fontWeight: '500',
                              marginLeft: '0.5rem',
                              backgroundColor: '#fee2e2',
                              padding: '2px 6px',
                              borderRadius: '4px'
                            }}>
                              ⚠ Unsupported
                            </span>
                          )}
                          {isSelected && validation.isValid && (
                            <span style={{ 
                              color: '#11074A', 
                              fontSize: '0.8rem', 
                              fontWeight: '600',
                              marginLeft: '0.5rem'
                            }}>
                              ✓ Selected
                            </span>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}

        {}
        {secondaryFoldersList.length > 0 && (
          <div style={{ marginTop: '1rem', borderTop: '1px solid #e5e7eb', paddingTop: '1rem' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '0.5rem',
                backgroundColor: showMoreFolders ? '#f9fafb' : 'transparent',
                border: '1px solid #e5e7eb',
                borderRadius: '6px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                marginBottom: showMoreFolders ? '0.5rem' : '0'
              }}
              onClick={() => setShowMoreFolders(!showMoreFolders)}
              onMouseOver={(e) => {
                if (!showMoreFolders) {
                  e.currentTarget.style.backgroundColor = '#f8fafc';
                  e.currentTarget.style.borderColor = '#4A4453';
                }
              }}
              onMouseOut={(e) => {
                if (!showMoreFolders) {
                  e.currentTarget.style.backgroundColor = 'transparent';
                  e.currentTarget.style.borderColor = '#e5e7eb';
                }
              }}
            >
              {showMoreFolders ? <FaChevronUp style={{ marginRight: '0.5rem' }} /> : <FaChevronDown style={{ marginRight: '0.5rem' }} />}
              <span style={{ fontWeight: '500', color: '#6b7280' }}>More Folders</span>
              <span style={{ 
                marginLeft: 'auto', 
                fontSize: '0.8rem', 
                color: '#6b7280',
                backgroundColor: '#f3f4f6',
                padding: '4px 8px',
                borderRadius: '12px',
                fontWeight: '500'
              }}>
                {secondaryFoldersList.length} folder{secondaryFoldersList.length !== 1 ? 's' : ''}
              </span>
            </div>

            {showMoreFolders && (
              <div style={{ marginLeft: '0' }}>
                {secondaryFoldersList.map(folder => {
                  const files = folderContents[folder.id] || [];
                  const allFiles = files.filter(file => file.type === 'File');
                  const isExpanded = expandedFolders.has(folder.id);

                  return (
                    <div key={folder.id} className="folder-container" style={{ marginBottom: '0', width: '100%' }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          padding: '0.5rem',
                          border: '0px solid #e5e7eb',
                          borderRadius: '6px',
                          cursor: 'pointer',
                          transition: 'background-color 0.2s'
                        }}
                        onClick={() => toggleFolder(folder.id)}
                        onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#f0f4fc'}
                        onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                      >
                        {isExpanded ? <FaChevronUp style={{ marginRight: '0.5rem' }} /> : <FaChevronDown style={{ marginRight: '0.5rem' }} />}
                        <span style={{ fontWeight: '500' }}>{folder.name}</span>
                        {isExpanded && allFiles.length > 0 && (
                          <span style={{ 
                            marginLeft: 'auto', 
                            fontSize: '0.8rem', 
                            color: '#11074A',
                            backgroundColor: '#f0f4fc',
                            padding: '4px 8px',
                            borderRadius: '12px',
                            fontWeight: '500'
                          }}>
                            {allFiles.length} file{allFiles.length !== 1 ? 's' : ''}
                          </span>
                        )}
                      </div>

                      {isExpanded && (
                        <div style={{ marginLeft: '0', marginTop: '0.5rem' }}>
                          {files.length === 0 ? (
                            <div style={{ padding: '0.5rem', color: '#6b7280', fontSize: '0.9rem' }}>
                              No files in this folder
                            </div>
                          ) : allFiles.length === 0 ? (
                            <div style={{ padding: '0.5rem', color: '#6b7280', fontSize: '0.9rem' }}>
                              No files in this folder
                            </div>
                          ) : (
                            allFiles.map(file => {
                              const isSelected = selectedFiles.some(f => f.id === file.id);
                              const validation = getFileValidation(file, acceptsFile);
                              
                              return (
                                <div
                                  key={file.id}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    padding: '0',
                                    marginBottom: '0',
                                    backgroundColor: isSelected ? '#f0f4fc' : (!validation.isValid ? '#fef3f2' : '#ffffff'),
                                    border: `1px solid ${isSelected ? '#11074A' : (!validation.isValid ? '#f87171' : '#AFA8BA')}`,
                                    borderRadius: '6px',
                                    cursor: 'pointer',
                                    transition: 'all 0.2s',
                                    fontSize: '0.9rem',
                                    opacity: !validation.isValid ? 0.7 : 1,
                                    width: '100%'
                                  }}
                                  onClick={() => {
                                    if (!validation.isValid) {
                                      alert(`${file.name}\n\n${validation.warning}`);
                                      return;
                                    }
                                    toggleFileSelection(file, folder.id, folder.name);
                                  }}
                                  onMouseOver={(e) => {
                                    if (!isSelected && validation.isValid) {
                                      e.currentTarget.style.backgroundColor = '#f8fafc';
                                      e.currentTarget.style.borderColor = '#4A4453';
                                    }
                                  }}
                                  onMouseOut={(e) => {
                                    if (!isSelected) {
                                      e.currentTarget.style.backgroundColor = validation.isValid ? '#ffffff' : '#fef3f2';
                                      e.currentTarget.style.borderColor = validation.isValid ? '#AFA8BA' : '#f87171';
                                    }
                                  }}
                                  title={!validation.isValid ? validation.warning : undefined}
                                >
                                  {getFileIcon(file.mimeType)}
                                  <span style={{ marginLeft: '0.5rem', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {file.name}
                                  </span>
                                  {file.size !== undefined && (
                                    <span style={{ fontSize: '0.75rem', color: '#6c757d', marginRight: '8px', whiteSpace: 'nowrap' }}>
                                      {(file.size / (1024 * 1024)).toFixed(1)} MB
                                    </span>
                                  )}
                                  {!validation.isValid && (
                                    <span style={{ 
                                      color: '#dc2626', 
                                      fontSize: '0.7rem', 
                                      fontWeight: '500',
                                      marginLeft: '0.5rem',
                                      backgroundColor: '#fee2e2',
                                      padding: '2px 6px',
                                      borderRadius: '4px'
                                    }}>
                                      ⚠ Unsupported
                                    </span>
                                  )}
                                  {isSelected && validation.isValid && (
                                    <span style={{ 
                                      color: '#11074A', 
                                      fontSize: '0.8rem', 
                                      fontWeight: '600',
                                      marginLeft: '0.5rem'
                                    }}>
                                      ✓ Selected
                                    </span>
                                  )}
                                </div>
                              );
                            })
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        </div>
      )}
      </div>
    </div>
  );
};

export default ProjectFilePicker; 