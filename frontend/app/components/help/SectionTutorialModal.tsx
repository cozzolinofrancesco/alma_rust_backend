'use client';

import React from 'react';
import type { TutorialStep } from './tutorialSteps';
import { SpotlightTour } from '../tutorial/SpotlightTour';
import { useLanguage } from '../../contexts/LanguageContext';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  steps: TutorialStep[];
  title?: string;
}

export default function SectionTutorialModal({ isOpen, onClose, steps, title }: Props) {
  const { t } = useLanguage();

  if (!isOpen || steps.length === 0) {
    return null;
  }

  return (
    <SpotlightTour
      open={isOpen}
      onClose={onClose}
      steps={steps}
      title={title ?? t('nav.faqTutorial')}
      labels={{
        previous: t('agentnodesPage.tutorial.previous') || 'Previous',
        next: t('agentnodesPage.tutorial.next') || 'Next',
        finish: t('agentnodesPage.tutorial.finish') || 'Finish',
        progressOf: ({ current, total }: { current: number; total: number }) =>
          t('agentnodesPage.tutorial.progressOf', { current, total }) || `Step ${current} of ${total}`,
        closeAria: t('agentnodesPage.tutorial.closeAria') || 'Close tutorial',
      }}
      renderStepContent={(step) => (
        <div className="space-y-3">
          <div className="flex items-center gap-2 mb-2">
            {step.icon && <span className="text-indigo-600 flex-shrink-0">{step.icon}</span>}
            <h3 className="text-base font-bold text-gray-900">{step.title}</h3>
          </div>
          <div className="text-sm text-gray-700 leading-relaxed">
            {step.content}
          </div>
        </div>
      )}
    />
  );
}
