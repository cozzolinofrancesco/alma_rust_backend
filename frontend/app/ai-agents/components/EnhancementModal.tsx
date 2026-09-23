'use client';

import React, { useEffect } from 'react';
import { FaTimes } from 'react-icons/fa';

interface EnhancementModalProps {
    isVisible: boolean;
    enhancementType: 'prompt' | 'userInput';
    onCancel?: () => void;
    allowCancel?: boolean;
}

const EnhancementModal: React.FC<EnhancementModalProps> = ({
    isVisible,
    enhancementType,
    onCancel,
    allowCancel = false
}) => {
    useEffect(() => {
        if (isVisible) {
            document.body.style.overflow = 'hidden';
            return () => {
                document.body.style.overflow = 'unset';
            };
        }
    }, [isVisible]);

    if (!isVisible) return null;

    const getEnhancementTitle = () => {
        switch (enhancementType) {
            case 'prompt':
                return 'Magic Prompt Enhancement';
                  case 'userInput':
        return 'Enhancing Input Text';
            default:
                return 'Enhancing Content';
        }
    };

    const getEnhancementDescription = () => {
        switch (enhancementType) {
            case 'prompt':
                return `Analyzing your prompt structure and content for optimization opportunities...
                
Refining language to be more precise and actionable...

Enhancing clarity and specificity to improve AI response quality...

Applying professional formatting and best practices...

Finalizing your enhanced prompt for optimal results...`;
            case 'userInput':
                return 'AI is enhancing your input text to make it more detailed, clear, and well-organized...';
            default:
                return 'AI is processing and enhancing your content...';
        }
    };

    return (
        <div className="enhancement-modal-overlay">
            <div className="enhancement-modal-container">
                {}
                <div className="enhancement-modal-header">
                    <div className="enhancement-modal-title">
                        <h2>{getEnhancementTitle()}</h2>
                    </div>
                    {allowCancel && onCancel && (
                        <button
                            className="enhancement-cancel-btn"
                            onClick={onCancel}
                            title="Cancel Enhancement"
                        >
                            <FaTimes />
                        </button>
                    )}
                </div>

                {}
                <div className="enhancement-modal-content">
                    {}
                    <div className="enhancement-animation-container">
                        <div className="enhancement-cube">
                            <div className="enhancement-cube-face front">✨</div>
                            <div className="enhancement-cube-face back">🚀</div>
                            <div className="enhancement-cube-face right">💡</div>
                            <div className="enhancement-cube-face left">🎯</div>
                            <div className="enhancement-cube-face top">⭐</div>
                            <div className="enhancement-cube-face bottom">🔮</div>
                        </div>
                    </div>

                    {}
                    <div className="enhancement-status">
                        <p className="enhancement-description">{getEnhancementDescription()}</p>
                        <div className="enhancement-progress">
                            <div className="enhancement-progress-bar">
                                <div className="enhancement-progress-fill"></div>
                            </div>
                            <p className="enhancement-progress-text">Processing with AI...</p>
                        </div>
                    </div>

                    {}
                    <div className="enhancement-tips">
                        <h4>💡 Enhancement Benefits:</h4>
                        <ul>
                            <li>More precise and structured content</li>
                            <li>Better AI model comprehension</li>
                            <li>Improved results and outcomes</li>
                            <li>Professional language and formatting</li>
                        </ul>
                    </div>
                </div>

            </div>
        </div>
    );
};

export default EnhancementModal; 