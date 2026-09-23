'use client';

import { ArrowLeft, BookOpen, Download, FileText, GitBranch, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DOCUMENT_TEMPLATES, DocumentTemplate, useDocument } from '../../contexts/DocumentContext';
import { useTheme } from '../../contexts/ThemeContext';
import { ActivePanel } from './Layout';
import { useProjectContext } from './services/projectFileService';

interface DocumentTreePanelProps {
    onPanelChange: (panel: ActivePanel) => void;
}

export default function DocumentTreePanel({ onPanelChange }: DocumentTreePanelProps) {
    const { theme } = useTheme();
    const {
        template,
        mode,
        activeSection,
        sections,
        setTemplate,
        setActiveSection,
        setMode,
        getMergedDocument,
        resetDocument,
        getAvailableSections
    } = useDocument();

    const { initializeProjectContext, currentProject } = useProjectContext();

    const [showTemplateSelector, setShowTemplateSelector] = useState(false);

    useEffect(() => {
        console.log('🔄 Canvas DocumentTreePanel: Initializing project context on mount');
        const context = initializeProjectContext();
        if (context) {
            console.log('✅ Canvas DocumentTreePanel: Project context loaded:', context);
        } else {
            console.log('📋 Canvas DocumentTreePanel: No project context available at mount');
        }
    }, [initializeProjectContext]);

    useEffect(() => {
        const handleStorageChange = (e: StorageEvent) => {
            if (e.key === 'projectFolder') {
                console.log('📡 Canvas DocumentTreePanel: Project context changed, refreshing...');
                const context = initializeProjectContext();
                if (context) {
                    console.log('✅ Canvas DocumentTreePanel: New project context loaded:', context);
                } else {
                    console.log('❌ Canvas DocumentTreePanel: Failed to load new project context');
                }
            }
        };

        window.addEventListener('storage', handleStorageChange);
        return () => window.removeEventListener('storage', handleStorageChange);
    }, [initializeProjectContext]);

    const handleTemplateSelect = (templateKey: DocumentTemplate) => {
        setTemplate(templateKey);
        setShowTemplateSelector(false);
    };

    const handleSectionClick = (section: string) => {
        setActiveSection(section);
        onPanelChange('chat');
    };

    const handleAssemble = () => {
        setMode('previewing');
    };

    const handleBackToEdit = () => {
        setMode('writing');
    };

    const handleExport = async () => {
        try {
            const mergedContent = getMergedDocument();

            if (!mergedContent.trim()) {
                alert('No content to export. Please add content to your document sections first.');
                return;
            }

            console.log('Starting Google Doc export...');
            console.log('Current URL:', window.location.href);
            console.log('Content length:', mergedContent.length);

            console.log('Making fetch request to:', '/api/docs/create');

            const response = await fetch('/api/docs/create', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: `${template ? DOCUMENT_TEMPLATES[template].name : 'Document'} - ${new Date().toLocaleDateString()}`,
                    content: mergedContent
                }),
                credentials: 'include'
            });

            console.log('Fetch response received:', response);
            console.log('Response status:', response.status);
            console.log('Response ok:', response.ok);

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
                console.error('API error response:', errorData);
                throw new Error(errorData.error || 'Failed to create Google Doc');
            }

            const result = await response.json();
            console.log('Success! API response:', result);

            window.open(result.document.webViewLink, '_blank');

        } catch (error) {
            console.error('Detailed error information:', {
                error: error,
                message: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : 'No stack trace',
                type: typeof error,
                name: error instanceof Error ? error.name : 'Unknown'
            });

            if (error instanceof TypeError && error.message.includes('fetch')) {
                console.error('This appears to be a network/fetch error');
                alert(`Network Error: Could not connect to the server. Please check if the development server is running on port 8080. Error: ${error.message}`);
            } else {
                alert(`Failed to create Google Doc: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        }
    };

    const handleSaveProject = async () => {
        try {
            console.log('🔄 Canvas: Attempting to initialize project context...');
            let projectContext = initializeProjectContext();

            if (!projectContext) {
                projectContext = currentProject;
            }

            if (!projectContext) {
                console.error('❌ Canvas: No project context available');
                console.log('📋 Canvas: localStorage projectFolder:', localStorage.getItem('projectFolder'));
                alert('No project selected. Please select a project from the main application first.');
                return;
            }

            console.log('✅ Canvas: Using project context:', projectContext);

            const mergedContent = getMergedDocument();

            if (!mergedContent.trim()) {
                alert('No content to save. Please add content to your document sections first.');
                return;
            }

            const defaultFileName = `${template ? DOCUMENT_TEMPLATES[template].name : 'Canvas Document'}_${new Date().toISOString().split('T')[0]}`;
            const fileName = prompt('Enter filename for your document:', defaultFileName);
            
            if (!fileName || !fileName.trim()) {
                return;
            }

            console.log('Starting canvas project save...');

            const response = await fetch('/api/canvas/save-project', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    title: `${template ? DOCUMENT_TEMPLATES[template].name : 'Canvas Document'}`,
                    content: mergedContent,
                    projectId: projectContext.projectId,
                    fileName: fileName.trim()
                }),
                credentials: 'include'
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
                console.error('API error response:', errorData);
                throw new Error(errorData.error || 'Failed to save project');
            }

            const result = await response.json();
            console.log('Success! Project saved:', result);

            alert(`Project saved successfully to ${result.folderName}!\nFile: ${result.fileName}`);

        } catch (error) {
            console.error('Error saving project:', error);
            alert(`Failed to save project: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    };

    const handleNewDocument = () => {
        if (confirm('Are you sure you want to start a new document? This will clear all current content.')) {
            resetDocument();
            setShowTemplateSelector(true);
        }
    };

    if (!template || showTemplateSelector) {
        return (
            <div className={`h-full flex flex-col ${theme.bg}`}>
                {}
                <div className={`p-4 ${theme.borderColor} border-b`}>
                    <div className="flex items-center gap-2">
                        <GitBranch className="w-5 h-5" />
                        <h2 className={`text-lg font-semibold ${theme.textPrimary}`}>Document Tree</h2>
                    </div>
                </div>

                {}
                <div className="flex-1 p-4 overflow-y-auto">
                    <div className="space-y-4">
                        <div className={`${theme.textPrimary} text-sm mb-4`}>
                            Choose a document template to get started:
                        </div>

                        {Object.entries(DOCUMENT_TEMPLATES).map(([key, templateData]) => (
                            <div
                                key={key}
                                onClick={() => handleTemplateSelect(key as DocumentTemplate)}
                                className={`p-4 rounded-lg border-2 cursor-pointer transition-all ${theme.cardBg} ${theme.borderColor} hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20`}
                            >
                                <div className="flex items-center gap-3 mb-2">
                                    <BookOpen className="w-5 h-5 text-blue-500" />
                                    <h3 className={`font-semibold ${theme.textPrimary}`}>
                                        {templateData.name}
                                    </h3>
                                </div>
                                <div className={`text-sm ${theme.textSecondary} mb-2`}>
                                    {templateData.sections.length} sections
                                </div>
                                <div className={`text-xs ${theme.textSecondary} flex flex-wrap gap-1`}>
                                    {templateData.sections.map((section) => (
                                        <span key={section} className={`px-2 py-1 rounded ${theme.buttonBg}`}>
                                            {section}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        );
    }

    if (mode === 'writing') {
        const availableSections = getAvailableSections();
        const templateData = DOCUMENT_TEMPLATES[template];

        return (
            <div className={`h-full flex flex-col ${theme.bg}`}>
                {}
                <div className={`p-4 ${theme.borderColor} border-b`}>
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <GitBranch className="w-5 h-5" />
                            <h2 className={`text-lg font-semibold ${theme.textPrimary}`}>Document Tree</h2>
                        </div>
                        <button
                            onClick={handleNewDocument}
                            className={`px-2 py-1 text-xs rounded ${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover} transition-colors`}
                            title="New Document"
                        >
                            New
                        </button>
                    </div>
                    <div className={`text-sm ${theme.textSecondary} mt-1`}>
                        {templateData.name}
                    </div>
                </div>

                {}
                <div className="flex-1 p-4 overflow-y-auto">
                    <div className="space-y-2">
                        {availableSections.map((section) => {
                            const isActive = activeSection === section;
                            const hasContent = sections[section] && sections[section].trim().length > 0;

                            return (
                                <div
                                    key={section}
                                    onClick={() => handleSectionClick(section)}
                                    className={`p-3 rounded-lg cursor-pointer transition-all ${isActive
                                        ? `${theme.accentBg} text-white`
                                        : `${theme.cardBg} ${theme.buttonHover}`
                                        }`}
                                >
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <FileText className="w-4 h-4" />
                                            <span className={`text-sm font-medium ${isActive ? 'text-white' : theme.textPrimary
                                                }`}>
                                                {section}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            {hasContent && (
                                                <div className={`w-2 h-2 rounded-full ${isActive ? 'bg-white' : 'bg-green-500'
                                                    }`} title="Has content" />
                                            )}
                                            <span className={`text-xs ${isActive ? 'text-white/70' : theme.textSecondary
                                                }`}>
                                                {sections[section] ?
                                                    `${sections[section].trim().split(' ').length} words` :
                                                    'Empty'
                                                }
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {}
                <div className={`p-4 ${theme.borderColor} border-t`}>
                    <button
                        onClick={handleAssemble}
                        className={`w-full py-3 ${theme.accentBg} text-white text-sm font-medium rounded-md ${theme.accentHover} transition-colors mb-2`}
                    >
                        Assemble Document
                    </button>
                    <div className={`text-xs ${theme.textSecondary} text-center`}>
                        Preview the complete document before exporting
                    </div>
                </div>
            </div>
        );
    }

    if (mode === 'previewing') {
        const templateData = DOCUMENT_TEMPLATES[template];

        return (
            <div className={`h-full flex flex-col ${theme.bg}`}>
                {}
                <div className={`p-4 ${theme.borderColor} border-b`}>
                    <div className="flex items-center gap-2">
                        <GitBranch className="w-5 h-5" />
                        <h2 className={`text-lg font-semibold ${theme.textPrimary}`}>Document Preview</h2>
                    </div>
                    <div className={`text-sm ${theme.textSecondary} mt-1`}>
                        {templateData.name} - Ready to Export
                    </div>
                </div>

                {}
                <div className="flex-1 p-4 overflow-y-auto">
                    <div className={`p-4 rounded-lg ${theme.cardBg} ${theme.borderColor} border mb-4`}>
                        <div className={`text-sm ${theme.textPrimary} mb-2`}>
                            <strong>Document assembled successfully!</strong>
                        </div>
                        <div className={`text-xs ${theme.textSecondary} mb-2`}>
                            The complete document is now displayed in the main editor for your final review.
                        </div>
                        <div className={`text-xs ${theme.textSecondary}`}>
                            • All sections have been merged in the correct order
                            • The document is ready for export to PDF or Google Docs
                            • Use the Export button in the main editor toolbar
                        </div>
                    </div>

                    {}
                    <div className={`text-sm ${theme.textSecondary} mb-2`}>
                        Document sections:
                    </div>
                    <div className="space-y-1">
                        {getAvailableSections().map((section) => {
                            const hasContent = sections[section] && sections[section].trim().length > 0;
                            const wordCount = sections[section] ? sections[section].trim().split(' ').length : 0;

                            return (
                                <div key={section} className={`flex items-center justify-between p-2 rounded ${theme.buttonBg}`}>
                                    <span className={`text-sm ${theme.textPrimary}`}>
                                        {section}
                                    </span>
                                    <div className="flex items-center gap-2">
                                        <div className={`w-2 h-2 rounded-full ${hasContent ? 'bg-green-500' : 'bg-gray-400'}`} />
                                        <span className={`text-xs ${theme.textSecondary}`}>
                                            {wordCount} words
                                        </span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {}
                <div className={`p-4 ${theme.borderColor} border-t space-y-3`}>
                    <button
                        onClick={handleExport}
                        className={`w-full py-3 ${theme.accentBg} text-white text-sm font-medium rounded-md ${theme.accentHover} transition-colors flex items-center justify-center gap-2`}
                    >
                        <Download className="w-4 h-4" />
                        Export Document
                    </button>
                    <button
                        onClick={handleSaveProject}
                        className={`w-full py-3 ${theme.buttonBg} ${theme.textPrimary} text-sm font-medium rounded-md ${theme.buttonHover} transition-colors flex items-center justify-center gap-2 border ${theme.borderColor}`}
                    >
                        <Save className="w-4 h-4" />
                        Save Project
                    </button>
                    <button
                        onClick={handleBackToEdit}
                        className={`w-full py-2 ${theme.buttonBg} ${theme.textSecondary} text-sm rounded-md ${theme.buttonHover} transition-colors flex items-center justify-center gap-2`}
                    >
                        <ArrowLeft className="w-4 h-4" />
                        Back to Edit
                    </button>
                </div>
            </div>
        );
    }

    return null;
} 