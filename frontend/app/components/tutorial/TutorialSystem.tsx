'use client';

import React, { useEffect, useRef } from 'react';
import { useTutorial } from '../../hooks/useTutorial';
import { useSplashState } from '../SplashScreenWrapper';
import { TutorialProvider } from './TutorialContext';
import { TutorialEventHandler } from './TutorialEventHandler';
import { TutorialModal } from './TutorialModal';

interface TutorialSystemProps {
    context: 'homepage' | 'navbar' | 'projects';
    autoOpen?: boolean;
    onComplete?: () => void;
}

const TutorialSystemInner: React.FC<TutorialSystemProps> = ({
    context,
    autoOpen = false,
    onComplete
}) => {
    const { openTutorial, shouldAutoShow, isOpen } = useTutorial();
    const { isAuroraComplete } = useSplashState();
    const hasOpenedRef = useRef(false);

    useEffect(() => {
        if (autoOpen && isAuroraComplete && !hasOpenedRef.current) {
            const shouldShow = shouldAutoShow();
            if (shouldShow) {
                console.log('🎓 Aurora completed, opening tutorial (once)');
                if (process.env.NODE_ENV === 'development') {
                    console.log('🧪 Development mode: Tutorial will show every time for testing');
                }
                hasOpenedRef.current = true;
                openTutorial(context);
            }
        }
    }, [autoOpen, isAuroraComplete, context]);

    useEffect(() => {
        hasOpenedRef.current = false;
    }, [context]);

    useEffect(() => {
        if (!isOpen && onComplete) {
            onComplete();
        }
    }, [isOpen, onComplete]);

    return (
        <>
            <TutorialEventHandler />
            <TutorialModal />
        </>
    );
};

export const TutorialSystem: React.FC<TutorialSystemProps> = (props) => {
    return (
        <TutorialProvider>
            <TutorialSystemInner {...props} />
        </TutorialProvider>
    );
}; 