'use client';

import { useTheme } from '../../contexts/ThemeContext';

export default function TreePanel() {
    const { theme } = useTheme();

    const files = [
        { name: 'README.md', type: 'file', size: '2.3 KB' },
        {
            name: 'src/', type: 'folder', children: [
                { name: 'components/', type: 'folder' },
                { name: 'pages/', type: 'folder' },
                { name: 'utils/', type: 'folder' },
            ]
        },
        { name: 'package.json', type: 'file', size: '1.1 KB' },
        { name: 'tsconfig.json', type: 'file', size: '0.8 KB' },
    ];

    return (
        <div className={`h-full flex flex-col ${theme.bg}`}>
            {}
            <div className={`p-4 ${theme.borderColor} border-b`}>
                <div className="flex items-center gap-2">
                    <h2 className={`text-lg font-semibold ${theme.textPrimary}`}>File Explorer</h2>
                </div>
            </div>

            {}
            <div className="flex-1 p-4 overflow-y-auto">
                <div className="space-y-2">
                    {files.map((file, index) => (
                        <div key={index} className={`p-2 rounded ${theme.buttonBg} ${theme.buttonHover} transition-colors cursor-pointer`}>
                            <div className="flex items-center gap-2">
                                <span className={`text-sm ${theme.textPrimary} font-medium`}>
                                    {file.name}
                                </span>
                                {file.size && (
                                    <span className={`text-xs ${theme.textSecondary} ml-auto`}>
                                        {file.size}
                                    </span>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {}
            <div className={`p-4 ${theme.borderColor} border-t`}>
                <button className={`w-full py-2 ${theme.accentBg} text-white text-sm rounded-md ${theme.accentHover} transition-colors mb-2`}>
                    New File
                </button>
                <button className={`w-full py-2 ${theme.buttonBg} ${theme.textSecondary} text-sm rounded-md ${theme.buttonHover} transition-colors`}>
                    Open Folder
                </button>
            </div>
        </div>
    );
} 