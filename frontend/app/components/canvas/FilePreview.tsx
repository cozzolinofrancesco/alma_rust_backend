'use client';

import { useTheme } from '../../contexts/ThemeContext';
import React from 'react';
import styles from '../../styles/canvas/FilePreview.module.css';

interface FileData {
    id: string;
    name: string;
    type: string;
    size: number;
    content: string | ArrayBuffer;
    preview?: string;
    uploadDate: Date;
}

interface FilePreviewProps {
    files: FileData[];
    onFileRemove: (fileId: string) => void;
}

const ImagePreview: React.FC<{ file: FileData }> = ({ file }) => (
    <div className={styles.previewItem}>
        <div className={styles.previewContent}>
            <img
                src={file.preview || (file.content as string)}
                alt={file.name}
                className={styles.imagePreview}
            />
        </div>
        <div className={styles.previewInfo}>
            <span className={styles.fileName}>{file.name}</span>
            <span className={styles.fileSize}>{(file.size / 1024).toFixed(1)}KB</span>
        </div>
    </div>
);

const TextPreview: React.FC<{ file: FileData }> = ({ file }) => (
    <div className={styles.previewItem}>
        <div className={styles.previewContent}>
            <pre className={styles.textPreview}>
                {typeof file.content === 'string' ? file.content.substring(0, 200) : '[Binary content]'}
                {typeof file.content === 'string' && file.content.length > 200 && '...'}
            </pre>
        </div>
        <div className={styles.previewInfo}>
            <span className={styles.fileName}>{file.name}</span>
            <span className={styles.fileSize}>{(file.size / 1024).toFixed(1)}KB</span>
        </div>
    </div>
);

const AudioPreview: React.FC<{ file: FileData }> = ({ file }) => (
    <div className={styles.previewItem}>
        <div className={styles.previewContent}>
            <div className={styles.audioPreview}>
                <span className={styles.audioIcon}>🎵</span>
                <span className={styles.audioName}>{file.name}</span>
            </div>
        </div>
        <div className={styles.previewInfo}>
            <span className={styles.fileName}>{file.name}</span>
            <span className={styles.fileSize}>{(file.size / 1024).toFixed(1)}KB</span>
        </div>
    </div>
);

const VideoPreview: React.FC<{ file: FileData }> = ({ file }) => (
    <div className={styles.previewItem}>
        <div className={styles.previewContent}>
            <div className={styles.videoPreview}>
                <span className={styles.videoIcon}>🎬</span>
                <span className={styles.videoName}>{file.name}</span>
            </div>
        </div>
        <div className={styles.previewInfo}>
            <span className={styles.fileName}>{file.name}</span>
            <span className={styles.fileSize}>{(file.size / 1024).toFixed(1)}KB</span>
        </div>
    </div>
);

const DocumentPreview: React.FC<{ file: FileData }> = ({ file }) => (
    <div className={styles.previewItem}>
        <div className={styles.previewContent}>
            <div className={styles.documentPreview}>
                <span className={styles.documentIcon}>📄</span>
                <span className={styles.documentName}>{file.name}</span>
            </div>
        </div>
        <div className={styles.previewInfo}>
            <span className={styles.fileName}>{file.name}</span>
            <span className={styles.fileSize}>{(file.size / 1024).toFixed(1)}KB</span>
        </div>
    </div>
);

const getPreviewComponent = (file: FileData): React.ReactElement => {
    if (file.type.startsWith('image/')) {
        return <ImagePreview file={file} />;
    } else if (file.type.startsWith('text/') || file.type.includes('json')) {
        return <TextPreview file={file} />;
    } else if (file.type.startsWith('audio/')) {
        return <AudioPreview file={file} />;
    } else if (file.type.startsWith('video/')) {
        return <VideoPreview file={file} />;
    } else {
        return <DocumentPreview file={file} />;
    }
};

export default function FilePreview({ files, onFileRemove }: FilePreviewProps) {
    const { theme } = useTheme();

    if (files.length === 0) return null;

    return (
        <div className={styles.filePreviewContainer}>
            {files.map((file) => (
                <div key={file.id} className={styles.filePreviewWrapper}>
                    {getPreviewComponent(file)}
                    <button
                        onClick={() => onFileRemove(file.id)}
                        className={`${styles.removeButton} ${theme.textSecondary}`}
                        title="Remove file"
                    >
                        ×
                    </button>
                </div>
            ))}
        </div>
    );
} 