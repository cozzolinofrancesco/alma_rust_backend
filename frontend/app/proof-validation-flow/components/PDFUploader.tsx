'use client';

import React, { useCallback, useState } from 'react';
import { PDFUploadState } from '../types';

interface PDFUploaderProps {
    onFileUpload: (file: File) => void;
    uploadState: PDFUploadState;
    disabled?: boolean;
}

const PDFUploader: React.FC<PDFUploaderProps> = ({
    onFileUpload,
    uploadState,
    disabled = false
}) => {
    const [dragActive, setDragActive] = useState(false);

    const handleDrag = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === 'dragenter' || e.type === 'dragover') {
            setDragActive(true);
        } else if (e.type === 'dragleave') {
            setDragActive(false);
        }
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setDragActive(false);

        if (disabled || uploadState.processing) return;

        const files = e.dataTransfer.files;
        if (files && files[0]) {
            const file = files[0];
            if (file.type === 'application/pdf') {
                onFileUpload(file);
            } else {
                alert('Please upload a PDF file only.');
            }
        }
    }, [onFileUpload, disabled, uploadState.processing]);

    const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (files && files[0]) {
            const file = files[0];
            if (file.type === 'application/pdf') {
                onFileUpload(file);
            } else {
                alert('Please upload a PDF file only.');
            }
        }
    }, [onFileUpload]);

    const formatFileSize = (bytes: number): string => {
        const mb = bytes / (1024 * 1024);
        return mb.toFixed(1) + ' MB';
    };

    return (
        <div className="w-full max-w-4xl mx-auto">
            <div className="bg-white rounded-2xl shadow-lg border-2 border-gray-100 p-8">
                <h2 className="text-2xl font-bold text-[#11074A] mb-6 text-center">
                    Upload Research Paper
                </h2>

                {}
                <div
                    className={`
            relative border-2 border-dashed rounded-xl p-12 text-center transition-all duration-300
            ${dragActive ? 'border-[#11074A] bg-[#11074A]/5' : 'border-[#AFA8BA]'}
            ${disabled || uploadState.processing ? 'opacity-50 cursor-not-allowed' : 'hover:border-[#11074A] hover:bg-gray-50 cursor-pointer'}
          `}
                    onDragEnter={handleDrag}
                    onDragLeave={handleDrag}
                    onDragOver={handleDrag}
                    onDrop={handleDrop}
                >
                    <input
                        type="file"
                        accept=".pdf"
                        onChange={handleFileInput}
                        disabled={disabled || uploadState.processing}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                        id="pdf-upload"
                    />

                    {uploadState.processing ? (
                        <div className="space-y-4">
                            <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-[#11074A]"></div>
                            <div>
                                <p className="text-lg font-medium text-[#11074A]">Processing PDF...</p>
                                <p className="text-[#4A4453]">Sending to Gemini AI for analysis</p>
                            </div>
                            {uploadState.uploadProgress > 0 && (
                                <div className="w-full bg-gray-200 rounded-full h-2">
                                    <div
                                        className="bg-[#11074A] h-2 rounded-full transition-all duration-300"
                                        style={{ width: `${uploadState.uploadProgress}%` }}
                                    ></div>
                                </div>
                            )}
                        </div>
                    ) : uploadState.file ? (
                        <div className="space-y-4">
                            <div className="inline-flex items-center justify-center w-16 h-16 bg-red-100 rounded-full">
                                <svg className="w-8 h-8 text-red-600" fill="currentColor" viewBox="0 0 20 20">
                                    <path fillRule="evenodd" d="M4 4a2 2 0 012-2h8a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 0v12h8V4H6z" clipRule="evenodd" />
                                </svg>
                            </div>
                            <div>
                                <p className="text-lg font-medium text-[#11074A]">
                                    {uploadState.file.name}
                                </p>
                                <p className="text-[#4A4453]">
                                    {formatFileSize(uploadState.file.size)} • Ready for analysis
                                </p>
                            </div>
                            <button
                                onClick={() => onFileUpload(uploadState.file!)}
                                className="inline-flex items-center px-6 py-3 bg-[#11074A] text-white font-medium rounded-lg hover:bg-[#11074A]/90 transition-colors"
                            >
                                Start Analysis
                            </button>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            <div className="inline-flex items-center justify-center w-16 h-16 bg-[#AFA8BA]/20 rounded-full">
                                <svg className="w-8 h-8 text-[#4A4453]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                                </svg>
                            </div>
                            <div>
                                <p className="text-xl font-medium text-[#11074A] mb-2">
                                    Drop your PDF here or click to browse
                                </p>
                                <p className="text-[#4A4453]">
                                    Supports research papers up to 10MB
                                </p>
                            </div>
                            <div className="flex flex-wrap justify-center gap-2 text-sm text-[#4A4453]">
                                <span className="px-3 py-1 bg-[#AFA8BA]/20 rounded-full">Academic Papers</span>
                                <span className="px-3 py-1 bg-[#AFA8BA]/20 rounded-full">Research Reports</span>
                                <span className="px-3 py-1 bg-[#AFA8BA]/20 rounded-full">Journal Articles</span>
                            </div>
                        </div>
                    )}
                </div>

                {}
                {uploadState.error && (
                    <div className="mt-6 p-4 bg-red-50 border border-red-200 rounded-lg">
                        <div className="flex items-center">
                            <svg className="w-5 h-5 text-red-600 mr-2" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                            </svg>
                            <p className="text-red-800 font-medium">Upload Error</p>
                        </div>
                        <p className="text-red-700 mt-1">{uploadState.error}</p>
                    </div>
                )}

                {}
                <div className="mt-8 bg-[#AFA8BA]/10 rounded-lg p-6">
                    <h3 className="font-semibold text-[#11074A] mb-3">
                        AI Analysis Process
                    </h3>
                    <div className="grid md:grid-cols-2 gap-4 text-[#4A4453]">
                        <div>
                            <h4 className="font-medium mb-2">Step 1: Claims-Evidence</h4>
                            <ul className="text-sm space-y-1">
                                <li>• Identify research claims</li>
                                <li>• Map supporting evidence</li>
                                <li>• Analyze argument strength</li>
                            </ul>
                        </div>
                        <div>
                            <h4 className="font-medium mb-2">Step 2: Reference Network</h4>
                            <ul className="text-sm space-y-1">
                                <li>• Extract citations network</li>
                                <li>• Assess source credibility</li>
                                <li>• Visualize connections</li>
                            </ul>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default PDFUploader; 