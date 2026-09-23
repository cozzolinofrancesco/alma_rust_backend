'use client';

import { BookOpen, CircleHelp, ExternalLink, GraduationCap, LogOut, MessageCircle, Shield, Sparkles, Trash2, UserRound } from 'lucide-react';
import { useLanguage, type Locale } from '../../contexts/LanguageContext';
import { useMagnifier } from '../../contexts/MagnifierContext';
import { useTheme, type ColorBlindMode } from '../../contexts/ThemeContext';
import type { TutorialSectionKey } from '../help/sectionTutorials';
import styles from './NavigationHeader.module.css';

interface HelpProps {
  close: () => void;
  onQuestions: () => void;
  onTraining: () => void;
  onQuickInfo: () => void;
  onAssistant: () => void;
  onTutorial: (section: TutorialSectionKey) => void;
}

const tutorialSections: [TutorialSectionKey, string][] = [
  ['home', 'nav.home'], ['projects', 'nav.projects'], ['addData', 'nav.addData'],
  ['agentBuilder', 'nav.agentNodes'],
  ['validation', 'nav.validation'], ['sct272', 'nav.sct272'],
];

export function NavigationHelp({ close, onQuestions, onTraining, onQuickInfo, onAssistant, onTutorial }: HelpProps) {
  const { t } = useLanguage();
  const run = (action: () => void) => { close(); action(); };
  return (
    <div className={styles.utilityLayout}>
      <section>
        <h3>{t('navigation.resources')}</h3>
        <button type="button" className={`${styles.row} ${styles.actionRow}`} onClick={() => run(onQuickInfo)}>
          <CircleHelp size={18} aria-hidden="true" /><span>{t('navigation.pageHelp')}</span>
        </button>
        <button type="button" className={`${styles.row} ${styles.actionRow}`} onClick={() => run(onQuestions)}>
          <MessageCircle size={18} aria-hidden="true" /><span>{t('nav.questions')}</span>
        </button>
        <button type="button" className={`${styles.row} ${styles.actionRow}`} onClick={() => run(onTraining)}>
          <GraduationCap size={18} aria-hidden="true" /><span>{t('navigation.training')}</span>
        </button>
        <button type="button" className={`${styles.row} ${styles.actionRow}`} onClick={() => run(onAssistant)}>
          <Sparkles size={18} aria-hidden="true" /><span>{t('logo.questionsAskMe')}</span>
        </button>
        <a href="https://mail.google.com/chat/u/0/#chat/space/AAQAf_PDi18" target="_blank" rel="noopener noreferrer" className={`${styles.row} ${styles.actionRow}`} onClick={close}>
          <ExternalLink size={18} aria-hidden="true" /><span>{t('home.chatWithUs')}</span>
        </a>
        <a href="https://sites.google.com/roche.com/alma/home" target="_blank" rel="noopener noreferrer" className={`${styles.row} ${styles.actionRow}`} onClick={close}>
          <ExternalLink size={18} aria-hidden="true" /><span>Roche</span>
        </a>
      </section>
      <section>
        <h3>{t('nav.faqTutorial')}</h3>
        {tutorialSections.map(([section, labelKey]) => (
          <button key={section} type="button" className={styles.row} aria-label={t(`nav.faqAria.${section}`)} onClick={() => run(() => onTutorial(section))}>
            {t(labelKey)}
          </button>
        ))}
      </section>
    </div>
  );
}

interface SettingsProps {
  close: () => void;
  userName?: string | null;
  onPrivacy: () => void;
  onTerms: () => void;
  onClearCache: () => void;
  onSignOut: () => void;
}

export function NavigationSettings({ close, userName, onPrivacy, onTerms, onClearCache, onSignOut }: SettingsProps) {
  const { t, locale, setLocale } = useLanguage();
  const { colorBlindMode, setColorBlindMode, isDarkMode, toggleTheme } = useTheme();
  const { isMagnifierEnabled, setIsMagnifierEnabled, zoomLevel, setZoomLevel, lensSize, setLensSize } = useMagnifier();
  const run = (action: () => void) => { close(); action(); };
  return (
    <div className={styles.utilityLayout}>
      <section>
        <div className={styles.account}><UserRound size={22} aria-hidden="true" /><span>{userName || t('navigation.account')}</span></div>
        <label className={styles.field}>
          <span>{t('settings.language')}</span>
          <select value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
            <option value="en">{t('settings.languageEnglish')}</option>
            <option value="ja">{t('settings.languageJapanese')}</option>
            <option value="zh">{t('settings.languageChinese')}</option>
          </select>
        </label>
        <div className={styles.settingsActions}>
          <button type="button" className={`${styles.row} ${styles.actionRow}`} onClick={() => run(onPrivacy)}>
            <Shield size={18} aria-hidden="true" /><span>{t('settings.privacy')}</span>
          </button>
          <button type="button" className={`${styles.row} ${styles.actionRow}`} onClick={() => run(onTerms)}>
            <BookOpen size={18} aria-hidden="true" /><span>{t('settings.terms')}</span>
          </button>
          <button type="button" className={`${styles.row} ${styles.actionRow}`} onClick={() => run(onClearCache)}>
            <Trash2 size={18} aria-hidden="true" /><span>{t('settings.clearCaches')}</span>
          </button>
          <button type="button" className={`${styles.row} ${styles.actionRow}`} onClick={() => run(onSignOut)}>
            <LogOut size={18} aria-hidden="true" /><span>{t('settings.logout')}</span>
          </button>
        </div>
      </section>
      <section className={styles.preferences}>
        <h3>{t('settings.accessibility')}</h3>
        <label className={styles.checkLabel}>
          <input type="checkbox" role="switch" checked={isDarkMode} onChange={() => toggleTheme()} />
          <span>{t('settings.darkMode').startsWith('settings.') ? 'Dark mode' : t('settings.darkMode')}</span>
        </label>
        <label className={styles.checkLabel}>
          <input type="checkbox" role="switch" checked={isMagnifierEnabled} onChange={(event) => setIsMagnifierEnabled(event.target.checked)} />
          <span>{t('settings.magnifierEnable')}</span>
        </label>
        {isMagnifierEnabled && (
          <>
            <label className={styles.field}>
              <span>{t('settings.magnifierZoom')} <output>{zoomLevel.toFixed(1)}x</output></span>
              <input type="range" min="1.5" max="3" step="0.1" value={zoomLevel} onChange={(event) => setZoomLevel(Number(event.target.value))} />
            </label>
            <label className={styles.field}>
              <span>{t('settings.magnifierSize')}</span>
              <select value={lensSize} onChange={(event) => setLensSize(event.target.value as 'small' | 'medium' | 'large')}>
                <option value="small">{t('settings.lensSmall')}</option>
                <option value="medium">{t('settings.lensMedium')}</option>
                <option value="large">{t('settings.lensLarge')}</option>
              </select>
            </label>
          </>
        )}
        <label className={styles.field}>
          <span>{t('settings.colorBlindMode')}</span>
          <select value={colorBlindMode} onChange={(event) => setColorBlindMode(event.target.value as ColorBlindMode)}>
            <option value="none">{t('settings.colorBlindNone')}</option>
            <option value="deuteranopia">{t('settings.colorBlindDeuteranopia')}</option>
            <option value="protanopia">{t('settings.colorBlindProtanopia')}</option>
            <option value="tritanopia">{t('settings.colorBlindTritanopia')}</option>
          </select>
        </label>
      </section>
    </div>
  );
}