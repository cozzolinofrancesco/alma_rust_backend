'use client';

import { HardDrive } from 'lucide-react';
import { useState } from 'react';
import { useDocument } from '../../contexts/DocumentContext';
import { useEditor } from '../../contexts/EditorContext';
import { useTheme } from '../../contexts/ThemeContext';
import { useProjectState } from '../ProjectStateContext';
import styles from '../../styles/canvas/ChatPanel.module.css';
import DriveFilePicker from './DriveFilePicker';
import FilePreview from './FilePreview';
import FileTypeIcons from './FileTypeIcons';
import { DEFAULT_MODEL } from '../../lib/modelConfig';

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
interface FileData {
    id: string;
    name: string;
    type: string;
    size: number;
    content: string | ArrayBuffer;
    preview?: string;
    uploadDate: Date;
    originalFile: File;
}

interface InputBox {
    id: number;
    value: string;
    files: FileData[];
}

const SUPPORTED_FILE_TYPES = {
    'image/jpeg': '.jpg,.jpeg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'text/csv': '.csv',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/ogg': '.ogg',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/x-msvideo': '.avi',
    'text/javascript': '.js',
    'text/typescript': '.ts',
    'application/json': '.json',
    'text/html': '.html',
    'text/css': '.css'
};

  const MAX_FILE_SIZE = 30 * 1024 * 1024;

