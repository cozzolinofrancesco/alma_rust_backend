import type { TutorialStep } from '../../components/tutorial/ContentVariants';
import type { TranslateFn } from '../../contexts/LanguageContext';

const NO_ACTIONS: TutorialStep['actions'] = [];

export function getAgentNodesTutorialSteps(t: TranslateFn): TutorialStep[] {
  const shortcutsBody = [
    `**${t('agentnodesPage.help.secToolbar')}**`,
    `- ${t('agentnodesPage.help.liToolbar1')}`,
    `- ${t('agentnodesPage.help.liToolbar2')}`,
    '',
    `**${t('agentnodesPage.help.secCanvas')}**`,
    `- ${t('agentnodesPage.help.liCanvas1')}`,
    `- ${t('agentnodesPage.help.liCanvas2')}`,
    `- ${t('agentnodesPage.help.liCanvas3')}`,
    `- ${t('agentnodesPage.help.liCanvas4')}`,
    `- ${t('agentnodesPage.help.liCanvas5')}`,
    `- ${t('agentnodesPage.help.liCanvas6')}`,
    '',
    `**${t('agentnodesPage.help.secNodes')}**`,
    `- ${t('agentnodesPage.help.liNodes1')}`,
    `- ${t('agentnodesPage.help.liNodes2')}`,
    `- ${t('agentnodesPage.help.liNodes3')}`,
    `- ${t('agentnodesPage.help.liNodes4')}`,
    `- ${t('agentnodesPage.help.liNodes5')}`,
    `- ${t('agentnodesPage.help.liNodes6')}`,
    '',
    `**${t('agentnodesPage.help.secRun')}**`,
    `- ${t('agentnodesPage.help.liRun1')}`,
    '',
    `**${t('agentnodesPage.help.secPersist')}**`,
    `- ${t('agentnodesPage.help.liPersist1')}`,
    `- ${t('agentnodesPage.help.liPersist2')}`,
  ].join('\n');

  return [
    {
      id: 'an-tut-welcome',
      title: t('agentnodesPage.tutorial.step1Title'),
      subtitle: t('agentnodesPage.tutorial.step1Subtitle'),
      content: t('agentnodesPage.tutorial.step1Body'),
      actions: NO_ACTIONS,
    },
    {
      id: 'an-tut-agents',
      title: t('agentnodesPage.tutorial.step2Title'),
      subtitle: t('agentnodesPage.tutorial.step2Subtitle'),
      content: t('agentnodesPage.tutorial.step2Body'),
      actions: NO_ACTIONS,
      target: 'agent-sidebar',
      placement: 'right',
    },
    {
      id: 'an-tut-run',
      title: t('agentnodesPage.tutorial.step3Title'),
      subtitle: t('agentnodesPage.tutorial.step3Subtitle'),
      content: t('agentnodesPage.tutorial.step3Body'),
      actions: NO_ACTIONS,
      target: 'run-toolbar',
      placement: 'bottom',
    },
    {
      id: 'an-tut-edit',
      title: t('agentnodesPage.tutorial.step4Title'),
      subtitle: t('agentnodesPage.tutorial.step4Subtitle'),
      content: t('agentnodesPage.tutorial.step4Body'),
      actions: NO_ACTIONS,
      target: 'graph-canvas',
      placement: 'auto',
    },
    {
      id: 'an-tut-voice',
      title: t('agentnodesPage.tutorial.step5Title'),
      subtitle: t('agentnodesPage.tutorial.step5Subtitle'),
      content: t('agentnodesPage.tutorial.step5Body'),
      actions: NO_ACTIONS,
      target: 'voice-ball',
      placement: 'bottom',
    },
    {
      id: 'an-tut-shortcuts',
      title: t('agentnodesPage.tutorial.step6Title'),
      subtitle: t('agentnodesPage.tutorial.step6Subtitle'),
      content: shortcutsBody,
      actions: NO_ACTIONS,
      target: 'toolbar-tools',
      placement: 'bottom',
    },
    {
      id: 'an-tut-contact',
      title: t('agentnodesPage.tutorial.step7Title'),
      subtitle: t('agentnodesPage.tutorial.step7Subtitle'),
      content: '',
      actions: NO_ACTIONS,
    },
  ];
}
