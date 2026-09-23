'use client';

import React from 'react';
import { TutorialAction, TutorialStep as TutorialStepType } from './ContentVariants';

interface TutorialStepProps {
    step: TutorialStepType;
    onAction: (action: TutorialAction) => void;
}

export const TutorialStep: React.FC<TutorialStepProps> = ({ step, onAction }) => {
    const parseMarkdown = (content: string): JSX.Element => {
        const lines = content.split('\n');
        const elements: JSX.Element[] = [];
        let currentList: string[] = [];
        let listKey = 0;

        const flushList = () => {
            if (currentList.length > 0) {
                elements.push(
                    <ul key={`list-${listKey++}`} className="tutorial-list">
                        {currentList.map((item, index) => (
                            <li key={index} className="tutorial-list-item">
                                {parseInlineMarkdown(item)}
                            </li>
                        ))}
                    </ul>
                );
                currentList = [];
            }
        };

        lines.forEach((line, index) => {
            const trimmedLine = line.trim();

            if (!trimmedLine) {
                flushList();
                return;
            }

            if (trimmedLine.startsWith('**') && trimmedLine.endsWith('**')) {
                flushList();
                const headerText = trimmedLine.slice(2, -2);
                elements.push(
                    <h3 key={`header-${index}`} className="tutorial-section-header">
                        {headerText}
                    </h3>
                );
                return;
            }

            if (trimmedLine.startsWith('- ')) {
                currentList.push(trimmedLine.slice(2));
                return;
            }

            if (/^\d+\.\s/.test(trimmedLine)) {
                currentList.push(trimmedLine.replace(/^\d+\.\s/, ''));
                return;
            }

            flushList();
            if (trimmedLine) {
                elements.push(
                    <p key={`para-${index}`} className="tutorial-paragraph">
                        {parseInlineMarkdown(trimmedLine)}
                    </p>
                );
            }
        });

        flushList();
        return <>{elements}</>;
    };

    const parseInlineMarkdown = (text: string): JSX.Element => {
        const parts = text.split(/(\*\*[^*]+\*\*)/g);

        return (
            <>
                {parts.map((part, index) => {
                    if (part.startsWith('**') && part.endsWith('**')) {
                        return (
                            <strong key={index} className="tutorial-bold">
                                {part.slice(2, -2)}
                            </strong>
                        );
                    }
                    return part;
                })}
            </>
        );
    };

    const getActionButtonClass = (variant: string): string => {
        const baseClass = 'tutorial-action-button';
        switch (variant) {
            case 'primary':
                return `${baseClass} tutorial-action-primary`;
            case 'secondary':
                return `${baseClass} tutorial-action-secondary`;
            case 'outline':
                return `${baseClass} tutorial-action-outline`;
            default:
                return `${baseClass} tutorial-action-secondary`;
        }
    };

    return (
        <div className="tutorial-step">
            {}
            <div className="tutorial-step-header">
                <h2 className="tutorial-step-title">{step.title}</h2>
                {step.subtitle && (
                    <p className="tutorial-step-subtitle">{step.subtitle}</p>
                )}
            </div>

            {}
            <div className="tutorial-step-content">
                {typeof step.content === 'string' ? parseMarkdown(step.content) : step.content}
            </div>

            {}
            {step.actions && step.actions.length > 0 && (
                <div className="tutorial-step-actions">
                    {step.actions.map((action, index) => (
                        <button
                            key={index}
                            className={getActionButtonClass(action.variant)}
                            onClick={() => onAction(action)}
                        >
                            {action.icon && (
                                <span className="tutorial-action-icon">{action.icon}</span>
                            )}
                            {action.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}; 