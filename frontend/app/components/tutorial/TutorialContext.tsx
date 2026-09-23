'use client';

import React, { createContext, ReactNode, useContext, useState } from 'react';

export interface TutorialContextType {
    isOpen: boolean;
    currentContext: 'homepage' | 'navbar' | 'projects';
    currentStep: number;
    totalSteps: number;
    openTutorial: (context: 'homepage' | 'navbar' | 'projects') => void;
    closeTutorial: () => void;
    nextStep: () => void;
    previousStep: () => void;
    goToStep: (step: number) => void;
    setTotalSteps: (total: number) => void;
}

const TutorialContext = createContext<TutorialContextType | undefined>(undefined);

interface TutorialProviderProps {
    children: ReactNode;
}

export const TutorialProvider: React.FC<TutorialProviderProps> = ({ children }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [currentContext, setCurrentContext] = useState<'homepage' | 'navbar' | 'projects'>('homepage');
    const [currentStep, setCurrentStep] = useState(0);
    const [totalSteps, setTotalSteps] = useState(3);

    const openTutorial = (context: 'homepage' | 'navbar' | 'projects') => {
        setCurrentContext(context);
        setCurrentStep(0);
        setIsOpen(true);
    };

    const closeTutorial = () => {
        setIsOpen(false);
        setCurrentStep(0);
    };

    const nextStep = () => {
        console.log(`🔄 Tutorial navigation: step ${currentStep}/${totalSteps - 1}`);

        if (currentStep >= totalSteps - 1) {
            console.log('📝 Tutorial completed - closing');
            closeTutorial();
            return;
        }

        const nextStepIndex = currentStep + 1;
        console.log(`➡️ Moving to step ${nextStepIndex}`);
        setCurrentStep(nextStepIndex);
    };

    const previousStep = () => {
        if (currentStep > 0) {
            setCurrentStep(prev => prev - 1);
        }
    };

    const goToStep = (step: number) => {
        if (step >= 0 && step < totalSteps) {
            setCurrentStep(step);
        }
    };

    const value: TutorialContextType = {
        isOpen,
        currentContext,
        currentStep,
        totalSteps,
        openTutorial,
        closeTutorial,
        nextStep,
        previousStep,
        goToStep,
        setTotalSteps
    };

    return (
        <TutorialContext.Provider value={value}>
            {children}
        </TutorialContext.Provider>
    );
};

export const useTutorialContext = (): TutorialContextType => {
    const context = useContext(TutorialContext);
    if (context === undefined) {
        throw new Error('useTutorialContext must be used within a TutorialProvider');
    }
    return context;
}; 