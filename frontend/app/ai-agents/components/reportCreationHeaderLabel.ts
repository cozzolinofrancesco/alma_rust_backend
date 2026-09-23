import type { TranslateFn } from '@/app/contexts/LanguageContext';

export type ReportCreationActiveView =
  | 'corpus'
  | 'processing'
  | 'done'
  | 'matching'
  | 'metacorpus'
  | 'metaprocessing'
  | 'metaconfirm'
  | 'sec3confirm'
  | 'sec1confirm'
  | 'generating';

export function getReportCreationHeaderLabel(
  t: TranslateFn,
  opts: {
    hasSession: boolean;
    sessionIntroCompleted: boolean;
    activeView: ReportCreationActiveView;
    showPreview: boolean;
  },
): string {
  if (!opts.hasSession) return t('reportCreationModal.header.signIn');
  if (!opts.sessionIntroCompleted) return t('reportCreationModal.header.sessionName');
  switch (opts.activeView) {
    case 'corpus':
      return t('reportCreationModal.header.clinicalStudyCorpus');
    case 'processing':
      return t('reportCreationModal.header.clinicalProcessing');
    case 'done':
      return t('reportCreationModal.header.summariesReady');
    case 'matching':
      return opts.showPreview
        ? t('reportCreationModal.header.agentPreview')
        : t('reportCreationModal.header.section2Matching');
    case 'metacorpus':
      return t('reportCreationModal.header.metaBiomaterial');
    case 'metaprocessing':
      return t('reportCreationModal.header.biomaterialProcessing');
    case 'metaconfirm':
      return t('reportCreationModal.header.biomaterialTemplate');
    case 'sec3confirm':
      return t('reportCreationModal.header.section3');
    case 'sec1confirm':
      return t('reportCreationModal.header.section1');
    case 'generating':
      return t('reportCreationModal.header.generatingAgent');
    default:
      return t('reportCreationModal.header.ctdDefault');
  }
}
