'use client';

import { RefreshCw, X } from 'lucide-react';
import { useLanguage } from '../../contexts/LanguageContext';
import type { Skill } from '../../lib/agentSkills';
import SkillBadge from './SkillBadge';
import './skills.css';

interface SkillsBarProps {
  // The full library, used to resolve attached ids to label/icon.
  library: Skill[];
  // Ids attached to the current agent, in display order.
  attachedIds: string[];
  onAddClick: () => void;
  onSelectSkill: (skillId: string) => void;
  onRefresh: () => void;
  onSkillClick: (skillId: string) => void;
  onDetach: (skillId: string) => void;
  onHelpClick: () => void;
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  className?: string;
}

export default function SkillsBar({
  library,
  attachedIds,
  onAddClick,
  onSelectSkill,
  onRefresh,
  onSkillClick,
  onDetach,
  onHelpClick,
  loading = false,
  error = null,
  disabled = false,
  className,
}: SkillsBarProps) {
  const { t } = useLanguage();
  const byId = new Map(library.map((s) => [s.id, s]));

  return (
    <div className={`skills-bar${className ? ` ${className}` : ''}`}>
      <span className="skills-bar__label">{t('skills.barLabel')}</span>
      <button
        type="button"
        className="skills-bar__help"
        onClick={onHelpClick}
        aria-label={t('skills.help.openAria')}
        title={t('skills.help.openAria')}
      >
        ?
      </button>

      <select
        className="skills-bar__select"
        aria-label={t('skills.selectLabel')}
        aria-busy={loading}
        value=""
        disabled={disabled}
        onFocus={onRefresh}
        onChange={(event) => {
          const skillId = event.target.value;
          if (skillId && !attachedIds.includes(skillId)) onSelectSkill(skillId);
        }}
      >
        <option value="" disabled>
          {library.length > 0
            ? t('skills.selectPlaceholder')
            : loading
              ? t('skills.loadingLibrary')
              : error
                ? t('skills.libraryUnavailable')
                : t('skills.noSavedSkills')}
        </option>
        {library.map((skill) => (
          <option key={skill.id} value={skill.id} disabled={attachedIds.includes(skill.id)}>
            {skill.label}
          </option>
        ))}
      </select>

      <div className="skills-bar__items" role="list" aria-label={t('skills.attachedSkills')}>
      {attachedIds.map((id) => {
        const skill = byId.get(id);
        if (!skill) {
          return (
            <div
              key={id}
              role="listitem"
              className="skills-bar__item skills-bar__item--missing"
              title={t('skills.missingTitle')}
            >
              <SkillBadge label="!" />
              <span className="skills-bar__item-name">{t('skills.missingName')}</span>
              {!disabled && (
                <button
                  type="button"
                  className="skills-bar__remove"
                  aria-label={t('skills.detachAria')}
                  title={t('skills.detachAria')}
                  onClick={() => onDetach(id)}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          );
        }
        return (
          <div key={id} role="listitem" className="skills-bar__item">
            <button type="button" className="skills-bar__details" aria-label={skill.label} title={skill.label} onClick={() => onSkillClick(id)}>
              <SkillBadge appearance={skill.appearance} legacyIcon={skill.icon} label={skill.label} />
              <span className="skills-bar__item-name">{skill.label}</span>
            </button>
            {!disabled && (
              <button
                type="button"
                className="skills-bar__remove"
                aria-label={t('skills.detachAria')}
                title={t('skills.detachAria')}
                onClick={() => onDetach(id)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            )}
          </div>
        );
      })}
      </div>

      <button
        type="button"
        className="skills-bar__add"
        onClick={onAddClick}
        disabled={disabled}
        aria-label={t('skills.addAria')}
        title={t('skills.addTitle')}
      >
        +
      </button>
      {error && (
        <div className="skills-bar__error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="skills-bar__retry"
            aria-label={t('skills.reloadLibrary')}
            title={t('skills.reloadLibrary')}
            disabled={loading}
            onClick={onRefresh}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
