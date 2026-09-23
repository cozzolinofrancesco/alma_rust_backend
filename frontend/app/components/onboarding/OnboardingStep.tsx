import React from 'react';
import { OnboardingAction, OnboardingStep as StepData } from './OnboardingData';

interface OnboardingStepProps {
    stepData: StepData;
    onAction: (action: OnboardingAction) => void;
    stepNumber: number;
    totalSteps: number;
}

const OnboardingStep: React.FC<OnboardingStepProps> = ({
    stepData,
    onAction,
    stepNumber,
    totalSteps
}) => {
    const handleActionClick = (action: OnboardingAction) => {
        onAction(action);
    };

    const formatContent = (content: string) => {
        return content
            .split('\n')
            .map((line, index) => {
                if (line.includes('**')) {
                    const parts = line.split(/(\*\*.*?\*\*)/g);
                    return (
                        <p key={index} className="onboarding-content-line">
                            {parts.map((part, partIndex) => {
                                if (part.startsWith('**') && part.endsWith('**')) {
                                    return (
                                        <strong key={partIndex} className="onboarding-bold">
                                            {part.slice(2, -2)}
                                        </strong>
                                    );
                                }
                                return part;
                            })}
                        </p>
                    );
                }

                if (line.trim().startsWith('- ')) {
                    return (
                        <div key={index} className="onboarding-bullet-point">
                            <span className="onboarding-bullet">•</span>
                            <span className="onboarding-bullet-text">
                                {line.trim().substring(2)}
                            </span>
                        </div>
                    );
                }

                if (line.trim() === '') {
                    return <div key={index} className="onboarding-spacer" />;
                }

                return (
                    <p key={index} className="onboarding-content-line">
                        {line}
                    </p>
                );
            });
    };

    return (
        <div className="onboarding-step">
            {}
            <div className="onboarding-step-header">
                {stepData.icon && (
                    <div className="onboarding-step-icon">
                        {stepData.icon}
                    </div>
                )}
                <div className="onboarding-step-title-group">
                    <h1 className="onboarding-step-title">
                        {stepData.title}
                    </h1>
                    <p className="onboarding-step-subtitle">
                        {stepData.subtitle}
                    </p>
                </div>
            </div>

            {}
            <div className="onboarding-step-content">
                {formatContent(stepData.content)}
            </div>

            {}
            <div className="onboarding-step-actions">
                {stepData.actions.map((action, index) => (
                    <button
                        key={index}
                        onClick={() => handleActionClick(action)}
                        className={`onboarding-action onboarding-action-${action.variant}`}
                    >
                        {action.label}
                        {action.icon && (
                            <span className="onboarding-action-icon">
                                {action.icon}
                            </span>
                        )}
                    </button>
                ))}
            </div>

            {}
            <div className="onboarding-step-indicator">
                <span className="onboarding-step-counter">
                    Step {stepNumber + 1} of {totalSteps}
                </span>
            </div>
        </div>
    );
};

export default OnboardingStep; 