'use client';

import { useId, useState, type KeyboardEvent } from 'react';
import { Search, X } from 'lucide-react';
import { useLanguage } from '../../contexts/LanguageContext';
import { SKILL_COLORS, SKILL_ICON_CATALOG, SKILL_ICON_GROUPS, type SkillAppearance, type SkillColor, type SkillIconCategory } from '../../lib/skillAppearance';
import { skillIconRegistry } from './skillIconRegistry';
import SkillBadge from './SkillBadge';

export interface SkillAppearanceDraft {
  color?: SkillColor;
  icon?: SkillAppearance['icon'];
}

function focusRadio(event: KeyboardEvent<HTMLButtonElement>) {
  const group = event.currentTarget.closest('[role="radiogroup"]');
  const buttons = Array.from(group?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []);
  const index = buttons.indexOf(event.currentTarget);
  const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
    : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : direction ? (index + direction + buttons.length) % buttons.length : null;
  if (next === null || !buttons[next]) return;
  event.preventDefault();
  buttons[next].focus();
  buttons[next].click();
}

export default function SkillIconPicker({ value, onChange, disabled = false, usedColors = [] }: {
  value: SkillAppearanceDraft;
  onChange: (value: SkillAppearanceDraft) => void;
  disabled?: boolean;
  usedColors?: readonly SkillColor[];
}) {
  const { t } = useLanguage();
  const id = useId();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<SkillIconCategory | ''>('');
  const iconLabel = (iconId: string, fallback: string) => {
    const key = `skills.icons.${iconId}`;
    const translated = t(key);
    return translated === key ? fallback : translated;
  };
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const icons = SKILL_ICON_CATALOG.filter((entry) => (!category || entry.category === category) &&
    terms.every((term) => `${entry.id} ${entry.label} ${iconLabel(entry.id, entry.label)} ${entry.category} ${t(`skills.iconCategories.${entry.category}`)}`.toLowerCase().includes(term)));
  const selectedIndex = icons.findIndex((entry) => value.icon?.kind === 'lucide' && value.icon.id === entry.id);
  const selectedColorIndex = Object.keys(SKILL_COLORS).indexOf(value.color ?? '');
  const appearance = value.color && value.icon ? { color: value.color, icon: value.icon } : undefined;

  return (
    <div className="skill-appearance">
      <div className="skill-appearance__preview">
        <SkillBadge appearance={appearance} label="" />
        <span>{t('skills.appearancePreview')}</span>
      </div>
      <div className="skill-modal__label" id={`${id}-colors`}>{t('skills.colorField')}</div>
      <div className="skill-swatches" role="radiogroup" aria-labelledby={`${id}-colors`} aria-required="true">
        {Object.entries(SKILL_COLORS).map(([color, background], index) => (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={value.color === color}
            aria-label={t(`skills.colors.${color}`)}
            title={`${t(`skills.colors.${color}`)}${usedColors.includes(color as SkillColor) ? ` (${t('skills.colorUsed')})` : ''}`}
            tabIndex={index === Math.max(0, selectedColorIndex) ? 0 : -1}
            className="skill-swatch"
            style={{ backgroundColor: background }}
            disabled={disabled}
            onClick={() => onChange({ ...value, color: color as SkillColor })}
            onKeyDown={focusRadio}
          >
            {value.color === color && <span aria-hidden="true" className="skill-swatch__selected" />}
          </button>
        ))}
      </div>
      <div className="skill-icon-picker__filters">
        <div className="skill-icon-picker__search">
          <Search size={16} aria-hidden="true" />
          <input aria-label={t('skills.searchIcons')} placeholder={t('skills.searchIcons')} value={query} onChange={(event) => setQuery(event.target.value)} disabled={disabled} />
          {query && <button type="button" aria-label={t('skills.clearIconSearch')} title={t('skills.clearIconSearch')} onClick={() => setQuery('')} disabled={disabled}><X size={16} /></button>}
        </div>
        <select aria-label={t('skills.iconCategory')} value={category} onChange={(event) => setCategory(event.target.value as SkillIconCategory | '')} disabled={disabled}>
          <option value="">{t('skills.allIcons')}</option>
          {Object.keys(SKILL_ICON_GROUPS).map((group) => <option key={group} value={group}>{t(`skills.iconCategories.${group}`)}</option>)}
        </select>
      </div>
      <div className="skill-icon-picker__grid" role="radiogroup" aria-label={t('skills.iconField')} aria-required="true">
        {icons.map((entry, index) => {
          const Icon = skillIconRegistry[entry.id];
          const selected = value.icon?.kind === 'lucide' && value.icon.id === entry.id;
          const label = iconLabel(entry.id, entry.label);
          return (
            <button
              key={entry.id}
              type="button"
              role="radio"
              aria-label={label}
              aria-checked={selected}
              title={label}
              tabIndex={index === Math.max(0, selectedIndex) ? 0 : -1}
              className="skill-icon-picker__option"
              disabled={disabled}
              onClick={() => onChange({ ...value, icon: { kind: 'lucide', id: entry.id } })}
              onKeyDown={focusRadio}
            >
              <Icon size={22} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <div className="skill-modal__hint" role="status">{icons.length ? t('skills.iconCount', { count: icons.length }) : t('skills.noIcons')}</div>
    </div>
  );
}