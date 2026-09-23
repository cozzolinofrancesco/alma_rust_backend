import type { TranslateFn } from '@/app/contexts/LanguageContext';

export type CorpusLayoutVariant = 'clinical' | 'biomaterial';

export interface ReportCreationTutorialSlide {
  title: string;
  body: string;
}

export function getCorpusLayoutTutorialSlide(
  t: TranslateFn,
  step: 1 | 2 | 3 | 4,
  variant: CorpusLayoutVariant,
): ReportCreationTutorialSlide {
  const isBio = variant === 'biomaterial';
  switch (step) {
    case 1:
      return {
        title: t('reportCreationModal.walkthrough.corpusLayout.introTitle'),
        body: isBio
          ? t('reportCreationModal.walkthrough.corpusLayout.introBodyBiomaterial')
          : t('reportCreationModal.walkthrough.corpusLayout.introBodyClinical'),
      };
    case 2:
      return {
        title: t('reportCreationModal.walkthrough.corpusLayout.pdfsTitle'),
        body: isBio
          ? t('reportCreationModal.walkthrough.corpusLayout.pdfsBodyBiomaterial')
          : t('reportCreationModal.walkthrough.corpusLayout.pdfsBodyClinical'),
      };
    case 3:
      return {
        title: t('reportCreationModal.walkthrough.corpusLayout.createTitle'),
        body: isBio
          ? t('reportCreationModal.walkthrough.corpusLayout.createBodyBiomaterial')
          : t('reportCreationModal.walkthrough.corpusLayout.createBodyClinical'),
      };
    case 4:
    default:
      return {
        title: isBio
          ? t('reportCreationModal.walkthrough.corpusLayout.existingTitleBiomaterial')
          : t('reportCreationModal.walkthrough.corpusLayout.existingTitleClinical'),
        body: isBio
          ? t('reportCreationModal.walkthrough.corpusLayout.existingBodyBiomaterial')
          : t('reportCreationModal.walkthrough.corpusLayout.existingBodyClinical'),
      };
  }
}

export function getMetaConfirmTutorialSlide(
  t: TranslateFn,
  step: 1 | 2 | 3 | 4 | 5 | 6 | 7,
): ReportCreationTutorialSlide {
  return {
    title: t(`reportCreationModal.walkthrough.metaConfirm.s${step}Title`),
    body: t(`reportCreationModal.walkthrough.metaConfirm.s${step}Body`),
  };
}
