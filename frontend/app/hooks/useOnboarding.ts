import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { onboardingConfig, onboardingSteps } from '../components/onboarding/OnboardingData';

interface OnboardingAction {
    href?: string;
    onClick?: () => void;
    label?: string;
}

export interface UseOnboardingReturn {
    currentStep: number;
    isOpen: boolean;
    canGoNext: boolean;
    canGoPrevious: boolean;
    progress: number;
    currentStepData: typeof onboardingSteps[0] | null;
    nextStep: () => void;
    previousStep: () => void;
    goToStep: (step: number) => void;
    close: () => void;
    open: () => void;
    handleAction: (action: OnboardingAction) => void;
    reset: () => void;
}

interface UseOnboardingOptions {
    onComplete?: () => void;
    onClose?: () => void;
    startStep?: number;
    autoOpen?: boolean;
}

export function useOnboarding(options: UseOnboardingOptions = {}): UseOnboardingReturn {
    const { onComplete, onClose, startStep = 0, autoOpen = false } = options;
    const router = useRouter();

    const [currentStep, setCurrentStep] = useState(startStep);
    const [isOpen, setIsOpen] = useState(autoOpen);

    const canGoNext = currentStep < onboardingSteps.length - 1;
    const canGoPrevious = currentStep > 0;
    const progress = ((currentStep + 1) / onboardingSteps.length) * 100;
    const currentStepData = onboardingSteps[currentStep] || null;

    const nextStep = useCallback(() => {
        if (canGoNext) {
            setCurrentStep(prev => prev + 1);
        } else {
            onComplete?.();
            setIsOpen(false);
        }
    }, [canGoNext, onComplete]);

    const previousStep = useCallback(() => {
        if (canGoPrevious) {
            setCurrentStep(prev => prev - 1);
        }
    }, [canGoPrevious]);

    const goToStep = useCallback((step: number) => {
        if (step >= 0 && step < onboardingSteps.length) {
            setCurrentStep(step);
        }
    }, []);

    const close = useCallback(() => {
        setIsOpen(false);
        onClose?.();
    }, [onClose]);

    const open = useCallback(() => {
        setIsOpen(true);
    }, []);

    const reset = useCallback(() => {
        setCurrentStep(startStep);
        setIsOpen(autoOpen);
    }, [startStep, autoOpen]);

    const handleAction = useCallback((action: OnboardingAction) => {
        if (action.href) {
            router.push(action.href);
            setTimeout(() => close(), 100);
        } else if (action.onClick) {
            action.onClick();
        } else if (action.label === 'Continue Tour' || action.label === 'Next Step') {
            nextStep();
        } else if (action.label === 'Finish Tour') {
            onComplete?.();
            close();
        } else if (action.label === 'Skip to Dashboard') {
            router.push('/');
            close();
        }
    }, [router, nextStep, close, onComplete]);

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
                    if (onboardingConfig.dismissible) {
                        event.preventDefault();
                        close();
                    }
                    break;
                case 'Home':
                    event.preventDefault();
                    goToStep(0);
                    break;
                case 'End':
                    event.preventDefault();
                    goToStep(onboardingSteps.length - 1);
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, nextStep, previousStep, goToStep, close]);

    return {
        currentStep,
        isOpen,
        canGoNext,
        canGoPrevious,
        progress,
        currentStepData,
        nextStep,
        previousStep,
        goToStep,
        close,
        open,
        handleAction,
        reset
    };
} 