export default function ChatPanel() {
    const [inputBoxes, setInputBoxes] = useState<InputBox[]>([{ id: 1, value: '', files: [] }]);
    const [isGenerating, setIsGenerating] = useState(false);
    const [draggedItem, setDraggedItem] = useState<number | null>(null);
    const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
    const [expandedPrompt, setExpandedPrompt] = useState<{ id: number; value: string; files: FileData[] } | null>(null);
    const [showDrivePicker, setShowDrivePicker] = useState(false);
    const [drivePickerBoxId, setDrivePickerBoxId] = useState<number | null>(null);
    const { theme } = useTheme();
    const { projectFolder } = useProjectState();
    const { insertText, saveToHistory, getContent } = useEditor();
    const { activeSection, template, updateSectionContent } = useDocument();

    const processFile = (file: File): Promise<FileData> => {
        return new Promise((resolve, reject) => {
            if (file.size > MAX_FILE_SIZE) {
                reject(new Error(`File ${file.name} is too large. Maximum size is 10MB.`));
                return;
            }

            if (!Object.keys(SUPPORTED_FILE_TYPES).includes(file.type)) {
                reject(new Error(`File type ${file.type} is not supported.`));
                return;
            }

            const reader = new FileReader();
            reader.onload = (e) => {
                const fileData: FileData = {
                    id: Math.random().toString(36).substr(2, 9),
                    name: file.name,
                    type: file.type,
                    size: file.size,
                    content: e.target?.result || '',
                    uploadDate: new Date(),
                    originalFile: file
                };

                if (file.type.startsWith('image/')) {
                    fileData.preview = e.target?.result as string;
                }

                resolve(fileData);
            };
            reader.onerror = () => reject(new Error(`Failed to read file ${file.name}`));

            if (file.type.startsWith('image/') || file.type === 'application/pdf') {
                reader.readAsDataURL(file);
            } else {
                reader.readAsText(file);
            }
        });
    };

    const addFilesToBox = async (boxId: number, files: FileList) => {
        try {
            const filePromises = Array.from(files).map(file => processFile(file));
            const processedFiles = await Promise.all(filePromises);

            setInputBoxes(prev =>
                prev.map(box =>
                    box.id === boxId
                        ? { ...box, files: [...box.files, ...processedFiles] }
                        : box
                )
            );
        } catch (error) {
            console.error('Error processing files:', error);
        }
    };

    const removeFileFromBox = (boxId: number, fileId: string) => {
        setInputBoxes(prev =>
            prev.map(box =>
                box.id === boxId
                    ? { ...box, files: box.files.filter(f => f.id !== fileId) }
                    : box
            )
        );
    };

    const handleDriveFileSelection = async (driveFiles: DriveFile[]) => {
        if (!drivePickerBoxId) return;

        try {
            const fileDataPromises = driveFiles.map(async (driveFile) => {
                try {
                    console.log(`Processing Drive file: ${driveFile.name}`);

                    const fileData: FileData = {
                        id: driveFile.id,
                        name: driveFile.name,
                        type: driveFile.mimeType,
                        size: parseInt(driveFile.size || '0'),
                        content: `[Project File: ${driveFile.name}]`,
                        uploadDate: new Date(),
                        originalFile: new File([''], driveFile.name, { type: driveFile.mimeType })
                    };

                    if (driveFile.mimeType.startsWith('image/') && driveFile.thumbnailLink) {
                        fileData.preview = driveFile.thumbnailLink;
                    }

                    console.log(`Successfully processed file: ${driveFile.name}`, fileData);
                    return fileData;
                } catch (error) {
                    console.error(`Error processing Drive file ${driveFile.name}:`, error);
                    return {
                        id: driveFile.id,
                        name: driveFile.name,
                        type: driveFile.mimeType,
                        size: parseInt(driveFile.size || '0'),
                        content: `[File: ${driveFile.name} - Error loading content]`,
                        uploadDate: new Date(),
                        originalFile: new File([''], driveFile.name, { type: driveFile.mimeType })
                    };
                }
            });

            const processedFiles = await Promise.all(fileDataPromises);

            setInputBoxes(prev =>
                prev.map(box =>
                    box.id === drivePickerBoxId
                        ? { ...box, files: [...box.files, ...processedFiles] }
                        : box
                )
            );

        } catch (error) {
            console.error('Error processing Google Drive files:', error);
        }

        setShowDrivePicker(false);
        setDrivePickerBoxId(null);
    };

    const openDrivePicker = (boxId: number) => {
        setDrivePickerBoxId(boxId);
        setShowDrivePicker(true);
    };

    const handlePaste = async (e: React.ClipboardEvent, boxId: number) => {
        const items = e.clipboardData.items;
        const files: File[] = [];

        for (let i = 0; i < items.length; i++) {
            if (items[i].kind === 'file') {
                const file = items[i].getAsFile();
                if (file) files.push(file);
            }
        }

        if (files.length > 0) {
            e.preventDefault();
            for (const file of files) {
                const singleFileList = {
                    length: 1,
                    item: (index: number) => index === 0 ? file : null,
                    [Symbol.iterator]: function* () { yield file; },
                    0: file
                } as unknown as FileList;
                await addFilesToBox(boxId, singleFileList);
            }
        }
    };

    const handleInputChange = (id: number, value: string) => {
        setInputBoxes(prev =>
            prev.map(box =>
                box.id === id ? { ...box, value } : box
            )
        );
    };

    const removeBox = (id: number) => {
        if (inputBoxes.length <= 1) return;

        setInputBoxes(prev => prev.filter(box => box.id !== id));
    };

    const addNewBox = () => {
        if (inputBoxes.length < 5) {
            const newId = Math.max(...inputBoxes.map(b => b.id)) + 1;
            setInputBoxes(prev => [...prev, { id: newId, value: '', files: [] }]);
        }
    };

    const handleGenerate = async () => {
        const hasContent = inputBoxes.some(box => box.value.trim() || box.files.length > 0);
        if (!hasContent) return;

        setIsGenerating(true);

        try {
            const currentContent = getContent();
            saveToHistory(currentContent);

            let previousResponse = '';
            let finalResponse = '';

            for (let i = 0; i < inputBoxes.length; i++) {
                const box = inputBoxes[i];

                if (!box.value.trim() && box.files.length === 0) {
                    continue;
                }

                let filesContent = '';
                const filesArray: Array<{ name: string, type: string, content: string }> = [];

                if (box.files.length > 0) {
                    const fileTexts = await Promise.all(
                        box.files.map(async (file) => {
                            if (file.type.startsWith('image/')) {
                                return `[Image: ${file.name}]`;
                            } else if (file.type === 'application/pdf') {
                                filesArray.push({
                                    name: file.name,
                                    type: file.type,
                                    content: file.content as string
                                });
                                return `[PDF Document: ${file.name} - processing directly]`;
                            } else if (typeof file.content === 'string') {
                                return `[File: ${file.name}]\n${file.content}`;
                            } else {
                                return `[File: ${file.name}] (binary content)`;
                            }
                        })
                    );
                    filesContent = fileTexts.join('\n\n');
                }

                let currentPrompt = box.value.trim();

                if (activeSection && template) {
                    const sectionContext = `\n\nContext: You are helping write the "${activeSection}" section of a document. Please focus your response specifically on content that would be appropriate for this section.`;
                    currentPrompt += sectionContext;
                }

                if (filesContent) {
                    currentPrompt += '\n\nAttached files:\n' + filesContent;
                }

                if (i > 0 && previousResponse) {
                    const maxPreviousLength = 1000;
                    const truncatedPrevious = previousResponse.length > maxPreviousLength
                        ? previousResponse.substring(0, maxPreviousLength) + '...'
                        : previousResponse;

                    currentPrompt += '\n\nPrevious response for context:\n' + truncatedPrevious;
                }

                let response;
                if (box.files.length > 0) {
                    const formData = new FormData();

                    const messages = [{
                        role: 'user' as const,
                        text: currentPrompt
                    }];
                    formData.append('messages', JSON.stringify(messages));
                    formData.append('model', DEFAULT_MODEL);

                    box.files.forEach((fileData, index) => {
                        formData.append(`file_${index}`, fileData.originalFile);
                    });
                    
                    if (projectFolder?.projectId) {
                        formData.append('projectId', projectFolder.projectId);
                        console.log('📁 [ChatPanel] Adding current project ID to request:', projectFolder.projectId);
                    } else {
                        console.warn('⚠️ [ChatPanel] No current project ID available for RAG processing');
                    }

                    console.log('🚀 [ChatPanel] Sending multipart request with', box.files.length, 'files');

                    response = await fetch('/api/gemini', {
                        method: 'POST',
                        body: formData,
                    });
                } else {
                    response = await fetch('/api/gemini', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            messages: [{ role: 'user', text: currentPrompt }],
                            model: DEFAULT_MODEL
                        }),
                    });
                }

                const data = await response.json();

                if (!response.ok) {
                    throw new Error(data.error || 'Failed to generate content');
                }

                previousResponse = data.response;

                if (i === inputBoxes.length - 1) {
                    finalResponse = data.response;
                }
            }

            if (finalResponse) {
                if (activeSection && template) {
                    const currentSectionContent = getContent();
                    const newSectionContent = currentSectionContent + `\n\n${finalResponse}\n\n`;
                    updateSectionContent(activeSection, newSectionContent);

                    const formattedResponse = `\n\n${finalResponse}\n\n`;
                    insertText(formattedResponse);
                } else {
                    const formattedResponse = `\n\n${finalResponse}\n\n`;
                    insertText(formattedResponse);
                }
            }

        } catch (error) {
            console.error('Error generating content:', error);

            const errorText = `\n\n[Error: ${error instanceof Error ? error.message : 'Failed to generate content'}]\n\n`;
            insertText(errorText);
        } finally {
            setIsGenerating(false);
        }
    };

    const handleDragStart = (e: React.DragEvent, boxId: number) => {
        setDraggedItem(boxId);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/html', '');
    };

    const handleDragOver = (e: React.DragEvent, index: number) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDragOverIndex(index);
    };

    const handleDragLeave = () => {
        setDragOverIndex(null);
    };

    const handleDrop = (e: React.DragEvent, targetIndex: number) => {
        e.preventDefault();

        if (draggedItem === null) return;

        const draggedIndex = inputBoxes.findIndex(box => box.id === draggedItem);
        if (draggedIndex === -1 || draggedIndex === targetIndex) return;

        const newBoxes = [...inputBoxes];
        const [removed] = newBoxes.splice(draggedIndex, 1);
        newBoxes.splice(targetIndex, 0, removed);

        setInputBoxes(newBoxes);
        setDraggedItem(null);
        setDragOverIndex(null);
    };

    const handleDragEnd = () => {
        setDraggedItem(null);
        setDragOverIndex(null);
    };

    const [fileDragOverBox, setFileDragOverBox] = useState<number | null>(null);

    const handleFileDragOver = (e: React.DragEvent, boxId: number) => {
        e.preventDefault();
        e.stopPropagation();

        if (e.dataTransfer.types.includes('Files')) {
            setFileDragOverBox(boxId);
        }
    };

    const handleFileDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();

        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const x = e.clientX;
        const y = e.clientY;

        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
            setFileDragOverBox(null);
        }
    };

    const handleFileDrop = async (e: React.DragEvent, boxId: number) => {
        e.preventDefault();
        e.stopPropagation();

        setFileDragOverBox(null);

        const files = e.dataTransfer.files;
        if (files.length > 0) {
            await addFilesToBox(boxId, files);
        }
    };

    const handleExpandPrompt = (id: number) => {
        const box = inputBoxes.find(b => b.id === id);
        if (box) {
            setExpandedPrompt({ id, value: box.value, files: box.files });
        }
    };

    const handleSaveExpanded = () => {
        if (expandedPrompt) {
            setInputBoxes(prev =>
                prev.map(box =>
                    box.id === expandedPrompt.id ? { ...box, value: expandedPrompt.value, files: expandedPrompt.files } : box
                )
            );
            setExpandedPrompt(null);
        }
    };

    const handleCloseModal = () => {
        setExpandedPrompt(null);
    };

    const handleExpandedValueChange = (value: string) => {
        if (expandedPrompt) {
            setExpandedPrompt({ ...expandedPrompt, value });
        }
    };

    const handleExpandedFilesChange = (files: FileData[]) => {
        if (expandedPrompt) {
            setExpandedPrompt({ ...expandedPrompt, files });
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            handleCloseModal();
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            handleSaveExpanded();
        }
    };

    const allBoxesFilled = inputBoxes.every(box => box.value.trim() || box.files.length > 0);
    const hasAnyContent = inputBoxes.some(box => box.value.trim() || box.files.length > 0);
    const canAddMore = inputBoxes.length < 5;

    return (
        <div className={`h-full flex flex-col ${theme.bg}`}>
            {}
            <div className={`p-4 ${theme.borderColor} border-b`}>
                <div className="flex items-center gap-2 mb-2">
                    <h2 className={`text-lg font-semibold ${theme.textPrimary}`}>AI Writing Assistant</h2>
                    {activeSection && (
                        <span className={`px-2 py-1 text-xs rounded-full ${theme.accentBg} text-white`}>
                            {activeSection}
                        </span>
                    )}
                </div>
                {activeSection && template && (
                    <div className={`text-sm ${theme.textSecondary}`}>
                        Working on {activeSection} section
                    </div>
                )}
            </div>

            {}
            <div className="flex-1 min-w-0 p-4 overflow-y-auto">
                <div className="space-y-4">
                    {inputBoxes.map((box, index) => (
                        <div
                            key={box.id}
                            className={`space-y-2 transition-all duration-200 ${dragOverIndex === index ? 'transform scale-105' : ''
                                } ${draggedItem === box.id ? 'opacity-50' : ''
                                }`}
                            onDragOver={(e) => handleDragOver(e, index)}
                            onDragLeave={handleDragLeave}
                            onDrop={(e) => handleDrop(e, index)}
                        >
                            <div className={`${theme.cardBg} rounded-lg p-3 relative flex gap-2 min-w-0`}>
                                {}
                                {inputBoxes.length > 1 && (
                                    <div
                                        draggable
                                        onDragStart={(e) => handleDragStart(e, box.id)}
                                        onDragEnd={handleDragEnd}
                                        className={`cursor-move flex flex-col justify-center items-center w-4 opacity-15 hover:opacity-40 transition-opacity ${theme.textSecondary}`}
                                        title="Drag to reorder"
                                    >
                                        <div className="w-1 h-1 bg-current rounded-full mb-1"></div>
                                        <div className="w-1 h-1 bg-current rounded-full mb-1"></div>
                                        <div className="w-1 h-1 bg-current rounded-full mb-1"></div>
                                        <div className="w-1 h-1 bg-current rounded-full mb-1"></div>
                                        <div className="w-1 h-1 bg-current rounded-full mb-1"></div>
                                        <div className="w-1 h-1 bg-current rounded-full"></div>
                                    </div>
                                )}

                                <textarea
                                    value={box.value}
                                    onChange={(e) => handleInputChange(box.id, e.target.value)}
                                    onPaste={(e) => handlePaste(e, box.id)}
                                    onDragOver={(e) => handleFileDragOver(e, box.id)}
                                    onDragLeave={handleFileDragLeave}
                                    onDrop={(e) => handleFileDrop(e, box.id)}
                                    placeholder="Type message..."
                                    title="Type your message here. Drag & drop files to upload."
                                    className={`${styles.textarea} ${theme.textPrimary} placeholder-${theme.textSecondary.replace('text-', '')} ${fileDragOverBox === box.id ? styles.dragOver : ''}`}
                                />

                                {}

                                {}
                                <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        {}
                                        <FileTypeIcons
                                            files={box.files}
                                            onFileRemove={(fileId) => removeFileFromBox(box.id, fileId)}
                                        />

                                        {}
                                        <button
                                            onClick={() => openDrivePicker(box.id)}
                                            disabled={isGenerating}
                                            className={`w-5 h-5 border-none bg-transparent flex items-center justify-center transition-opacity ${isGenerating
                                                ? 'opacity-25 cursor-not-allowed'
                                                : 'opacity-40 hover:opacity-70'
                                                } ${theme.textSecondary}`}
                                            title="Select files from Google Drive"
                                        >
                                            <HardDrive className="w-4 h-4 text-blue-600" />
                                        </button>
                                    </div>

                                    {}
                                    <button
                                        onClick={() => handleExpandPrompt(box.id)}
                                        className={`${styles.expandButton} ${theme.textSecondary}`}
                                        title="Expand prompt"
                                    >
                                        <span className={styles.expandIcon}>⤢</span>
                                    </button>
                                </div>

                                {}
                                {inputBoxes.length > 1 && (
                                    <button
                                        onClick={() => removeBox(box.id)}
                                        className={`${styles.removeButton} ${theme.textSecondary} ${theme.buttonHover}`}
                                    >
                                        ×
                                    </button>
                                )}
                            </div>

                            {}
                            {index < inputBoxes.length - 1 && (
                                <div className="flex justify-center py-3">
                                    <div className="flex flex-col gap-1">
                                        <div className={`w-1 h-1 bg-gray-500 opacity-20`}></div>
                                        <div className={`w-1 h-1 bg-gray-500 opacity-20`}></div>
                                        <div className={`w-1 h-1 bg-gray-500 opacity-20`}></div>
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}

                    {}
                    {canAddMore && (
                        <div className="flex justify-center">
                            <button
                                onClick={addNewBox}
                                disabled={!allBoxesFilled}
                                className={`${styles.addButton} ${allBoxesFilled ? styles.filled : ''}`}
                            >
                                +
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {}
            <div className={`p-4 ${theme.borderColor} border-t`}>
                <div className="flex justify-end">
                    <button
                        onClick={handleGenerate}
                        disabled={isGenerating || !hasAnyContent}
                        className={`px-4 py-2 ${theme.accentBg} text-white text-sm rounded-md ${theme.accentHover} disabled:opacity-50 disabled:cursor-not-allowed transition-colors`}
                    >
                        {isGenerating ? 'Writing...' : 'Write'}
                    </button>
                </div>
            </div>

            {}
            {expandedPrompt && (
                <div className={styles.modalOverlay} onClick={handleCloseModal}>
                    <div
                        className={styles.modalContent}
                        onClick={(e) => e.stopPropagation()}
                    >
                        {}
                        <FilePreview
                            files={expandedPrompt.files}
                            onFileRemove={(fileId) => {
                                const updatedFiles = expandedPrompt.files.filter(f => f.id !== fileId);
                                handleExpandedFilesChange(updatedFiles);
                            }}
                        />

                        <textarea
                            value={expandedPrompt.value}
                            onChange={(e) => handleExpandedValueChange(e.target.value)}
                            onPaste={(e) => handlePaste(e, expandedPrompt.id)}
                            onDragOver={(e) => handleFileDragOver(e, expandedPrompt.id)}
                            onDragLeave={handleFileDragLeave}
                            onDrop={(e) => handleFileDrop(e, expandedPrompt.id)}
                            onKeyDown={handleKeyDown}
                            placeholder="Type your expanded prompt here..."
                            className={`${styles.modalTextarea} ${theme.bg} ${theme.textPrimary} placeholder-${theme.textSecondary.replace('text-', '')} ${fileDragOverBox === expandedPrompt.id ? styles.dragOver : ''}`}
                            autoFocus
                        />

                        <div className={styles.modalFloatingButtons}>
                            <button
                                onClick={handleCloseModal}
                                className={`${styles.modalFloatingButton} ${theme.textSecondary}`}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSaveExpanded}
                                className={`${styles.modalFloatingButton} ${styles.modalFloatingButtonPrimary} ${expandedPrompt.value.trim() ? styles.hasContent : ''} ${theme.textPrimary}`}
                            >
                                Save
                            </button>
                        </div>

                        <div className={`${styles.modalEscapeHint} ${theme.textSecondary}`}>
                            esc to cancel
                        </div>
                    </div>
                </div>
            )}

            {}
            <DriveFilePicker
                isOpen={showDrivePicker}
                onClose={() => {
                    setShowDrivePicker(false);
                    setDrivePickerBoxId(null);
                }}
                onFilesSelected={handleDriveFileSelection}
                multiple={true}
                fileTypes={Object.keys(SUPPORTED_FILE_TYPES)}
            />
        </div>
    );
} 