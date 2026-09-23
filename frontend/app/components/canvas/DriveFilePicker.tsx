'use client';

import {
    AlertCircle,
    Check,
    ChevronRight,
    FileText,
    Folder,
    FolderOpen,
    Home,
    Loader2,
    Search,
    X
} from 'lucide-react';
import { useSession } from 'next-auth/react';
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

interface DriveFilePickerProps {
    isOpen: boolean;
    onClose: () => void;
    onFilesSelected: (files: DriveFile[]) => void;
    multiple?: boolean;
    fileTypes?: string[];
}

export default function DriveFilePicker({
    isOpen,
    onClose,
    onFilesSelected,
    multiple = true,
    fileTypes = []
}: DriveFilePickerProps) {
    const { theme } = useTheme();
    const { data: session, status } = useSession();
    const { initializeProjectContext, hasProjectContext, currentProject } = useProjectContext();

    const [currentFolderId, setCurrentFolderId] = useState<string>('');
    const [folders, setFolders] = useState<DriveFile[]>([]);
    const [files, setFiles] = useState<DriveFile[]>([]);
    const [selectedFiles, setSelectedFiles] = useState<DriveFile[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [breadcrumbs, setBreadcrumbs] = useState<Array<{ id: string; name: string }>>([
        { id: '', name: 'Project Root' }
    ]);

    useEffect(() => {
        if (isOpen && session?.accessToken) {
            console.log('🔄 DriveFilePicker: Dialog opened, checking project context');
            const context = initializeProjectContext();
            if (context) {
                console.log('✅ DriveFilePicker: Project context loaded, fetching data');
                loadData();
            } else {
                setError('No project selected. Please select a project from the main application first.');
            }
        }
    }, [isOpen, session]);

    const loadData = async (folderId = currentFolderId) => {
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

            if (!folderId) {
                console.log('📁 DriveFilePicker: Loading project root contents...');
                const allContents = await fileService.getProjectContents();

                allFolders = allContents.filter(file =>
                    file.type === 'Folder'
                );

                allFiles = allContents.filter(file =>
                    file.type === 'File'
                );

                if (fileTypes.length > 0) {
                    allFiles = allFiles.filter(file =>
                        file.mimeType && fileTypes.some(type => file.mimeType!.includes(type))
                    );
                }

                console.log(`📁 DriveFilePicker: Project root loaded: ${allFolders.length} folders, ${allFiles.length} files`);
            } else {
                const contents = await fileService.getFolderContentsById(folderId);

                allFolders = contents.filter(file =>
                    file.type === 'Folder'
                );

                allFiles = contents.filter(file =>
                    file.type === 'File'
                );

                if (fileTypes.length > 0) {
                    allFiles = allFiles.filter(file =>
                        file.mimeType && fileTypes.some(type => file.mimeType!.includes(type))
                    );
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

        if (folderId === '') {
            setBreadcrumbs([{ id: '', name: 'Project Root' }]);
        } else {
            setBreadcrumbs(prev => [...prev, { id: folderId, name: folderName }]);
        }

        setSelectedFiles([]);

        loadData(folderId);
    };

    const navigateToBreadcrumb = (index: number) => {
        const newBreadcrumbs = breadcrumbs.slice(0, index + 1);
        setBreadcrumbs(newBreadcrumbs);

        const targetFolderId = newBreadcrumbs[newBreadcrumbs.length - 1].id;
        setCurrentFolderId(targetFolderId);
        setSelectedFiles([]);
        loadData(targetFolderId);
    };

    const toggleFileSelection = (file: DriveFile) => {
        setSelectedFiles(prev => {
            const isSelected = prev.some(f => f.id === file.id);

            if (isSelected) {
                return prev.filter(f => f.id !== file.id);
            } else {
                return multiple ? [...prev, file] : [file];
            }
        });
    };

    const handleConfirmSelection = () => {
        onFilesSelected(selectedFiles);
        onClose();
    };

    const handleClose = () => {
        setSelectedFiles([]);
        setSearch('');
        setError(null);
        onClose();
    };

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault();
        loadData(currentFolderId);
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className={`bg-white ${theme.cardBg} rounded-lg shadow-xl max-w-4xl w-full max-h-[80vh] flex flex-col mx-4`}>
                {}
                <div className={`p-6 border-b ${theme.borderColor} flex items-center justify-between`}>
                    <div>
                        <h2 className={`text-xl font-semibold ${theme.textPrimary}`}>
                            Select Files from Project
                        </h2>
                        {currentProject && (
                            <p className={`text-sm ${theme.textSecondary} mt-1`}>
                                Project: {currentProject.projectName}
                            </p>
                        )}
                    </div>
                    <button
                        onClick={handleClose}
                        className={`p-2 rounded-lg ${theme.buttonHover}`}
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {}
                {error && (
                    <div className={`m-4 p-3 rounded-lg bg-red-50 text-red-700 border border-red-200 flex items-center gap-2`}>
                        <AlertCircle className="w-5 h-5 flex-shrink-0" />
                        <span>{error}</span>
                    </div>
                )}

                {}
                <div className={`p-4 border-b ${theme.borderColor} space-y-4`}>
                    {}
                    <div className="flex items-center gap-1 overflow-x-auto">
                        <button
                            onClick={() => navigateToBreadcrumb(0)}
                            className={`flex items-center gap-1 px-2 py-1 rounded text-sm ${theme.buttonHover}`}
                        >
                            <Home className="w-4 h-4" />
                        </button>
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
                    <form onSubmit={handleSearch} className="flex gap-2">
                        <div className="flex-1 relative">
                            <Search className={`absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 ${theme.textSecondary}`} />
                            <input
                                type="text"
                                placeholder="Search files..."
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                className={`w-full pl-10 pr-4 py-2 text-sm border rounded-lg ${theme.cardBg} ${theme.borderColor} ${theme.textPrimary} focus:outline-none focus:ring-2 focus:ring-opacity-50`}
                            />
                        </div>
                        <button
                            type="submit"
                            disabled={loading}
                            className={`px-4 py-2 text-sm ${theme.accentBg} text-white rounded-lg ${theme.buttonHover} ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                            Search
                        </button>
                    </form>
                </div>

                {}
                <div className="flex-1 overflow-y-auto p-4">
                    {loading && (
                        <div className="flex items-center justify-center h-32">
                            <Loader2 className={`w-6 h-6 animate-spin ${theme.textSecondary}`} />
                        </div>
                    )}

                    {!loading && !error && (
                        <div className="space-y-2">
                            {}
                            {folders.map((folder) => (
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
                                    <ChevronRight className={`w-4 h-4 ${theme.textSecondary}`} />
                                </div>
                            ))}

                            {}
                            {files.map((file) => {
                                const isSelected = selectedFiles.some(f => f.id === file.id);

                                return (
                                    <div
                                        key={file.id}
                                        onClick={() => toggleFileSelection(file)}
                                        className={`flex items-center gap-2 sm:gap-3 p-2 sm:p-3 rounded-lg cursor-pointer transition-colors ${isSelected
                                            ? `${theme.accentBg} text-white`
                                            : `${theme.cardBg} ${theme.buttonHover}`
                                            }`}
                                    >
                                        <div className="flex items-center gap-2 sm:gap-3 flex-1 min-w-0">
                                            <div className="flex-shrink-0 w-5 h-5 sm:w-6 sm:h-6 flex items-center justify-center">
                                                {isSelected ? (
                                                    <Check className="w-4 h-4 sm:w-5 sm:h-5" />
                                                ) : (
                                                    <FileText className="w-4 h-4 sm:w-5 sm:h-5" />
                                                )}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className={`font-medium truncate text-sm ${isSelected ? 'text-white' : theme.textPrimary
                                                    }`}>
                                                    {file.name}
                                                </div>
                                                <div className={`text-xs flex items-center gap-2 ${isSelected ? 'text-white/70' : theme.textSecondary
                                                    }`}>
                                                    <span>{formatFileSize(file.size)}</span>
                                                    {file.modifiedTime && (
                                                        <>
                                                            <span>•</span>
                                                            <span>{new Date(file.modifiedTime).toLocaleDateString()}</span>
                                                        </>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}

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

                {}
                <div className={`p-4 border-t ${theme.borderColor} flex items-center justify-between`}>
                    <div className={`text-sm ${theme.textSecondary}`}>
                        {selectedFiles.length > 0 && (
                            <span>
                                {selectedFiles.length} file{selectedFiles.length !== 1 ? 's' : ''} selected
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-3">
                        <button
                            onClick={handleClose}
                            className={`px-4 py-2 text-sm rounded-lg ${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover}`}
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleConfirmSelection}
                            disabled={selectedFiles.length === 0}
                            className={`px-4 py-2 text-sm ${theme.accentBg} text-white rounded-lg ${theme.buttonHover} ${selectedFiles.length === 0 ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                            Select {selectedFiles.length > 0 ? `(${selectedFiles.length})` : ''}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

function formatFileSize(bytes: string | undefined): string {
    if (!bytes) return '';
    const size = parseInt(bytes);
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
} 