import { useRouter } from 'next/navigation';
import { useCallback, useEffect } from 'react';
import { TutorialAction } from '../components/tutorial/ContentVariants';
import { useTutorialContext } from '../components/tutorial/TutorialContext';
import { markTutorialCompleted, shouldShowTutorial } from '../lib/tutorialCookies';

export interface UseTutorialReturn {
    isOpen: boolean;
    currentContext: 'homepage' | 'navbar' | 'projects';
    currentStep: number;
    totalSteps: number;
    canGoNext: boolean;
    canGoPrevious: boolean;
    openTutorial: (context: 'homepage' | 'navbar' | 'projects') => void;
    closeTutorial: () => void;
    nextStep: () => void;
    previousStep: () => void;
    goToStep: (step: number) => void;
    handleAction: (action: TutorialAction) => void;
    shouldAutoShow: () => boolean;
}

export const useTutorial = (): UseTutorialReturn => {
    const router = useRouter();
    const {
        isOpen,
        currentContext,
        currentStep,
        totalSteps,
        openTutorial: contextOpenTutorial,
        closeTutorial: contextCloseTutorial,
        nextStep: contextNextStep,
        previousStep: contextPreviousStep,
        goToStep: contextGoToStep,
        setTotalSteps
    } = useTutorialContext();

    useEffect(() => {
        setTotalSteps(3);
    }, [currentContext, setTotalSteps]);

    const canGoNext = currentStep < totalSteps - 1;
    const canGoPrevious = currentStep > 0;

    const openTutorial = useCallback((context: 'homepage' | 'navbar' | 'projects') => {
        contextOpenTutorial(context);
    }, [contextOpenTutorial]);

    const closeTutorial = useCallback(() => {
        markTutorialCompleted(currentContext);
        contextCloseTutorial();
    }, [currentContext, contextCloseTutorial]);

    const nextStep = useCallback(() => {
        console.log(`🎯 useTutorial nextStep: canGoNext=${canGoNext}, step=${currentStep}/${totalSteps - 1}`);

        if (canGoNext) {
            contextNextStep();
        } else {
            console.log('🏁 Tutorial sequence completed');
            closeTutorial();
        }
    }, [canGoNext, contextNextStep, closeTutorial, currentStep, totalSteps]);

    const previousStep = useCallback(() => {
        if (canGoPrevious) {
            contextPreviousStep();
        }
    }, [canGoPrevious, contextPreviousStep]);

    const goToStep = useCallback((step: number) => {
        contextGoToStep(step);
    }, [contextGoToStep]);

    const handleAction = useCallback((action: TutorialAction) => {
        if (action.href) {
            router.push(action.href);
            setTimeout(() => closeTutorial(), 100);
        } else if (action.onClick) {
            action.onClick();
        } else if (action.label === 'Continue Tour' || action.label === 'Next Step' || action.label === 'Continue' || action.label === 'Next Tip') {
            console.log(`🔘 Action clicked: "${action.label}" - triggering nextStep()`);
            nextStep();
        } else if (action.label === 'Finish Tutorial' || action.label === 'Finish Tour' || action.label === 'Finish Setup') {
            closeTutorial();
        } else if (action.label === 'Skip for Now' || action.label === 'Skip to Dashboard') {
            router.push('/');
            closeTutorial();
        }
    }, [router, nextStep, closeTutorial]);

    const shouldAutoShow = useCallback(() => {
        return shouldShowTutorial();
    }, []);

    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (event: KeyboardEvent) => {
            switch (event.key) {
                case 'ArrowRight':
                case 'ArrowDown':
                    event.preventDefault();
                    nextStep();
                    break;
                case 'ArrowLeft':
                case 'ArrowUp':
                    event.preventDefault();
                    previousStep();
                    break;
                case 'Escape':
                    event.preventDefault();
                    closeTutorial();
                    break;
                case 'Home':
                    event.preventDefault();
                    goToStep(0);
                    break;
                case 'End':
                    event.preventDefault();
                    goToStep(totalSteps - 1);
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, nextStep, previousStep, closeTutorial, goToStep, totalSteps]);

    return {
        isOpen,
        currentContext,
        currentStep,
        totalSteps,
        canGoNext,
        canGoPrevious,
        openTutorial,
        closeTutorial,
        nextStep,
        previousStep,
        goToStep,
        handleAction,
        shouldAutoShow
    };
}; 