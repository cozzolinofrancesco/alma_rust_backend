'use client';

import { useEffect } from 'react';
import { useTutorial } from '../../hooks/useTutorial';

export const TutorialEventHandler: React.FC = () => {
    const { openTutorial } = useTutorial();

    useEffect(() => {
        const handleOpenTutorial = (event: CustomEvent) => {
            const { context } = event.detail;
            openTutorial(context);
        };

        window.addEventListener('openTutorial', handleOpenTutorial as EventListener);

        return () => {
            window.removeEventListener('openTutorial', handleOpenTutorial as EventListener);
        };
    }, [openTutorial]);

    return null;
}; 