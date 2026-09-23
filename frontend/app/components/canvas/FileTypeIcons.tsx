'use client';

import { useTheme } from '../../contexts/ThemeContext';
import styles from '../../styles/canvas/FileTypeIcons.module.css';

interface FileData {
    id: string;
    name: string;
    type: string;
    size: number;
    content: string | ArrayBuffer;
    preview?: string;
    uploadDate: Date;
}

interface FileTypeIconsProps {
    files: FileData[];
    onFileRemove?: (fileId: string) => void;
}

const getFileTypeIcon = (type: string): string => {
    if (type.startsWith('image/')) return 'IMG';
    if (type.startsWith('video/')) return 'VID';
    if (type.startsWith('audio/')) return 'AUD';
    if (type === 'application/pdf') return 'PDF';
    if (type.startsWith('text/')) return 'TXT';
    if (type === 'application/json' || type.includes('javascript') || type.includes('typescript')) return 'CODE';
    return 'FILE';
};

const getFileTypeColor = (type: string): string => {
    if (type.startsWith('image/')) return 'text-green-500';
    if (type.startsWith('video/')) return 'text-red-500';
    if (type.startsWith('audio/')) return 'text-yellow-500';
    if (type === 'application/pdf') return 'text-blue-500';
    if (type.startsWith('text/')) return 'text-gray-500';
    if (type === 'application/json' || type.includes('javascript') || type.includes('typescript')) return 'text-purple-500';
    return 'text-gray-400';
};

export default function FileTypeIcons({ files, onFileRemove }: FileTypeIconsProps) {
    const { theme } = useTheme();

    if (files.length === 0) return null;

    return (
        <div className={styles.fileIconsContainer}>
            {files.map((file) => (
                <div
                    key={file.id}
                    className={`${styles.fileIcon} ${getFileTypeColor(file.type)}`}
                    title={`${file.name} (${(file.size / 1024).toFixed(1)}KB)`}
                >
                    <span className={styles.fileIconEmoji}>
                        {getFileTypeIcon(file.type)}
                    </span>
                    {onFileRemove && (
                        <button
                            onClick={() => onFileRemove(file.id)}
                            className={`${styles.removeFileButton} ${theme.textSecondary}`}
                            title="Remove file"
                        >
                            ×
                        </button>
                    )}
                </div>
            ))}
        </div>
    );
} 