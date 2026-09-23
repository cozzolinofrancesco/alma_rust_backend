
import type { TranslateFn } from '../../../contexts/LanguageContext';
import type { ReviewPresetId } from './presets';
import type { ReviewerId } from './types';

export function reviewerLocalizedName(t: TranslateFn, id: ReviewerId): string {
  return t(`agentnodesPage.reviewers.${id}.name`);
}

export function reviewerLocalizedAnchor(t: TranslateFn, id: ReviewerId): string {
  return t(`agentnodesPage.reviewers.${id}.anchor`);
}

export function reviewerLocalizedDescription(t: TranslateFn, id: ReviewerId): string {
  return t(`agentnodesPage.reviewers.${id}.about`);
}

export function reviewPresetLabel(t: TranslateFn, id: ReviewPresetId): string {
  if (id === 'custom') return '';
  return t(`agentnodesPage.reviewPresets.${id}.label`);
}

export function reviewPresetDescription(t: TranslateFn, id: ReviewPresetId): string {
  if (id === 'custom') return '';
  return t(`agentnodesPage.reviewPresets.${id}.description`);
}
