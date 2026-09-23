'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';

export type StepPickerContext = 'drag' | 'edge' | 'canvas';

export type StepPickerChoice =
  | 'classic'
  | 'audit'
  | 'insert-between'
  | 'send-email'
  | 'export-gdrive'
  | 'send-agent'
  | 'import-github'
  | 'import-gitlab'
  | 'connect-sql'
  | 'connect-rag'
  | 'search-online'
  | 'research-doi'
  | 'import-atlassian'
  | 'update-sql'
  | 'update-rag'
  | 'update-atlassian'
  | 'push-repo'
  | 'api-endpoint'
  | 'condition-branch'
  | 'gate-approval'
  | 'parallel-split';

interface MenuEntry {
  id: StepPickerChoice;
  labelKey: string;
  descriptionKey?: string;
  wip?: boolean;
  edgeOnly?: boolean;
}

interface MenuSection {
  titleKey: string;
  items: MenuEntry[];
}

const SECTION_DEFS: MenuSection[] = [
  {
    titleKey: 'agentnodesPage.stepPicker.secStep',
    items: [
      { id: 'classic', labelKey: 'agentnodesPage.stepPicker.classic' },
      { id: 'audit', labelKey: 'agentnodesPage.stepPicker.audit', wip: true },
    ],
  },
  {
    titleKey: 'agentnodesPage.stepPicker.secReadImport',
    items: [
      { id: 'import-github', labelKey: 'agentnodesPage.stepPicker.importGithub', wip: true },
      { id: 'import-gitlab', labelKey: 'agentnodesPage.stepPicker.importGitlab', wip: true },
      { id: 'import-atlassian', labelKey: 'agentnodesPage.stepPicker.importAtlassian', wip: true },
      { id: 'research-doi', labelKey: 'agentnodesPage.stepPicker.researchDoi', wip: true },
      { id: 'search-online', labelKey: 'agentnodesPage.stepPicker.searchOnline', wip: true },
      { id: 'connect-sql', labelKey: 'agentnodesPage.stepPicker.connectSql', wip: true },
      { id: 'connect-rag', labelKey: 'agentnodesPage.stepPicker.connectRag', wip: true },
    ],
  },
  {
    titleKey: 'agentnodesPage.stepPicker.secWriteOutput',
    items: [
      { id: 'push-repo', labelKey: 'agentnodesPage.stepPicker.pushRepo', wip: true },
      { id: 'update-sql', labelKey: 'agentnodesPage.stepPicker.updateSql', wip: true },
      { id: 'update-rag', labelKey: 'agentnodesPage.stepPicker.updateRag', wip: true },
      { id: 'update-atlassian', labelKey: 'agentnodesPage.stepPicker.updateAtlassian', wip: true },
      { id: 'export-gdrive', labelKey: 'agentnodesPage.stepPicker.exportGdrive', wip: true },
    ],
  },
  {
    titleKey: 'agentnodesPage.stepPicker.secActions',
    items: [
      { id: 'api-endpoint', labelKey: 'agentnodesPage.stepPicker.apiEndpoint', wip: true },
      { id: 'send-email', labelKey: 'agentnodesPage.stepPicker.sendEmail', wip: true },
      { id: 'send-agent', labelKey: 'agentnodesPage.stepPicker.sendAgent', wip: true },
    ],
  },
  {
    titleKey: 'agentnodesPage.stepPicker.secFlowControl',
    items: [
      {
        id: 'condition-branch',
        labelKey: 'agentnodesPage.stepPicker.conditionBranch',
        descriptionKey: 'agentnodesPage.stepPicker.descConditionBranch',
        wip: true,
      },
      {
        id: 'gate-approval',
        labelKey: 'agentnodesPage.stepPicker.gateApproval',
        descriptionKey: 'agentnodesPage.stepPicker.descGateApproval',
        wip: true,
      },
      {
        id: 'parallel-split',
        labelKey: 'agentnodesPage.stepPicker.parallelSplit',
        descriptionKey: 'agentnodesPage.stepPicker.descParallelSplit',
        wip: true,
      },
    ],
  },
];

interface Props {
  x: number;
  y: number;
  context: StepPickerContext;
  onSelect: (choice: StepPickerChoice) => void;
  onClose: () => void;
}

export default function StepPickerMenu({ x, y, context, onSelect, onClose }: Props) {
  const { t } = useLanguage();
  const sections = useMemo(
    () =>
      SECTION_DEFS.map((section) => ({
        title: t(section.titleKey),
        items: section.items.map((item) => ({
          ...item,
          label: t(item.labelKey),
          description: item.descriptionKey ? t(item.descriptionKey) : undefined,
        })),
      })),
    [t],
  );
  const ref = useRef<HTMLDivElement>(null);

  const MARGIN   = 8;
  const MENU_W   = 240;
  const HEADER_H = 34;

  const spaceBelow = window.innerHeight - y - MARGIN;
  const spaceAbove = y - MARGIN;
  const openUpward = spaceBelow < 160 && spaceAbove > spaceBelow;

  const DEFAULT_SCROLL_H = 188;
  const availH = (openUpward ? spaceAbove : spaceBelow) - HEADER_H;
  const maxScrollH = Math.max(80, Math.min(DEFAULT_SCROLL_H, availH));

  const safeX = Math.max(MARGIN, Math.min(x, window.innerWidth - MENU_W - MARGIN));
  const safeY = openUpward
    ? Math.max(MARGIN, y - (maxScrollH + HEADER_H))
    : y;

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', handleKey);
    document.addEventListener('mousedown', handleClick);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="an-step-picker"
      style={{ position: 'fixed', top: safeY, left: safeX, zIndex: 1000 }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="an-step-picker__header">{t('agentnodesPage.stepPicker.header')}</div>

      <div className="an-step-picker__scroll" style={{ maxHeight: maxScrollH }}>
        {sections.map((section, si) => (
          <div key={section.title}>
            {si > 0 && <div className="an-step-picker__sep" />}
            <div className="an-step-picker__section-label">{section.title}</div>

            {section.items.map((item) => {
              const disabled = item.wip || (item.edgeOnly && context !== 'edge');
              const primary  = item.edgeOnly && context === 'edge';
              return (
                <button
                  key={item.id}
                  className={[
                    'an-step-picker__item',
                    disabled ? 'an-step-picker__item--disabled' : '',
                    primary  ? 'an-step-picker__item--primary'  : '',
                    item.description ? 'an-step-picker__item--has-desc' : '',
                  ].filter(Boolean).join(' ')}
                  disabled={disabled}
                  onClick={() => !disabled && onSelect(item.id)}
                  title={item.wip ? t('agentnodesPage.stepPicker.wipTitle') : undefined}
                >
                  <span className="an-step-picker__item-body">
                    <span className="an-step-picker__label">{item.label}</span>
                    {item.description && (
                      <span className="an-step-picker__desc">{item.description}</span>
                    )}
                  </span>
                  {item.wip && (
                    <span className="an-step-picker__wip">{t('agentnodesPage.stepPicker.soonBadge')}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
