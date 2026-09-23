
import type { ReviewerId } from './types';

export type ReviewPresetId =
  | 'custom'
  | 'purpose-fit'
  | 'text-essentials'
  | 'text-plus-purpose'
  | 'regulatory-committee';

export interface ReviewPreset {
  readonly id: ReviewPresetId;
  readonly label: string;
  readonly description: string;
  readonly reviewerIds: readonly ReviewerId[];
}

export const REVIEW_PRESETS: readonly ReviewPreset[] = [
  {
    id: 'purpose-fit',
    label: 'Purpose-fit audit',
    description: 'Single reviewer — infers intent and checks clarity and consistency.',
    reviewerIds: ['document-quality'],
  },
  {
    id: 'text-essentials',
    label: 'General text QA',
    description: 'Grammar, clarity, and terminology consistency — domain-agnostic.',
    reviewerIds: ['grammar-mechanics', 'clarity-readability', 'consistency-style'],
  },
  {
    id: 'text-plus-purpose',
    label: 'Text QA + purpose-fit',
    description: 'Combines general text checks with the purpose-fit document auditor.',
    reviewerIds: [
      'document-quality',
      'grammar-mechanics',
      'clarity-readability',
      'consistency-style',
    ],
  },
  {
    id: 'regulatory-committee',
    label: 'Regulatory committee',
    description: 'Clinical, medical writing, FDA, EMA, MDR, and biomaterial reviewers.',
    reviewerIds: [
      'clinical',
      'medical-writer',
      'fda-drugs',
      'ema-drugs',
      'regulatory',
      'sme-biomaterial',
    ],
  },
] as const;

export function detectPresetFromSelection(selected: ReadonlySet<ReviewerId>): ReviewPresetId {
  for (const p of REVIEW_PRESETS) {
    if (p.reviewerIds.length !== selected.size) continue;
    const ok = p.reviewerIds.every((id) => selected.has(id));
    if (ok) return p.id;
  }
  return 'custom';
}
