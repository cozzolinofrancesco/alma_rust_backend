'use client';

import React from 'react';
import { Hammer } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';
import { FRANCESCO_EMAIL } from '../lib/almaTeamContacts';

interface AlmaStudioWipModalProps {
  isOpen: boolean;
  onAccept: () => void; // the only way to dismiss — acceptance is required
}

export default function AlmaStudioWipModal({ isOpen, onAccept }: AlmaStudioWipModalProps) {
  const { t } = useLanguage();

  if (!isOpen) return null;

  const titleId = 'alma-studio-wip-title';
  const feedbackHref = `mailto:${FRANCESCO_EMAIL}?subject=${encodeURIComponent(
    t('almaStudioWip.mailtoSubject'),
  )}`;

  return (
    <div style={styles.overlay}>
      <div
        style={styles.modal}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div style={styles.iconWrap}>
          <Hammer size={26} color="#11074A" />
        </div>

        <div style={styles.header}>
          <span style={styles.badge}>{t('almaStudioWip.badge')}</span>
          <h2 id={titleId} style={styles.title}>{t('almaStudioWip.title')}</h2>
        </div>

        <p style={styles.body}>{t('almaStudioWip.body')}</p>

        <p style={styles.feedback}>
          {t('almaStudioWip.feedbackPrompt')}{' '}
          <a href={feedbackHref} style={styles.feedbackLink}>
            {t('almaStudioWip.feedbackLink')}
          </a>
        </p>

        <button style={styles.acceptButton} onClick={onAccept} autoFocus>
          {t('almaStudioWip.accept')}
        </button>
      </div>
    </div>
  );
}

const styles: { [key: string]: React.CSSProperties } = {
  overlay: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(17, 7, 74, 0.55)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    padding: '1.5rem',
    zIndex: 10000,
  },
  modal: {
    position: 'relative',
    backgroundColor: '#ffffff',
    borderRadius: '20px',
    padding: '2rem',
    width: '100%',
    maxWidth: '460px',
    boxShadow: '0 25px 50px rgba(17, 7, 74, 0.4)',
    textAlign: 'center',
  },
  iconWrap: {
    width: '56px',
    height: '56px',
    borderRadius: '16px',
    backgroundColor: '#EEF0FB',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto 1rem',
  },
  header: {
    marginBottom: '0.9rem',
  },
  badge: {
    display: 'inline-block',
    fontSize: '0.7rem',
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: '#6D28D9',
    backgroundColor: '#F3EEFF',
    padding: '0.25rem 0.6rem',
    borderRadius: '999px',
    marginBottom: '0.6rem',
  },
  title: {
    fontSize: '1.5rem',
    fontWeight: 700,
    color: '#11074A',
    margin: 0,
  },
  body: {
    fontSize: '0.98rem',
    color: '#4A4453',
    lineHeight: 1.6,
    margin: '0 auto 1rem',
    maxWidth: '380px',
  },
  feedback: {
    fontSize: '0.95rem',
    color: '#4A4453',
    lineHeight: 1.6,
    margin: '0 auto 1.5rem',
    maxWidth: '380px',
  },
  feedbackLink: {
    color: '#6D28D9',
    fontWeight: 600,
    textDecoration: 'underline',
  },
  acceptButton: {
    width: '100%',
    backgroundColor: '#11074A',
    color: '#ffffff',
    border: 'none',
    padding: '0.75rem 1.5rem',
    borderRadius: '12px',
    fontSize: '1rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
};
