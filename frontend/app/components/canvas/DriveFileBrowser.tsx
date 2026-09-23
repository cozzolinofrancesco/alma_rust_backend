'use client';

import {
    AlertCircle,
    ChevronRight,
    ChevronUp,
    FileText,
    Folder,
    FolderOpen,
    FolderPlus,
    Home,
    Loader2,
    LogIn,
    RefreshCw,
    Search
} from 'lucide-react';
import { signIn, useSession } from 'next-auth/react';
import { useEffect, useState } from 'react';
import { useTheme } from '../../contexts/ThemeContext';
import { ProjectFileService, useProjectContext, type ProjectFile } from './services/projectFileService';

interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
    size?: string;
    modifiedTime?: string;
    webViewLink?: string;
    thumbnailLink?: string;
    parents?: string[];
}

interface DriveFileBrowserProps {
    onFileSelect?: (file: DriveFile) => void;
    onFolderSelect?: (folderId: string) => void;
    showFiles?: boolean;
    showFolders?: boolean;
    fileFilter?: string[];
    selectionMode?: boolean;
}

export default function DriveFileBrowser({
    onFileSelect,
    onFolderSelect,
    showFiles = true,
    showFolders = true,
    fileFilter = [],
    selectionMode = false
}: DriveFileBrowserProps) {
    const { theme } = useTheme();
    const { data: session, status } = useSession();
    const { initializeProjectContext, hasProjectContext, currentProject, fileService } = useProjectContext();

    const [currentFolderId, setCurrentFolderId] = useState<string>('');
    const [folders, setFolders] = useState<DriveFile[]>([]);
    const [files, setFiles] = useState<DriveFile[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [breadcrumbs, setBreadcrumbs] = useState<Array<{ id: string; name: string }>>([
        { id: 'root', name: 'My Drive' }
    ]);
    const [showCreateFolder, setShowCreateFolder] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');
    const [creatingFolder, setCreatingFolder] = useState(false);

    useEffect(() => {
        if (session?.accessToken) {
            const context = initializeProjectContext();
            if (context) {
                console.log('✅ DriveFileBrowser: Project context loaded, fetching data');
                setBreadcrumbs([{ id: 'root', name: 'My Drive' }, { id: context.projectId, name: context.projectName }]);
                setCurrentFolderId(context.projectId);
                fetchData(context.projectId);
            } else {
                setError('No project selected. Please select a project from the main application first.');
            }
        }
    }, [session]);

    useEffect(() => {
        const handleStorageChange = (e: StorageEvent) => {
            if (e.key === 'projectFolder' && session?.accessToken) {
                console.log('📡 DriveFileBrowser: Project context changed, refreshing...');
                setError(null);
                const context = initializeProjectContext();
                if (context) {
                    setBreadcrumbs([{ id: 'root', name: 'My Drive' }, { id: context.projectId, name: context.projectName }]);
                    setCurrentFolderId(context.projectId);
                    fetchData(context.projectId);
                } else {
                    setError('No project selected. Please select a project from the main application first.');
                }
            }
        };

        window.addEventListener('storage', handleStorageChange);
        return () => window.removeEventListener('storage', handleStorageChange);
    }, [session]);

    useEffect(() => {
        const handleWindowFocus = () => {
            if (session?.accessToken) {
                const context = initializeProjectContext();
                if (context && hasProjectContext()) {
                    const currentContext = fileService.getCurrentProject();
                    if (!currentContext || currentContext.projectId !== context.projectId) {
                        console.log('🔄 DriveFileBrowser: Project context refreshed on focus');
                        fetchData();
                    }
                }
            }
        };

        window.addEventListener('focus', handleWindowFocus);
        return () => window.removeEventListener('focus', handleWindowFocus);
    }, [session]);

    const fetchData = async (folderId = currentFolderId) => {
        if (status !== 'authenticated' || !session?.accessToken) {
            setError('Please sign in to access project files');
            return;
        }

        if (!hasProjectContext()) {
            setError('No project context available. Please select a project first.');
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const fileService = ProjectFileService.getInstance();
            let allFolders: ProjectFile[] = [];
            let allFiles: ProjectFile[] = [];

            if (folderId === 'root') {
                console.log('📁 Loading Drive root (My Drive)...');
                const contents = await fileService.getFolderContentsById('root');

                if (showFolders) {
                    allFolders = contents.filter(file =>
                        file.type === 'Folder'
                    );
                }

                if (showFiles) {
                    allFiles = contents.filter(file =>
                        file.type === 'File'
                    );

                    if (fileFilter.length > 0) {
                        allFiles = allFiles.filter(file =>
                            file.mimeType && fileFilter.some(filter => file.mimeType!.includes(filter))
                        );
                    }
                }

                console.log(`📁 Drive root loaded: ${allFolders.length} folders, ${allFiles.length} files`);
            } else if (!folderId || (currentProject && folderId === currentProject.projectId)) {
                console.log('📁 Loading project root contents...');
                const allContents = await fileService.getProjectContents();

                if (showFolders) {
                    allFolders = allContents.filter(file =>
                        file.type === 'Folder'
                    );
                }

                if (showFiles) {
                    allFiles = allContents.filter(file =>
                        file.type === 'File'
                    );

                    if (fileFilter.length > 0) {
                        allFiles = allFiles.filter(file =>
                            file.mimeType && fileFilter.some(filter => file.mimeType!.includes(filter))
                        );
                    }
                }

                console.log(`📁 Project root loaded: ${allFolders.length} folders, ${allFiles.length} files`);
            } else {
                const contents = await fileService.getFolderContentsById(folderId);

                if (showFolders) {
                    allFolders = contents.filter(file =>
                        file.type === 'Folder'
                    );
                }

                if (showFiles) {
                    allFiles = contents.filter(file =>
                        file.type === 'File'
                    );

                    if (fileFilter.length > 0) {
                        allFiles = allFiles.filter(file =>
                            file.mimeType && fileFilter.some(filter => file.mimeType!.includes(filter))
                        );
                    }
                }
            }

            if (search) {
                const searchLower = search.toLowerCase();
                allFolders = allFolders.filter(folder =>
                    folder.name.toLowerCase().includes(searchLower)
                );
                allFiles = allFiles.filter(file =>
                    file.name.toLowerCase().includes(searchLower)
                );
            }

            setFolders(allFolders.map(f => ({
                id: f.id,
                name: f.name,
                mimeType: f.type === 'Folder' ? 'application/vnd.google-apps.folder' : (f.mimeType || 'application/octet-stream'),
                size: f.size,
                modifiedTime: f.modifiedTime,
                webViewLink: f.webViewLink,
                thumbnailLink: f.thumbnailLink,
                parents: f.parents
            })));

            setFiles(allFiles.map(f => ({
                id: f.id,
                name: f.name,
                mimeType: f.type === 'File' ? (f.mimeType || 'application/octet-stream') : f.mimeType || 'application/octet-stream',
                size: f.size,
                modifiedTime: f.modifiedTime,
                webViewLink: f.webViewLink,
                thumbnailLink: f.thumbnailLink,
                parents: f.parents
            })));

        } catch (error) {
            console.error('Error loading files:', error);
            setError(error instanceof Error ? error.message : 'Failed to load files');
        } finally {
            setLoading(false);
        }
    };

    const navigateToFolder = (folderId: string, folderName: string) => {
        setCurrentFolderId(folderId);
        setBreadcrumbs(prev => [...prev, { id: folderId, name: folderName }]);
        fetchData(folderId);

        if (onFolderSelect) {
            onFolderSelect(folderId);
        }
    };

    const navigateToBreadcrumb = (index: number) => {
        const newBreadcrumbs = breadcrumbs.slice(0, index + 1);
        setBreadcrumbs(newBreadcrumbs);

        const targetFolderId = newBreadcrumbs[newBreadcrumbs.length - 1].id;
        setCurrentFolderId(targetFolderId);
        fetchData(targetFolderId);
    };

    const handleRefresh = () => {
        fetchData(currentFolderId);
    };

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault();
        fetchData(currentFolderId);
    };

    const handleCreateFolder = async () => {
        const name = newFolderName.trim();
        if (!name || !currentProject) return;
        const parentId = currentFolderId || currentProject.projectId;
        setCreatingFolder(true);
        try {
            const res = await fetch('/api/create-subfolder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ parentFolderId: parentId, subfolderName: name }),
                credentials: 'include',
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Failed to create folder');
            setShowCreateFolder(false);
            setNewFolderName('');
            fetchData(currentFolderId);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create folder');
        } finally {
            setCreatingFolder(false);
        }
    };

    if (status !== 'authenticated') {
        return (
            <div className={`h-full flex flex-col items-center justify-center gap-4 p-6 text-center ${theme.textSecondary}`}>
                <LogIn className="w-12 h-12" />
                <div>
                    <h3 className={`text-lg font-medium ${theme.textPrimary} mb-2`}>Sign in required</h3>
                    <p className="mb-4">Please sign in to access your project files</p>
                    <button
                        onClick={() => signIn('google')}
                        className={`px-4 py-2 ${theme.accentBg} text-white rounded-lg ${theme.buttonHover}`}
                    >
                        Sign in with Google
                    </button>
                </div>
            </div>
        );
    }

    if (!hasProjectContext()) {
        return (
            <div className={`h-full flex flex-col items-center justify-center gap-4 p-6 text-center ${theme.textSecondary}`}>
                <Folder className="w-12 h-12" />
                <div>
                    <h3 className={`text-lg font-medium ${theme.textPrimary} mb-2`}>Select a Project</h3>
                    <p className="mb-4">Please select a project from the main application to access files</p>
                    <button
                        onClick={() => window.open('/projects', '_blank')}
                        className={`px-4 py-2 ${theme.accentBg} text-white rounded-lg ${theme.buttonHover}`}
                    >
                        Go to Projects
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className={`h-full flex flex-col ${theme.bg}`}>
            {}
            <div className={`p-4 border-b ${theme.borderColor}`}>
                {}
                {currentProject && (
                    <div className={`text-sm mb-2 flex items-center gap-2`}>
                        <span className={theme.textSecondary}>Project:</span>
                        <button
                            onClick={() => {
                                const idx = breadcrumbs.findIndex(b => b.id === currentProject.projectId);
                                if (idx >= 0) {
                                    navigateToBreadcrumb(idx);
                                } else {
                                    setBreadcrumbs([{ id: 'root', name: 'My Drive' }, { id: currentProject.projectId, name: currentProject.projectName }]);
                                    setCurrentFolderId(currentProject.projectId);
                                    fetchData(currentProject.projectId);
                                }
                            }}
                            className={`${theme.textPrimary} ${theme.buttonHover} font-medium underline-offset-2 hover:underline`}
                            title="Go to project folder"
                        >
                            {currentProject.projectName}
                        </button>
                    </div>
                )}

                {}
                <div className="flex items-center gap-1 mb-3 overflow-x-auto">
                    <button
                        onClick={() => navigateToBreadcrumb(0)}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-sm ${theme.buttonHover}`}
                        title="My Drive (Google Drive root)"
                    >
                        <Home className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => breadcrumbs.length > 1 && navigateToBreadcrumb(breadcrumbs.length - 2)}
                        disabled={breadcrumbs.length <= 1}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-sm ${breadcrumbs.length > 1 ? theme.buttonHover : 'opacity-40 cursor-not-allowed'}`}
                        title={breadcrumbs.length > 1 ? 'Go up to parent folder' : 'Already at root'}
                    >
                        <ChevronUp className="w-4 h-4" />
                    </button>
                    {currentProject && (
                        <button
                            onClick={() => {
                                const idx = breadcrumbs.findIndex(b => b.id === currentProject.projectId);
                                if (idx >= 0) {
                                    navigateToBreadcrumb(idx);
                                } else {
                                    setBreadcrumbs([{ id: 'root', name: 'My Drive' }, { id: currentProject.projectId, name: currentProject.projectName }]);
                                    setCurrentFolderId(currentProject.projectId);
                                    fetchData(currentProject.projectId);
                                }
                            }}
                            className={`flex items-center gap-1 px-2 py-1 rounded text-sm ${theme.buttonHover}`}
                            title={`Go to Alma project: ${currentProject.projectName}`}
                        >
                            <FolderOpen className="w-4 h-4" />
                        </button>
                    )}
                    {breadcrumbs.slice(1).map((crumb, index) => (
                        <div key={crumb.id} className="flex items-center gap-1">
                            <ChevronRight className={`w-4 h-4 ${theme.textSecondary}`} />
                            <button
                                onClick={() => navigateToBreadcrumb(index + 1)}
                                className={`px-2 py-1 rounded transition-colors whitespace-nowrap ${index === breadcrumbs.length - 2
                                    ? `${theme.textPrimary} font-medium`
                                    : `${theme.textSecondary} ${theme.buttonHover}`
                                    }`}
                            >
                                {crumb.name}
                            </button>
                        </div>
                    ))}
                </div>

                {}
                <div className="flex items-center gap-2">
                    <form onSubmit={handleSearch} className="flex-1">
                        <div className="relative">
                            <Search className={`absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 ${theme.textSecondary}`} />
                            <input
                                type="text"
                                placeholder="Search files..."
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                className={`w-full pl-10 pr-4 py-2 text-sm border rounded-lg ${theme.cardBg} ${theme.borderColor} ${theme.textPrimary} focus:outline-none focus:ring-2 focus:ring-opacity-50`}
                            />
                        </div>
                    </form>
                    <button
                        onClick={handleRefresh}
                        disabled={loading}
                        className={`p-2 rounded-lg ${theme.buttonHover} ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                        title="Refresh"
                    >
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                        onClick={() => setShowCreateFolder(true)}
                        className={`p-2 rounded-lg ${theme.buttonHover}`}
                        title="Create new folder"
                    >
                        <FolderPlus className={`w-4 h-4 ${theme.accentText}`} />
                    </button>
                </div>
                {showCreateFolder && (
                    <div className={`mt-3 flex gap-2 items-center ${theme.bg} p-2 rounded-lg border ${theme.borderColor}`}>
                        <input
                            type="text"
                            placeholder="New folder name"
                            value={newFolderName}
                            onChange={(e) => setNewFolderName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') { setShowCreateFolder(false); setNewFolderName(''); } }}
                            className={`flex-1 px-3 py-2 text-sm border rounded ${theme.cardBg} ${theme.borderColor} ${theme.textPrimary}`}
                            autoFocus
                        />
                        <button
                            onClick={handleCreateFolder}
                            disabled={!newFolderName.trim() || creatingFolder}
                            className={`px-3 py-1.5 text-sm ${theme.accentBg} text-white rounded ${theme.accentHover} disabled:opacity-50`}
                        >
                            {creatingFolder ? 'Creating…' : 'Create'}
                        </button>
                        <button
                            onClick={() => { setShowCreateFolder(false); setNewFolderName(''); }}
                            className={`px-3 py-1.5 text-sm ${theme.buttonBg} ${theme.textSecondary} rounded ${theme.buttonHover}`}
                        >
                            Cancel
                        </button>
                    </div>
                )}
            </div>

            {}
            {selectionMode && onFolderSelect && currentProject && (
                <div className={`p-3 border-b ${theme.borderColor} ${theme.cardBg}`}>
                    <button
                        onClick={() => onFolderSelect(currentFolderId || currentProject.projectId)}
                        className={`w-full py-2 ${theme.accentBg} text-white text-sm font-medium rounded-lg ${theme.accentHover}`}
                    >
                        Save to this folder
                    </button>
                </div>
            )}

            {}
            <div className="flex-1 min-h-0 overflow-y-auto">
                {loading && (
                    <div className="flex items-center justify-center h-32">
                        <Loader2 className={`w-6 h-6 animate-spin ${theme.textSecondary}`} />
                    </div>
                )}

                {error && (
                    <div className={`m-4 p-3 rounded-lg bg-red-50 text-red-700 border border-red-200 flex items-center gap-2`}>
                        <AlertCircle className="w-5 h-5 flex-shrink-0" />
                        <span>{error}</span>
                    </div>
                )}

                {!loading && !error && (
                    <div className="p-2">
                        {}
                        {showFolders && folders.map((folder) => (
                            <div
                                key={folder.id}
                                onClick={() => navigateToFolder(folder.id, folder.name)}
                                className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors ${theme.buttonHover}`}
                            >
                                <FolderOpen className={`w-5 h-5 ${theme.accentText}`} />
                                <div className="flex-1">
                                    <div className={`font-medium ${theme.textPrimary}`}>{folder.name}</div>
                                    <div className={`text-xs ${theme.textSecondary}`}>
                                        Folder • {folder.modifiedTime ? new Date(folder.modifiedTime).toLocaleDateString() : ''}
                                    </div>
                                </div>
                            </div>
                        ))}

                        {}
                        {showFiles && files.map((file) => (
                            <div
                                key={file.id}
                                onClick={() => onFileSelect?.(file)}
                                className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors ${theme.buttonHover}`}
                            >
                                <FileText className={`w-5 h-5 ${theme.textSecondary}`} />
                                <div className="flex-1">
                                    <div className={`font-medium ${theme.textPrimary}`}>{file.name}</div>
                                    <div className={`text-xs ${theme.textSecondary}`}>
                                        {file.size && `${Math.round(parseInt(file.size) / 1024)} KB`} •
                                        {file.modifiedTime ? new Date(file.modifiedTime).toLocaleDateString() : ''}
                                    </div>
                                </div>
                            </div>
                        ))}

                        {}
                        {!loading && !error && folders.length === 0 && files.length === 0 && (
                            <div className={`text-center py-8 ${theme.textSecondary}`}>
                                <Folder className="w-12 h-12 mx-auto mb-3 opacity-50" />
                                <p>No files or folders found</p>
                                {search && (
                                    <p className="text-sm mt-2">
                                        Try adjusting your search terms
                                    </p>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
} 