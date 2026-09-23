'use client';

import { useCallback, useMemo } from 'react';
import type { TutorialStep } from '../../components/tutorial/ContentVariants';
import { SpotlightTour } from '../../components/tutorial/SpotlightTour';
import { useLanguage } from '../../contexts/LanguageContext';
import AgentNodesTutorialContact from './AgentNodesTutorialContact';
import { getAgentNodesTutorialSteps } from '../lib/agentNodesTutorialSteps';

interface AgentNodesTutorialModalProps {
  open: boolean;
  onClose: () => void;
  onBeforeStep?: (step: TutorialStep) => void;
}

export default function AgentNodesTutorialModal({
  open,
  onClose,
  onBeforeStep,
}: AgentNodesTutorialModalProps) {
  const { t } = useLanguage();
  const steps = useMemo(() => getAgentNodesTutorialSteps(t), [t]);

  const labels = useMemo(
    () => ({
      previous: t('agentnodesPage.tutorial.previous'),
      next: t('agentnodesPage.tutorial.next'),
      finish: t('agentnodesPage.tutorial.finish'),
      progressOf: ({ current, total }: { current: number; total: number }) =>
        t('agentnodesPage.tutorial.progressOf', { current, total }),
      closeAria: t('agentnodesPage.tutorial.closeAria'),
    }),
    [t],
  );

  const renderStepContent = useCallback((step: TutorialStep) => {
    if (step.id === 'an-tut-contact') {
      return <AgentNodesTutorialContact />;
    }
    return null;
  }, []);

  return (
    <SpotlightTour
      open={open}
      onClose={onClose}
      steps={steps}
      onBeforeStep={onBeforeStep}
      title={t('agentnodesPage.tutorial.title')}
      labels={labels}
      renderStepContent={renderStepContent}
    />
  );
}
