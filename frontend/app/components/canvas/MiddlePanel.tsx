'use client';

import AgentsPanel from './AgentsPanel';
import ChatPanel from './ChatPanel';
import DocumentTreePanel from './DocumentTreePanel';
import DriveFileBrowser from './DriveFileBrowser';
import { ActivePanel } from './Layout';

interface MiddlePanelProps {
    activePanel: ActivePanel;
    onPanelChange: (panel: ActivePanel) => void;
}

export default function MiddlePanel({ activePanel, onPanelChange }: MiddlePanelProps) {
    const renderContent = () => {
        switch (activePanel) {
            case 'files':
                return <DriveFileBrowser
                    onFileSelect={(file) => {
                        console.log('File selected:', file);
                    }}
                    onFolderSelect={(folder) => {
                        console.log('Folder selected:', folder);
                    }}
                />;
            case 'tree':
                return <DocumentTreePanel onPanelChange={onPanelChange} />;
            case 'chat':
                return <ChatPanel />;
            case 'agents':
                return <AgentsPanel />;
            default:
                return <ChatPanel />;
        }
    };

    return (
        <div className="h-full flex flex-col">
            {renderContent()}
        </div>
    );
} 