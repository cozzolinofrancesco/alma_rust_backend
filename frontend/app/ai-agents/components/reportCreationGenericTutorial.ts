
import type { TranslateFn } from '@/app/contexts/LanguageContext';

export type ReportCreationGenericTutorialKey =
  | 'session'
  | 'processing'
  | 'done'
  | 'matching'
  | 'matchingPreview'
  | 'metaprocessing'
  | 'sec3confirm'
  | 'sec1confirm'
  | 'generating';

export interface ReportCreationGenericTutorialSlide {
  title: string;
  body: string;
}

const GENERIC_SLIDE_COUNTS: Record<ReportCreationGenericTutorialKey, number> = {
  session: 3,
  processing: 3,
  done: 2,
  matching: 4,
  matchingPreview: 3,
  metaprocessing: 2,
  sec3confirm: 3,
  sec1confirm: 3,
  generating: 2,
};

function slidesForKey(t: TranslateFn, key: ReportCreationGenericTutorialKey): ReportCreationGenericTutorialSlide[] {
  const n = GENERIC_SLIDE_COUNTS[key];
  const out: ReportCreationGenericTutorialSlide[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      title: t(`reportCreationModal.walkthrough.generic.${key}.s${i}Title`),
      body: t(`reportCreationModal.walkthrough.generic.${key}.s${i}Body`),
    });
  }
  return out;
}

export function getReportCreationGenericTutorial(
  t: TranslateFn,
): Record<ReportCreationGenericTutorialKey, ReportCreationGenericTutorialSlide[]> {
  return {
    session: slidesForKey(t, 'session'),
    processing: slidesForKey(t, 'processing'),
    done: slidesForKey(t, 'done'),
    matching: slidesForKey(t, 'matching'),
    matchingPreview: slidesForKey(t, 'matchingPreview'),
    metaprocessing: slidesForKey(t, 'metaprocessing'),
    sec3confirm: slidesForKey(t, 'sec3confirm'),
    sec1confirm: slidesForKey(t, 'sec1confirm'),
    generating: slidesForKey(t, 'generating'),
  };
}
