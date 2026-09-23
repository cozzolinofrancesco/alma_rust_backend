import React from 'react';
import { useDropzone } from 'react-dropzone';
import '../styles/dropzone.css';

const UploadIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
    <polyline points="7,10 12,15 17,10"></polyline>
    <line x1="12" y1="15" x2="12" y2="3"></line>
  </svg>
);

export const DEFAULT_ACCEPT = {
    'application/pdf': ['.pdf'],
    'image/*': ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'],
            'audio/*': ['.mp3', '.wav', '.ogg', '.m4a', '.flac'],
            'video/*': ['.mp4', '.avi', '.mov', '.wmv', '.webm', '.mkv'],
            'text/*': ['.txt', '.md', '.csv'],
            'application/msword': ['.doc'],
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
            'application/vnd.ms-excel': ['.xls'],
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
            'application/vnd.ms-powerpoint': ['.ppt'],
            'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
            'application/json': ['.json'],
            'application/xml': ['.xml'],
            'text/javascript': ['.js'],
            'text/typescript': ['.ts'],
            'text/x-python': ['.py'],
            'text/x-java-source': ['.java'],
            'text/x-c': ['.c'],
            'text/x-c++': ['.cpp'],
            'text/html': ['.html'],
    'text/css': ['.css']
} as const;

interface DropzoneProps {
    onDrop: (acceptedFiles: File[]) => void;
    accept?: Record<string, string[]>;
    maxFiles?: number;
    hint?: string;
}

const Dropzone: React.FC<DropzoneProps> = ({ onDrop, accept = DEFAULT_ACCEPT, maxFiles, hint }) => {
    const { getRootProps, getInputProps } = useDropzone({
        accept,
        maxFiles,
        onDrop,
    });

    const defaultHint = 'Supports: Images, PDFs, Audio, Video, Code, Documents';

    return (
        <div {...getRootProps({ className: 'dropzone' })}>
            <input {...getInputProps()} />
            <div className="dropzone-content">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                    <UploadIcon />
                    <p style={{ margin: 0 }}>Drag and drop files here, or click to browse</p>
                </div>
                <p style={{ fontSize: '0.8rem', color: '#666', marginTop: '0.5rem' }}>
                    {hint ?? defaultHint}
                </p>
            </div>
        </div>
    );
};

export default Dropzone;
