'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  FRANCESCO_EMAIL,
  FRANCESCO_LINKEDIN,
  FRANCESCO_PHOTO,
  mailtoUrl,
  ROBERTO_EMAIL,
  ROBERTO_PHOTO,
} from '../lib/almaTeamContacts';
import { useLanguage } from '../contexts/LanguageContext';

const jaWelcomeContactWrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  marginTop: 10,
};

const jaWelcomeBtnPrimary: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '8px 12px',
  borderRadius: 8,
  fontSize: '0.85rem',
  fontWeight: 600,
  textDecoration: 'none',
  background: 'linear-gradient(135deg, #11074a 0%, #1a0d5c 100%)',
  color: '#fff',
};

const jaWelcomeBtnSecondary: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '8px 12px',
  borderRadius: 8,
  fontSize: '0.85rem',
  fontWeight: 600,
  textDecoration: 'none',
  border: '1px solid #cbd5e1',
  color: '#334155',
  background: '#fff',
};

function JaWelcomeContactActions({
  email,
  emailLabel,
  emailAria,
  profileHref,
  profileLabel,
  profileAria,
}: {
  email: string;
  emailLabel: string;
  emailAria: string;
  profileHref?: string;
  profileLabel?: string;
  profileAria?: string;
}) {
  return (
    <div style={jaWelcomeContactWrap}>
      <a href={mailtoUrl(email)} style={jaWelcomeBtnPrimary} aria-label={emailAria}>
        {emailLabel}
      </a>
      {profileHref && profileLabel && profileAria ? (
        <a
          href={profileHref}
          target="_blank"
          rel="noopener noreferrer"
          style={jaWelcomeBtnSecondary}
          aria-label={profileAria}
        >
          {profileLabel}
        </a>
      ) : null}
    </div>
  );
}

function TeamAvatar({
  src,
  alt,
  initials,
}: {
  src: string;
  alt: string;
  initials: string;
}) {
  const [failed, setFailed] = useState(false);
  const onError = useCallback(() => setFailed(true), []);

  if (failed) {
    return (
      <div
        className="ja-welcome-avatar ja-welcome-avatar--fallback"
        aria-label={alt}
        style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: '#e2e8f0',
          color: '#475569',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 700,
          fontSize: '0.85rem',
          flexShrink: 0,
        }}
      >
        {initials}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      width={56}
      height={56}
      className="ja-welcome-avatar"
      style={{
        width: 56,
        height: 56,
        borderRadius: '50%',
        objectFit: 'cover',
        flexShrink: 0,
        border: '2px solid #e2e8f0',
      }}
      onError={onError}
    />
  );
}

export default function JaLocaleWelcomeModal() {
  const { locale, t, localeHydrated } = useLanguage();
  const [open, setOpen] = useState(false);
  const prevLocaleRef = useRef<typeof locale | null>(null);

  const francescoNote =
    locale === 'ja' ? t('jaWelcomeModal.francescoHireMe') : t('home.francescoThankYou');

  useEffect(() => {
    if (!localeHydrated) return;
    const prev = prevLocaleRef.current;
    if (prev === null) {
      prevLocaleRef.current = locale;
      return;
    }
    if ((prev === 'en' && locale === 'ja') || (prev === 'ja' && locale === 'en')) {
      setOpen(true);
    }
    prevLocaleRef.current = locale;
  }, [locale, localeHydrated]);

  useEffect(() => {
    if (!open) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!open || typeof document === 'undefined') {
    return null;
  }

  const personRow: CSSProperties = {
    display: 'flex',
    gap: 14,
    alignItems: 'flex-start',
    marginBottom: 18,
  };

  const overlay = (
    <div
      className="ja-welcome-overlay"
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100000,
        background: 'rgba(15, 23, 42, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ja-welcome-title"
        className="ja-welcome-dialog"
        style={{
          maxWidth: 480,
          width: '100%',
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)',
          padding: '24px 28px',
          color: '#0f172a',
          fontFamily: 'system-ui, sans-serif',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="ja-welcome-title" style={{ margin: '0 0 12px', fontSize: '1.25rem', lineHeight: 1.35 }}>
          {t('jaWelcomeModal.title')}
        </h2>
        <p style={{ margin: '0 0 20px', fontSize: '0.95rem', lineHeight: 1.55, color: '#334155' }}>
          {t('jaWelcomeModal.intro')}
        </p>

        <section style={{ ...personRow, marginBottom: 22 }}>
          <TeamAvatar
            src={ROBERTO_PHOTO}
            alt={t('jaWelcomeModal.robertoName')}
            initials="RA"
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>{t('jaWelcomeModal.robertoName')}</div>
            <div style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: 6 }}>
              {t('jaWelcomeModal.robertoRole')}
            </div>
            <p style={{ margin: 0, fontSize: '0.9rem', lineHeight: 1.5, color: '#334155' }}>
              {t('jaWelcomeModal.robertoMessage')}
            </p>
            <JaWelcomeContactActions
              email={ROBERTO_EMAIL}
              emailLabel={t('jaWelcomeModal.robertoEmailCta')}
              emailAria={t('jaWelcomeModal.robertoEmailAria')}
            />
          </div>
        </section>

        <section style={{ ...personRow, marginBottom: 22 }}>
          <TeamAvatar
            src={FRANCESCO_PHOTO}
            alt={t('jaWelcomeModal.francescoName')}
            initials="FC"
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>{t('jaWelcomeModal.francescoName')}</div>
            <div style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: 6 }}>
              {t('jaWelcomeModal.francescoRole')}
            </div>
            <p style={{ margin: 0, fontSize: '0.9rem', lineHeight: 1.5, color: '#334155' }}>
              {t('jaWelcomeModal.francescoBio')}
            </p>
            {francescoNote ? (
              <p
                style={{
                  margin: '8px 0 0',
                  fontSize: locale === 'en' ? '0.9rem' : '0.88rem',
                  lineHeight: 1.45,
                  fontWeight: locale === 'en' ? 700 : 600,
                  color: '#11074a',
                  maxWidth: '22em',
                }}
              >
                {francescoNote}
              </p>
            ) : null}
            <JaWelcomeContactActions
              email={FRANCESCO_EMAIL}
              emailLabel={t('jaWelcomeModal.francescoEmailCta')}
              emailAria={t('jaWelcomeModal.francescoEmailAria')}
              profileHref={locale === 'ja' ? FRANCESCO_LINKEDIN : undefined}
              profileLabel={locale === 'ja' ? t('jaWelcomeModal.francescoProfileCta') : undefined}
              profileAria={locale === 'ja' ? t('jaWelcomeModal.francescoProfileAria') : undefined}
            />
          </div>
        </section>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="c272-btn"
            style={{ padding: '10px 16px', borderRadius: 8, fontWeight: 600, fontSize: '0.9rem' }}
            onClick={() => setOpen(false)}
          >
            {t('jaWelcomeModal.close')}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
