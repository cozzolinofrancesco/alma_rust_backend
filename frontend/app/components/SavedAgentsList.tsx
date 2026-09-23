
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAgentFiles, fetchFileContent } from '../lib/api';
import {
    AgentFile,
    AgentJsonWithMetadata,
    ParsedAgentJson,
    SavedAgentsListProps,
    Layers
} from '../lib/types';
import { getAgentLastOpenedIndexForProject } from '../lib/recentItemsManager';
import '../styles/createAgents.css';
import JsonViewer from './JsonViewer';

const parseJsonSafely = (jsonString: string): ParsedAgentJson | null => {
    try {
        const parsed: unknown = JSON.parse(jsonString);

        if (parsed && typeof parsed === 'object' && 'layers' in parsed) {
            if (Array.isArray((parsed as ParsedAgentJson).layers)) {
                 return parsed as ParsedAgentJson;
            } else {
                 console.error("Parsed JSON 'layers' property is not an array:", parsed);
                 return null;
            }
        }
        console.error("Parsed JSON does not contain 'layers' property or is not a valid object:", parsed);
        return null;
    } catch (error) {
        console.error("Failed to parse JSON:", error);
        return null;
    }
};

const SavedAgentsList: React.FC<SavedAgentsListProps> = ({
    projectFolder,
    token,
    session,
    drawerOpen,
    setDrawerOpen,
    onAgentLoad,
}) => {
    useEffect(() => {
        if (drawerOpen) {
            document.body.style.overflow = 'hidden';
            return () => {
                document.body.style.overflow = 'unset';
            };
        }
    }, [drawerOpen]);

    const [agentFiles, setAgentFiles] = useState<AgentFile[]>([]);
    const [reloadAgentListTrigger, setReloadAgentListTrigger] = useState<number>(0);
    const [expandedFile, setExpandedFile] = useState<string | null>(null);
    const [fileContents, setFileContents] = useState<{ [fileId: string]: string }>({});
    const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
    const [modalFile, setModalFile] = useState<AgentFile | null>(null);
    const [modalContent, setModalContent] = useState<string | null>(null);
    const [modalParsedContent, setModalParsedContent] = useState<AgentJsonWithMetadata | null>(null);
    const [isLoadingList, setIsLoadingList] = useState<boolean>(false);
    const [listError, setListError] = useState<string | null>(null);
    const [isLoadingContent, setIsLoadingContent] = useState<string | null>(null);
    const [localLoadError, setLocalLoadError] = useState<string | null>(null);

    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!projectFolder || !token) {
            setAgentFiles([]);
            return;
        }

        setIsLoadingList(true);
        setListError(null);

        fetchAgentFiles(projectFolder || '')
            .then((files: AgentFile[]) => {
                const lastOpenedIndex = projectFolder ? getAgentLastOpenedIndexForProject(projectFolder) : {};

                const sortedFiles = files.sort((a, b) => {
                    const aLastOpened = lastOpenedIndex[a.id] ?? 0;
                    const bLastOpened = lastOpenedIndex[b.id] ?? 0;
                    const aUpdated = new Date(a.updatedAt || 0).getTime();
                    const bUpdated = new Date(b.updatedAt || 0).getTime();
                    const aCreated = new Date(a.createdAt || 0).getTime();
                    const bCreated = new Date(b.createdAt || 0).getTime();

                    const aActivity = Math.max(aLastOpened, aUpdated || 0, aCreated || 0);
                    const bActivity = Math.max(bLastOpened, bUpdated || 0, bCreated || 0);

                    if (bActivity !== aActivity) return bActivity - aActivity;
                    if (bLastOpened !== aLastOpened) return bLastOpened - aLastOpened;
                    if ((bUpdated || 0) !== (aUpdated || 0)) return (bUpdated || 0) - (aUpdated || 0);
                    return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
                });
                setAgentFiles(sortedFiles);
                setListError(null);
            })
            .catch((err: Error) => {
                console.error("Failed to fetch agent files:", err);
                setListError("Failed to load agents. Please try again.");
                setAgentFiles([]);
                setExpandedFile(null);
                setFileContents({});
            })
            .finally(() => {
                setIsLoadingList(false);
            });

    }, [projectFolder, token, reloadAgentListTrigger]);

    const handleReloadAgentList = useCallback(() => {
        setReloadAgentListTrigger(prev => prev + 1);
        setExpandedFile(null);
        setFileContents({});
        setLocalLoadError(null);
    }, []);

    const fetchAndCacheContent = useCallback(async (fileId: string): Promise<string | null> => {
        if (fileContents[fileId]) {
            return fileContents[fileId];
        }

        if (!token) {
             console.error("Cannot fetch file content: Authentication token is missing.");
             return null;
        }

        if (isLoadingContent === fileId) {
             console.warn(`Fetch already in progress for file ${fileId}.`);
             return null;
        }


        setIsLoadingContent(fileId);
        try {
            const content = await fetchFileContent(fileId);
            setFileContents(prev => ({ ...prev, [fileId]: content }));
            return content;
        } catch (error) {
            console.error(`Failed to fetch content for file ${fileId}:`, error);
            return null;
        } finally {
            if (isLoadingContent === fileId) {
                setIsLoadingContent(null);
            }
        }
    }, [fileContents, token, isLoadingContent]);

    const togglePreview = useCallback(async (fileId: string) => {
        if (expandedFile === fileId) {
            setExpandedFile(null);
        } else {
            setExpandedFile(fileId);
            if (!fileContents[fileId] && isLoadingContent !== fileId) {
                 await fetchAndCacheContent(fileId);
            }
        }
    }, [expandedFile, fileContents, fetchAndCacheContent, isLoadingContent]);

    const handleViewJson = useCallback(async (file: AgentFile) => {
        const content = await fetchAndCacheContent(file.id);

        setModalFile(file);
        setModalContent(content);
        setModalParsedContent(null);

        if (content) {
            const parsed = parseJsonSafely(content);
            if (parsed) {
                const parsedWithMetadata: AgentJsonWithMetadata = { ...parsed };
                parsedWithMetadata.metadata = {
                    createdBy: session?.user?.name || 'Unknown',
                    createdAt: file.createdAt,
                    updatedBy: session?.user?.name || 'Unknown',
                    updatedAt: file.updatedAt,
                 };
                setModalParsedContent(parsedWithMetadata);
            }
        }
        setIsModalOpen(true);
    }, [fetchAndCacheContent, session]);

    const closeModal = useCallback(() => {
        setIsModalOpen(false);
        setModalFile(null);
        setModalContent(null);
        setModalParsedContent(null);
    }, []);

    const handleLoadAgent = useCallback(async (file: AgentFile) => {
        const content = await fetchAndCacheContent(file.id);

        if (content) {
            try {
                const parsed = JSON.parse(content);
                
                const { isVersionedAgent, getCurrentVersionLayers } = await import('../lib/versionUtils');
                
                let layers: unknown[];
                let agentName: string;
                
                if (isVersionedAgent(parsed)) {
                    layers = getCurrentVersionLayers(parsed);
                    agentName = parsed.agentName;
                    console.log(`Loading versioned agent: ${agentName}, current version: ${parsed.currentVersion}`);
                } else {
                    if (parsed && Array.isArray(parsed.layers)) {
                        layers = parsed.layers;
                        agentName = parsed.name || file.name;
                    } else {
                        throw new Error('Invalid agent format: missing layers array');
                    }
                }
                
                if (layers && Array.isArray(layers)) {
                    onAgentLoad({ layers: layers as Layers, name: agentName, fileId: file.id });
                    setDrawerOpen(false);
                    setLocalLoadError(null);
                } else {
                    throw new Error('No valid layers found in agent data');
                }
                
            } catch (error) {
                console.error(`Failed to load agent ${file.name}:`, error);
                setLocalLoadError(`Failed to load agent "${file.name}": ${error instanceof Error ? error.message : 'Invalid format'}`);
            }
        } else {
             console.error(`Failed to load agent ${file.name}: Could not fetch file content.`);
             setLocalLoadError(`Failed to load agent "${file.name}": Could not fetch file content.`);
        }
    }, [fetchAndCacheContent, onAgentLoad, setDrawerOpen]);

    const handleDownloadAgent = useCallback(async (file: AgentFile) => {
        const content = await fetchAndCacheContent(file.id);

        if (content) {
            try {
                const blob = new Blob([content], { type: 'application/json' });
                const url = URL.createObjectURL(blob);

                const a = document.createElement('a');
                a.href = url;
                const filename = file.name.endsWith('.json') ? file.name : `${file.name}.json`;
                a.download = filename;

                document.body.appendChild(a);
                a.click();

                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                console.log(`Successfully initiated download for ${filename}`);

            } catch (error) {
                console.error(`Failed to create or trigger download for file ${file.name}:`, error);
                setLocalLoadError(`Failed to download agent "${file.name}".`);
            }
        } else {
             console.error(`Failed to download agent ${file.name}: Could not fetch file content.`);
             setLocalLoadError(`Failed to download agent "${file.name}": Could not fetch file content.`);
        }
    }, [fetchAndCacheContent]);

    const handleLoadFromFileClick = useCallback(() => {
        setLocalLoadError(null);
        fileInputRef.current?.click();
    }, []);

    const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];

        if (!file) {
            return;
        }

        const reader = new FileReader();

        reader.onload = (e) => {
            const content = e.target?.result;
            if (typeof content === 'string') {
                const parsed = parseJsonSafely(content);

                if (parsed && Array.isArray(parsed.layers)) {
                    const temporaryFileId = `local-${Date.now()}`;
                    const agentName = parsed.name || file.name.replace(/\.json$/i, '');

                    onAgentLoad({ layers: parsed.layers, name: agentName, fileId: temporaryFileId });
                    setDrawerOpen(false);
                    setLocalLoadError(null);
                } else {
                    console.error(`Failed to load file "${file.name}": Invalid JSON format or missing/invalid 'layers' property.`);
                    setLocalLoadError(`Failed to load file "${file.name}": Invalid JSON format or missing 'layers'.`);
                }
            } else {
                 console.error(`Failed to read file "${file.name}" as text.`);
                 setLocalLoadError(`Failed to read file "${file.name}".`);
            }
            event.target.value = '';
        };

        reader.onerror = (e) => {
            console.error(`Error reading file "${file.name}":`, e);
            setLocalLoadError(`Error reading file "${file.name}".`);
            event.target.value = '';
        };

        reader.readAsText(file);

    }, [onAgentLoad, setDrawerOpen]);

    return (
        <>
            {}
            <div className={`agent-drawer ${drawerOpen ? 'open' : ''}`}>
                <div className="drawer-header">
                    <h3>Saved Agents</h3>
                    <div className="drawer-header-actions">
                        {}
                        <button
                            className="load-from-file-button"
                            onClick={handleLoadFromFileClick}
                            title="Load agent from local JSON file"
                        >
                            Upload
                        </button>
                        <button
                            className="reload-list-button"
                            onClick={handleReloadAgentList}
                            disabled={isLoadingList}
                            title="Refresh agent list"
                        >
                            {isLoadingList ? '...' : '↻'}
                        </button>
                        <button
                            className="close-drawer-button"
                            onClick={() => setDrawerOpen(false)}
                            title="Close drawer"
                        >
                            &times;
                        </button>
                    </div>
                </div>
                <div className="drawer-content">
                    {}
                    {isLoadingList && <p>Loading agents...</p>}
                    {listError && <p className="error-message">{listError}</p>}
                    {!isLoadingList && agentFiles.length === 0 && !listError && (
                        <p>No agents saved yet.</p>
                    )}

                    {}
                    {localLoadError && <p className="error-message">{localLoadError}</p>}

                    {}
                    {!isLoadingList && !listError && agentFiles.map(file => {
                        const actionsDisabled = isLoadingContent === file.id;
                        return (
                            <div key={file.id} className="agent-item">
                                <div className="agent-name-row">
                                    <span className="agent-name">{file.name}</span>
                                    <div className="agent-actions">
                                        <button onClick={() => togglePreview(file.id)} disabled={actionsDisabled}>
                                            {expandedFile === file.id ? 'Hide Preview' : (actionsDisabled ? '...' : 'Preview')}
                                        </button>
                                        <button onClick={() => handleViewJson(file)} disabled={actionsDisabled}>
                                             {actionsDisabled ? '...' : 'View JSON'}
                                        </button>
                                        <button className="download-button" onClick={() => handleDownloadAgent(file)} disabled={actionsDisabled}>
                                             {actionsDisabled ? '...' : 'Download'}
                                        </button>
                                        <button className="load-button" onClick={() => handleLoadAgent(file)} disabled={actionsDisabled}>
                                             {actionsDisabled ? '...' : 'Load'}
                                        </button>
                                    </div>
                                </div>
                                {expandedFile === file.id && (
                                    <div className="agent-preview">
                                        {isLoadingContent === file.id ? (
                                            <p>Loading preview...</p>
                                        ) : fileContents[file.id] ? (
                                            <pre className="preview-content">{fileContents[file.id].substring(0, 500)}{fileContents[file.id].length > 500 ? '...' : ''}</pre>
                                        ) : (
                                            <p className="error-message">Could not load preview content.</p>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
                {}
            </div>

            {}
            <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileSelect}
                style={{ display: 'none' }}
                accept=".json"
            />

            {}
            {isModalOpen && (
                <div className="modal-overlay" onClick={closeModal}>
                    <div className="modal-content" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2>{modalFile?.name || 'JSON Viewer'}</h2>
                            <button className="close-button" onClick={closeModal}>&times;</button>
                        </div>
                        <div className="modal-body">
                            {modalParsedContent ? (
                                <div className="json-viewer-container">
                                    <JsonViewer parsedContent={modalParsedContent} />
                                </div>
                            ) : modalContent !== null ? (
                                <>
                                    <p className="error-message">Could not parse JSON or missing/invalid 'layers' property.</p>
                                    <pre className="raw-json-content">{modalContent}</pre>
                                </>
                            ) : (
                                <p className="error-message">No content to display or failed to fetch content.</p>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};

export default SavedAgentsList;
