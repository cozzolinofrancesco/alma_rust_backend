'use client';

import { CircleHelp } from 'lucide-react';
import { SKILL_COLORS, type SkillAppearance } from '../../lib/skillAppearance';
import { skillIconRegistry } from './skillIconRegistry';

export default function SkillBadge({ appearance, legacyIcon, label, small = false }: {
  appearance?: SkillAppearance;
  legacyIcon?: string;
  label: string;
  small?: boolean;
}) {
  const Icon = appearance?.icon.kind === 'lucide' ? skillIconRegistry[appearance.icon.id] : null;
  const legacy = appearance?.icon.kind === 'legacy' ? appearance.icon.value : legacyIcon;
  return (
    <span
      className={`skill-badge${small ? ' skill-badge--small' : ''}`}
      style={{ backgroundColor: SKILL_COLORS[appearance?.color ?? 'graphite'] }}
      data-skill-icon={appearance?.icon.kind === 'lucide' ? appearance.icon.id : 'legacy'}
      aria-hidden="true"
    >
      {Icon ? <Icon size={small ? 18 : 24} /> : legacy?.trim() || label.trim().charAt(0).toUpperCase() || <CircleHelp size={24} />}
    </span>
  );
}