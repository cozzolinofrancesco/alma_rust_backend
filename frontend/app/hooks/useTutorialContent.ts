import { useMemo } from 'react';
import { ContentVariant, contentVariants, TutorialStep } from '../components/tutorial/ContentVariants';
import { useTutorialContext } from '../components/tutorial/TutorialContext';

export interface UseTutorialContentReturn {
    currentStepData: TutorialStep | null;
    contextData: ContentVariant | null;
    isLoading: boolean;
    progress: number;
    canGoNext: boolean;
    canGoPrevious: boolean;
}

export const useTutorialContent = (): UseTutorialContentReturn => {
    const { currentContext, currentStep, totalSteps } = useTutorialContext();

    const contextData = useMemo(() => {
        return contentVariants[currentContext] || contentVariants.navbar;
    }, [currentContext]);

    const currentStepData = useMemo(() => {
        if (!contextData || !contextData.steps) return null;
        return contextData.steps[currentStep] || null;
    }, [contextData, currentStep]);

    const progress = useMemo(() => {
        if (totalSteps === 0) return 0;
        return ((currentStep + 1) / totalSteps) * 100;
    }, [currentStep, totalSteps]);

    const canGoNext = currentStep < totalSteps - 1;
    const canGoPrevious = currentStep > 0;

    return {
        currentStepData,
        contextData,
        isLoading: false,
        progress,
        canGoNext,
        canGoPrevious
    };
}; 