'use client';

import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTutorial } from '../../hooks/useTutorial';
import { useTutorialContent } from '../../hooks/useTutorialContent';
import { TutorialStep } from './TutorialStep';

export const TutorialModal: React.FC = () => {
    const {
        isOpen,
        currentStep,
        totalSteps,
        canGoNext,
        canGoPrevious,
        nextStep,
        previousStep,
        closeTutorial,
        handleAction
    } = useTutorial();

    const {
        currentStepData,
        contextData,
        progress
    } = useTutorialContent();

    useEffect(() => {
        if (isOpen) {
            document.body.style.overflow = 'hidden';
            return () => {
                document.body.style.overflow = 'unset';
            };
        }
    }, [isOpen]);

    if (!isOpen || !currentStepData || !contextData) {
        return null;
    }

    console.log(`🎭 TutorialModal: step ${currentStep}/${totalSteps - 1}, canGoNext=${canGoNext}`);

    const modalContent = (
        <div className="tutorial-overlay">
            <div className="tutorial-modal">
                {}
                <div className="tutorial-header">
                    <div className="tutorial-title-section">
                        <h1 className="tutorial-title">{contextData.title}</h1>
                        <p className="tutorial-subtitle">{contextData.subtitle}</p>
                    </div>
                    <button
                        className="tutorial-close-button"
                        onClick={closeTutorial}
                        aria-label="Close tutorial"
                    >
                        ×
                    </button>
                </div>

                {}
                <div className="tutorial-progress-container">
                    <div className="tutorial-progress-bar">
                        <div
                            className="tutorial-progress-fill"
                            style={{ width: `${progress}%` }}
                        />
                    </div>
                    <span className="tutorial-progress-text">
                        {currentStep + 1} of {totalSteps}
                    </span>
                </div>

                {}
                <div className="tutorial-content">
                    <TutorialStep
                        step={currentStepData}
                        onAction={handleAction}
                    />
                </div>

                {}
                <div className="tutorial-navigation">
                    <button
                        className="tutorial-nav-button tutorial-nav-secondary"
                        onClick={previousStep}
                        disabled={!canGoPrevious}
                    >
                        Previous
                    </button>

                    <div className="tutorial-nav-center">
                        <div className="tutorial-step-indicators">
                            {Array.from({ length: totalSteps }, (_, index) => (
                                <button
                                    key={index}
                                    className={`tutorial-step-indicator ${index === currentStep ? 'active' : ''
                                        } ${index < currentStep ? 'completed' : ''}`}
                                    onClick={() => { }}
                                    aria-label={`Go to step ${index + 1}`}
                                />
                            ))}
                        </div>
                    </div>

                    <button
                        className="tutorial-nav-button tutorial-nav-primary"
                        onClick={nextStep}
                        disabled={false}
                    >
                        {canGoNext ? 'Next' : 'Finish'}
                    </button>
                </div>
            </div>
        </div>
    );

    if (typeof window === 'undefined') {
        return null;
    }

    return createPortal(modalContent, document.body);
}; 