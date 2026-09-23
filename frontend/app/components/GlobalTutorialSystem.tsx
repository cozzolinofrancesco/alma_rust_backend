'use client';

import React from 'react';
import { TutorialSystem } from './tutorial/TutorialSystem';

export const GlobalTutorialSystem: React.FC = () => {
    return <TutorialSystem context="navbar" />;
}; 