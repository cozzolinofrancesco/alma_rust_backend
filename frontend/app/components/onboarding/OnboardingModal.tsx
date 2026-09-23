import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useOnboarding } from '../../hooks/useOnboarding';
import { onboardingConfig } from './OnboardingData';
import OnboardingStep from './OnboardingStep';

interface OnboardingModalProps {
    isOpen: boolean;
    onClose: () => void;
    onComplete?: () => void;
    projectName?: string;
}

const OnboardingModal: React.FC<OnboardingModalProps> = ({
    isOpen,
    onClose,
    onComplete,
    projectName
}) => {
    const onboarding = useOnboarding({
        onComplete: () => {
            onComplete?.();
            onClose();
        },
        onClose,
        autoOpen: false
    });

    useEffect(() => {
        if (isOpen && !onboarding.isOpen) {
            onboarding.open();
        } else if (!isOpen && onboarding.isOpen) {
            onboarding.close();
        }
    }, [isOpen, onboarding]);

    useEffect(() => {
        if (onboarding.isOpen) {
            document.body.style.overflow = 'hidden';
            return () => {
                document.body.style.overflow = 'unset';
            };
        }
    }, [onboarding.isOpen]);

    if (!onboarding.isOpen || !onboarding.currentStepData) {
        return null;
    }

    const handleBackdropClick = (e: React.MouseEvent) => {
        if (e.target === e.currentTarget && onboardingConfig.dismissible) {
            onboarding.close();
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape' && onboardingConfig.dismissible) {
            onboarding.close();
        }
    };

    return createPortal(
        <div
            className="onboarding-modal-backdrop"
            onClick={handleBackdropClick}
            onKeyDown={handleKeyDown}
            role="dialog"
            aria-modal="true"
            aria-labelledby="onboarding-title"
            tabIndex={-1}
        >
            <div className="onboarding-modal">
                {}
                {onboardingConfig.dismissible && (
                    <button
                        className="onboarding-close-button"
                        onClick={onboarding.close}
                        aria-label="Close onboarding"
                        title="Close (Esc)"
                    >
                        ×
                    </button>
                )}

                {}
                {onboardingConfig.showProgress && (
                    <div className="onboarding-progress-container">
                        <div className="onboarding-progress-bar">
                            <div
                                className="onboarding-progress-fill"
                                style={{ width: `${onboarding.progress}%` }}
                            />
                        </div>
                        <span className="onboarding-progress-text">
                            {Math.round(onboarding.progress)}% Complete
                        </span>
                    </div>
                )}

                {}
                <div className="onboarding-content">
                    <OnboardingStep
                        stepData={onboarding.currentStepData}
                        onAction={onboarding.handleAction}
                        stepNumber={onboarding.currentStep}
                        totalSteps={onboardingConfig.totalSteps}
                    />
                </div>

                {}
                <div className="onboarding-navigation">
                    <div className="onboarding-nav-left">
                        {onboarding.canGoPrevious && (
                            <button
                                className="onboarding-nav-button onboarding-nav-previous"
                                onClick={onboarding.previousStep}
                                title="Previous step (←)"
                            >
                                ← Previous
                            </button>
                        )}
                    </div>

                    <div className="onboarding-nav-center">
                        {}
                        <div className="onboarding-step-dots">
                            {Array.from({ length: onboardingConfig.totalSteps }).map((_, index) => (
                                <button
                                    key={index}
                                    className={`onboarding-step-dot ${index === onboarding.currentStep ? 'active' : ''
                                        } ${index < onboarding.currentStep ? 'completed' : ''
                                        }`}
                                    onClick={() => onboarding.goToStep(index)}
                                    aria-label={`Go to step ${index + 1}`}
                                    title={`Step ${index + 1}`}
                                />
                            ))}
                        </div>
                    </div>

                    <div className="onboarding-nav-right">
                        {onboardingConfig.canSkip && (
                            <button
                                className="onboarding-nav-button onboarding-nav-skip"
                                onClick={onboarding.close}
                                title="Skip onboarding"
                            >
                                Skip Tour
                            </button>
                        )}
                    </div>
                </div>

                {}
                {projectName && (
                    <div className="onboarding-project-context">
                        <span className="onboarding-project-label">Project:</span>
                        <span className="onboarding-project-name">{projectName}</span>
                    </div>
                )}
            </div>
        </div>,
        document.body
    );
};

export default OnboardingModal; 