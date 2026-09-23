'use client';

import type { StructuredDocSection } from '../../../canvas-272/lib/exportFormatter';
import { useLanguage } from '../../../contexts/LanguageContext';

interface SectionOutlineProps {
  sections: StructuredDocSection[];
  activeSection: number | null;
  onSelect: (idx: number) => void;
  commentCounts?: Record<number, number>;
}

export default function SectionOutline({
  sections,
  activeSection,
  onSelect,
  commentCounts = {},
}: SectionOutlineProps) {
  const { t } = useLanguage();

  return (
    <nav className="an-section-outline" aria-label={t('agentnodesPage.outline.navAria')}>
      {sections.map((section, idx) => {
        const count = commentCounts[idx] ?? 0;
        return (
          <button
            key={idx}
            type="button"
            className={`an-section-outline__tab${activeSection === idx ? ' an-section-outline__tab--active' : ''}`}
            onClick={() => onSelect(idx)}
            title={section.heading ?? t('agentnodesPage.common.prelude')}
          >
            <span className="an-section-outline__num">{idx + 1}</span>
            {count > 0 && (
              <span
                className="an-section-outline__badge"
                title={count === 1 ? t('agentnodesPage.outline.commentOne') : t('agentnodesPage.outline.comments', { count })}
              >
                {count > 9 ? '9+' : count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
