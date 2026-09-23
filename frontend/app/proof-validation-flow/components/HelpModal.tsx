'use client';

import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import '../styles/modal.css';

interface HelpModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    content: React.ReactNode;
}

const HelpModal: React.FC<HelpModalProps> = ({ isOpen, onClose, title, content }) => {
    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };

        if (isOpen) {
            document.addEventListener('keydown', handleEscape);
            document.body.style.overflow = 'hidden';
        }

        return () => {
            document.removeEventListener('keydown', handleEscape);
            document.body.style.overflow = 'unset';
        };
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const modalContent = (
        <div
            className="modal-backdrop fixed inset-0 bg-black bg-opacity-50 z-[9999] flex items-center justify-center"
            onClick={onClose}
        >
            <div
                className="modal-content bg-white rounded-2xl shadow-2xl border-2 border-gray-100 p-6 max-w-4xl max-h-[70vh] overflow-y-auto mx-4"
                onClick={(e) => e.stopPropagation()}
            >
                {}
                <div className="flex justify-between items-center mb-4 border-b border-gray-200 pb-3">
                    <h2 className="text-2xl font-bold text-[#11074A]">
                        {title}
                    </h2>
                    <button
                        onClick={onClose}
                        className="text-gray-500 hover:text-gray-700 text-2xl font-bold w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 transition-colors"
                        aria-label="Close help modal"
                    >
                        ×
                    </button>
                </div>

                {}
                <div className="prose prose-lg max-w-none">
                    {content}
                </div>

                {}
                <div className="mt-4 pt-3 border-t border-gray-200 flex justify-end">
                    <button
                        onClick={onClose}
                        className="px-6 py-2 bg-[#11074A] text-white rounded-lg hover:bg-[#1a0b5e] transition-colors font-medium"
                    >
                        Got it!
                    </button>
                </div>
            </div>
        </div>
    );

    return createPortal(modalContent, document.body);
};

export default HelpModal; 