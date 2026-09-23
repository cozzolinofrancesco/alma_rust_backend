'use client';

import React from 'react';
import { Globe } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';

type Variant = 'onDark' | 'onLight';

interface ModalLocaleToggleProps {
  variant?: Variant;
  className?: string;
  style?: React.CSSProperties;
}

export function ModalLocaleToggle({
  variant = 'onLight',
  className,
  style,
}: ModalLocaleToggleProps) {
  const { locale, setLocale, t } = useLanguage();
  const dark = variant === 'onDark';
  const activeBg = dark ? 'rgba(255,255,255,0.2)' : '#eef2ff';
  const activeBorder = dark ? '2px solid rgba(255,255,255,0.9)' : '2px solid #11074A';
  const idleBorder = dark ? '1px solid rgba(255,255,255,0.35)' : '1px solid #e5e7eb';
  const text = dark ? '#fff' : '#11074A';

  const btn = (code: 'en' | 'ja' | 'zh') => ({
    padding: '4px 8px',
    borderRadius: '6px',
    border: locale === code ? activeBorder : idleBorder,
    background: locale === code ? activeBg : 'transparent',
    color: text,
    fontSize: '0.72rem',
    fontWeight: 700,
    cursor: 'pointer',
    lineHeight: 1,
  } as React.CSSProperties);

  return (
    <div
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        ...style,
      }}
      title={t('modalLocaleToggle.aria')}
    >
      <Globe
        size={16}
        aria-hidden
        color={dark ? 'rgba(255,255,255,0.9)' : '#11074A'}
        strokeWidth={2}
      />
      <button
        type="button"
        onClick={() => setLocale('en')}
        style={btn('en')}
        aria-pressed={locale === 'en'}
        aria-label={t('settings.languageEnglish')}
      >
        {t('modalLocaleToggle.en')}
      </button>
      <button
        type="button"
        onClick={() => setLocale('ja')}
        style={btn('ja')}
        aria-pressed={locale === 'ja'}
        aria-label={t('settings.languageJapanese')}
      >
        {t('modalLocaleToggle.ja')}
      </button>
      <button
        type="button"
        onClick={() => setLocale('zh')}
        style={btn('zh')}
        aria-pressed={locale === 'zh'}
        aria-label={t('settings.languageChinese')}
      >
        {t('modalLocaleToggle.zh')}
      </button>
    </div>
  );
}
