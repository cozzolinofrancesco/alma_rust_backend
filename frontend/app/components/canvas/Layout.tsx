'use client';

import { DocumentProvider } from '../../contexts/DocumentContext';
import { EditorProvider } from '../../contexts/EditorContext';
import { AgentStepProvider } from '../../contexts/AgentStepContext';
import { IntegrityChainProvider } from '../../contexts/IntegrityChainContext';
import { useTheme } from '../../contexts/ThemeContext';
import { useEffect, useState } from 'react';
import ButtonBar from './ButtonBar';
import MainEditor from './MainEditor';
import MiddlePanel from './MiddlePanel';

export type ActivePanel = 'files' | 'tree' | 'chat' | 'agents';
type FocusMode = 'none' | 'editor' | 'preview';

const DEFAULT_MIDDLE_PANEL_WIDTH_PX = 320;
const MIN_MIDDLE_PANEL_WIDTH_PX = 160;
const MAX_MIDDLE_PANEL_WIDTH_PX = 520;
const COLLAPSE_SNAP_PX = 120;
const LEFT_BUTTON_BAR_WIDTH_PX = 50;
const MIDDLE_RESIZE_HANDLE_WIDTH_PX = 8;
const MIN_EDITOR_WORKSPACE_PX = 820;

export default function Layout() {
    const [activePanel, setActivePanel] = useState<ActivePanel>('chat');
    const [middlePanelWidth, setMiddlePanelWidth] = useState<number>(DEFAULT_MIDDLE_PANEL_WIDTH_PX);
    const [isMiddlePanelCollapsed, setIsMiddlePanelCollapsed] = useState<boolean>(false);
    const [isResizing, setIsResizing] = useState<boolean>(false);
    const [focusMode, setFocusMode] = useState<FocusMode>('none');
    const { theme } = useTheme();

    const getMaxAllowedMiddleWidth = (): number => {
        const viewportLimit = Math.floor(window.innerWidth * 0.35);
        const byEditorSpace = window.innerWidth - LEFT_BUTTON_BAR_WIDTH_PX - MIDDLE_RESIZE_HANDLE_WIDTH_PX - MIN_EDITOR_WORKSPACE_PX;
        return Math.max(MIN_MIDDLE_PANEL_WIDTH_PX, Math.min(MAX_MIDDLE_PANEL_WIDTH_PX, viewportLimit, byEditorSpace));
    };

    useEffect(() => {
        if (focusMode !== 'none') return;

        const adjustForViewport = () => {
            const maxAllowed = getMaxAllowedMiddleWidth();
            setMiddlePanelWidth((prev) => Math.min(prev, maxAllowed));
            if (window.innerWidth < 1100) {
                setIsMiddlePanelCollapsed(true);
            }
        };

        adjustForViewport();
        window.addEventListener('resize', adjustForViewport);
        return () => {
            window.removeEventListener('resize', adjustForViewport);
        };
    }, [focusMode]);

    const handleStartResize = (event: { preventDefault: () => void; clientX: number }): void => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = isMiddlePanelCollapsed ? 0 : middlePanelWidth;
        setIsResizing(true);

        const handleMouseMove = (moveEvent: MouseEvent): void => {
            const deltaX = moveEvent.clientX - startX;
            const nextRawWidth = startWidth + deltaX;

            if (nextRawWidth <= COLLAPSE_SNAP_PX) {
                setIsMiddlePanelCollapsed(true);
                return;
            }

            const maxWidth = getMaxAllowedMiddleWidth();
            const boundedWidth = Math.max(MIN_MIDDLE_PANEL_WIDTH_PX, Math.min(maxWidth, nextRawWidth));

            setMiddlePanelWidth(boundedWidth);
            setIsMiddlePanelCollapsed(false);
        };

        const handleMouseUp = (): void => {
            setIsResizing(false);
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
    };

    const handleToggleMiddlePanel = (): void => {
        setIsMiddlePanelCollapsed((prev) => !prev);
    };

    return (
        <DocumentProvider>
            <IntegrityChainProvider>
            <AgentStepProvider>
            <EditorProvider>
                <div className={`h-full min-h-0 flex ${theme.bg} ${theme.textPrimary} overflow-hidden`}>
                    {}
                    <div className={`w-[50px] shrink-0 ${theme.cardBg} border-r ${theme.borderColor}`}>
                        <ButtonBar
                            activePanel={activePanel}
                            onPanelChange={setActivePanel}
                        />
                    </div>

                    {}
                    {focusMode === 'none' && !isMiddlePanelCollapsed && (
                        <div
                            className={`shrink-0 ${theme.cardBg} border-r ${theme.borderColor} overflow-hidden`}
                            style={{ width: `${middlePanelWidth}px` }}
                        >
                            <MiddlePanel activePanel={activePanel} onPanelChange={setActivePanel} />
                        </div>
                    )}

                    {}
                    {focusMode === 'none' && (
                        <div
                            className={`relative w-2 shrink-0 cursor-col-resize ${isResizing ? theme.accentBg : theme.cardBg} border-r ${theme.borderColor} group`}
                            onMouseDown={handleStartResize}
                            onDoubleClick={handleToggleMiddlePanel}
                            role="separator"
                            aria-orientation="vertical"
                            aria-label="Resize AI Writing Assistant panel"
                        >
                            <button
                                type="button"
                                className={`absolute top-1/2 -translate-y-1/2 -left-1 w-4 h-10 rounded-sm border ${theme.borderColor} ${theme.cardBg} ${theme.buttonHover} text-xs`}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    handleToggleMiddlePanel();
                                }}
                                title={isMiddlePanelCollapsed ? 'Expand panel' : 'Collapse panel'}
                            >
                                {isMiddlePanelCollapsed ? '>' : '<'}
                            </button>
                        </div>
                    )}

                    {}
                    <div className={`flex-1 min-w-0 min-h-0 overflow-hidden ${theme.bg}`}>
                        <MainEditor
                            focusMode={focusMode}
                            onToggleEditorFocusMode={() => setFocusMode((prev) => (prev === 'editor' ? 'none' : 'editor'))}
                            onTogglePreviewFocusMode={() => setFocusMode((prev) => (prev === 'preview' ? 'none' : 'preview'))}
                        />
                    </div>
                </div>
            </EditorProvider>
            </AgentStepProvider>
            </IntegrityChainProvider>
        </DocumentProvider>
    );
} 