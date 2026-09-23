'use client';

import { GitBranch, MessageSquare, RotateCcw, Settings, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useDocument } from '../../contexts/DocumentContext';
import { useTheme } from '../../contexts/ThemeContext';
import { ActivePanel } from './Layout';
import SettingsPopup from './SettingsPopup';

interface ButtonBarProps {
    activePanel: ActivePanel;
    onPanelChange: (panel: ActivePanel) => void;
}

export default function ButtonBar({ activePanel, onPanelChange }: ButtonBarProps) {
    const { theme } = useTheme();
    const [showSettingsPopup, setShowSettingsPopup] = useState(false);
    const [showTreeHover, setShowTreeHover] = useState(false);
    const settingsButtonRef = useRef<HTMLButtonElement>(null);
    const treeButtonRef = useRef<HTMLButtonElement>(null);
    const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    const { getActiveSectionInitial, getAvailableSections, setActiveSection, template, resetDocument } = useDocument();

    const buttons = [
        { id: 'tree' as ActivePanel, icon: GitBranch, label: 'Tree' },
        { id: 'chat' as ActivePanel, icon: MessageSquare, label: 'Chat' },
        { id: 'agents' as ActivePanel, icon: Users, label: 'Agents' },
    ];

    useEffect(() => {
        return () => {
            if (hoverTimeoutRef.current) {
                clearTimeout(hoverTimeoutRef.current);
            }
        };
    }, []);

    const toggleSettingsPopup = () => {
        setShowSettingsPopup(!showSettingsPopup);
    };

    const closeSettingsPopup = () => {
        setShowSettingsPopup(false);
    };

    const handleRestart = () => {
        resetDocument();
        onPanelChange('tree');
        setShowTreeHover(false);
    };

    const handleTreeHoverEnter = () => {
        if (hoverTimeoutRef.current) {
            clearTimeout(hoverTimeoutRef.current);
            hoverTimeoutRef.current = null;
        }
        setShowTreeHover(true);
    };

    const handleTreeHoverLeave = () => {
        hoverTimeoutRef.current = setTimeout(() => {
            setShowTreeHover(false);
        }, 150);
    };

    return (
        <div className="flex flex-col h-full p-2 gap-2 justify-between">
            {}
            <div className="flex flex-col gap-2">
                {buttons.map((button) => {
                    const isTreeButton = button.id === 'tree';
                    const sectionInitial = getActiveSectionInitial();

                    return (
                        <div key={button.id} className="relative">
                            <button
                                ref={isTreeButton ? treeButtonRef : undefined}
                                onClick={() => onPanelChange(button.id)}
                                onMouseEnter={() => isTreeButton && handleTreeHoverEnter()}
                                onMouseLeave={() => isTreeButton && handleTreeHoverLeave()}
                                className={`w-full h-10 flex items-center justify-center rounded transition-colors ${activePanel === button.id
                                    ? `${theme.accentBg} text-white`
                                    : `${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover}`
                                    }`}
                                title={button.label}
                            >
                                <div className="relative">
                                    <button.icon className="w-5 h-5" />
                                    {isTreeButton && sectionInitial && (
                                        <div className="absolute -top-1 -right-1 w-3 h-3 bg-white text-black text-xs rounded-full flex items-center justify-center font-bold">
                                            {sectionInitial}
                                        </div>
                                    )}
                                </div>
                            </button>

                            {}
                            {isTreeButton && showTreeHover && template && (
                                <div
                                    className={`absolute left-10 top-0 z-50 min-w-48 max-h-[70vh] overflow-y-auto ${theme.cardBg} ${theme.borderColor} border rounded-lg shadow-lg py-2`}
                                    style={{
                                        maxHeight: 'min(70vh, 400px)'
                                    }}
                                    onMouseEnter={handleTreeHoverEnter}
                                    onMouseLeave={handleTreeHoverLeave}
                                >
                                    <div className={`px-3 py-1 text-xs font-medium ${theme.textSecondary} border-b ${theme.borderColor} sticky top-0 ${theme.cardBg}`}>
                                        Quick Navigation
                                    </div>
                                    <div className="overflow-y-auto">
                                        {getAvailableSections().map((section) => (
                                            <button
                                                key={section}
                                                onClick={() => {
                                                    setActiveSection(section);
                                                    onPanelChange('chat');
                                                    setShowTreeHover(false);
                                                    if (hoverTimeoutRef.current) {
                                                        clearTimeout(hoverTimeoutRef.current);
                                                        hoverTimeoutRef.current = null;
                                                    }
                                                }}
                                                className={`w-full px-3 py-2 text-left text-sm ${theme.textPrimary} ${theme.buttonHover} transition-colors`}
                                            >
                                                {section}
                                            </button>
                                        ))}

                                        {}
                                        <div className={`mx-3 my-1 border-t ${theme.borderColor}`}></div>

                                        {}
                                        <button
                                            onClick={() => {
                                                handleRestart();
                                                if (hoverTimeoutRef.current) {
                                                    clearTimeout(hoverTimeoutRef.current);
                                                    hoverTimeoutRef.current = null;
                                                }
                                            }}
                                            className={`w-full px-3 py-2 text-left text-sm ${theme.textPrimary} ${theme.buttonHover} transition-colors flex items-center gap-2`}
                                        >
                                            <RotateCcw className="w-4 h-4" />
                                            New Document
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {}
            <div className="relative">
                <button
                    ref={settingsButtonRef}
                    onClick={toggleSettingsPopup}
                    className={`w-full h-10 flex items-center justify-center rounded transition-colors ${showSettingsPopup
                        ? `${theme.accentBg} text-white`
                        : `${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover}`
                        }`}
                    title="Settings"
                >
                    <Settings className="w-5 h-5" />
                </button>

                {}
                <SettingsPopup
                    isVisible={showSettingsPopup}
                    onClose={closeSettingsPopup}
                    buttonRef={settingsButtonRef}
                />
            </div>
        </div>
    );
} 