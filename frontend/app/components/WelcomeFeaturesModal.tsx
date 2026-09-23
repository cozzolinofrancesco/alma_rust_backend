'use client';

import React, { useCallback, useEffect, useState, type ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, X, FileText, Bot, ShieldCheck } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';
import { PlatformPillars, PlatformLoop } from './help/SectionDiagrams';

interface WelcomeFeaturesModalProps {
  isOpen: boolean;
  onClose: () => void;     // session-dismiss (X / Esc / overlay / "Skip for now") — reappears next login
  onComplete: () => void;  // finished ("Got it") — persists the durable Drive flag
}

interface Feature {
  key: string;
  route?: string;
  image?: string;
  visual?: ReactNode;
}

// Intro slides (what ALMA is / how it fits / use cases) precede the per-feature
// slides. Intro slides use a hand-built diagram instead of a screenshot.
const USE_CASE_VISUAL: ReactNode = (
  <div className="flex flex-col gap-2.5 text-sm font-medium text-gray-700">
    <span className="inline-flex items-center gap-2"><FileText className="w-4 h-4 shrink-0 text-indigo-600" /> Validate a document&rsquo;s claims against your knowledge base</span>
    <span className="inline-flex items-center gap-2"><Bot className="w-4 h-4 shrink-0 text-indigo-600" /> Build an AI agent that drafts a report from your data</span>
    <span className="inline-flex items-center gap-2"><ShieldCheck className="w-4 h-4 shrink-0 text-indigo-600" /> Produce a CTD&nbsp;2.7.2 summary with a tamper-evident audit trail</span>
  </div>
);

const FEATURES: Feature[] = [
  { key: 'overview', visual: <PlatformPillars /> },
  { key: 'howItFits', visual: <PlatformLoop /> },
  { key: 'useCases', visual: USE_CASE_VISUAL },
  { key: 'projects', route: '/projects', image: '/images/carousel/projects.png' },
  { key: 'addData', route: '/upload', image: '/images/carousel/addData.png' },
  { key: 'agentBuilder', route: '/ai-agents', image: '/images/carousel/agentBuilder.png' },
  { key: 'ctd272', route: '/SCT272', image: '/images/carousel/ctd272.png' },
  { key: 'claimsValidation', route: '/claim-validation', image: '/images/carousel/claimsValidation.png' },
  { key: 'ragKnowledge', route: '/rag-corpus', image: '/images/carousel/ragKnowledge.png' },
  { key: 'paperSearch', route: '/searchpaper', image: '/images/carousel/paperSearch.png' },
];

export default function WelcomeFeaturesModal({ isOpen, onClose, onComplete }: WelcomeFeaturesModalProps) {
  const { t } = useLanguage();
  const [index, setIndex] = useState(0);

  const total = FEATURES.length;
  const goPrev = useCallback(() => setIndex((i) => (i - 1 + total) % total), [total]);
  const goNext = useCallback(() => setIndex((i) => (i + 1) % total), [total]);

  useEffect(() => {
    if (isOpen) setIndex(0);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') goPrev();
      else if (e.key === 'ArrowRight') goNext();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = 'unset';
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, onClose, goPrev, goNext]);

  if (!isOpen) return null;

  const feature = FEATURES[index];
  const titleId = 'welcome-features-title';

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div
        style={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <button style={styles.closeButton} onClick={onClose} aria-label={t('welcomeFeatures.gotIt')}>
          <X size={22} />
        </button>

        <div style={styles.header}>
          <h2 id={titleId} style={styles.title}>{t('welcomeFeatures.title')}</h2>
          <p style={styles.subtitle}>{t('welcomeFeatures.subtitle')}</p>
        </div>

        <div style={styles.carousel}>
          <button style={styles.arrow} onClick={goPrev} aria-label={t('welcomeFeatures.prev')}>
            <ChevronLeft size={24} />
          </button>

          <div style={styles.stage}>
            {feature.image ? (
              <div style={styles.imageWrap}>
                <Image
                  key={feature.key}
                  src={feature.image}
                  alt={t(`welcomeFeatures.items.${feature.key}.title`)}
                  fill
                  priority={index === 0}
                  sizes="(max-width: 768px) 90vw, 680px"
                  style={{ objectFit: 'cover' }}
                />
              </div>
            ) : (
              <div style={styles.visualWrap}>{feature.visual}</div>
            )}
          </div>

          <button style={styles.arrow} onClick={goNext} aria-label={t('welcomeFeatures.next')}>
            <ChevronRight size={24} />
          </button>
        </div>

        <div style={styles.dots}>
          {FEATURES.map((f, i) => (
            <button
              key={f.key}
              onClick={() => setIndex(i)}
              aria-label={t(`welcomeFeatures.items.${f.key}.title`)}
              aria-current={i === index}
              style={{ ...styles.dot, ...(i === index ? styles.dotActive : {}) }}
            />
          ))}
        </div>

        <div style={styles.content}>
          <span style={styles.counter}>
            {t('welcomeFeatures.counter', { current: index + 1, total })}
          </span>
          <h3 style={styles.featureTitle}>{t(`welcomeFeatures.items.${feature.key}.title`)}</h3>
          <p style={styles.featureDescription}>{t(`welcomeFeatures.items.${feature.key}.description`)}</p>
          {feature.route && (
            <Link href={feature.route} style={styles.exploreButton} onClick={onClose}>
              {t('welcomeFeatures.explore')} →
            </Link>
          )}
        </div>

        <div style={styles.footer}>
          <button style={styles.dismissButton} onClick={onClose}>
            {t('welcomeFeatures.skipForNow')}
          </button>
          <button style={styles.gotItButton} onClick={onComplete}>
            {t('welcomeFeatures.gotIt')}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: { [key: string]: React.CSSProperties } = {
  overlay: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'var(--alma-overlay)',
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
    backgroundColor: 'var(--alma-surface)',
    borderRadius: '20px',
    padding: '1.75rem',
    width: '100%',
    maxWidth: '760px',
    maxHeight: '92vh',
    overflowY: 'auto',
    boxShadow: '0 25px 50px rgba(17, 7, 74, 0.4)',
  },
  closeButton: {
    position: 'absolute',
    top: '1rem',
    right: '1rem',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--alma-text-muted)',
    padding: '0.25rem',
    lineHeight: 0,
    zIndex: 1,
  },
  header: {
    textAlign: 'center',
    marginBottom: '1.25rem',
    paddingRight: '1.5rem',
    paddingLeft: '1.5rem',
  },
  title: {
    fontSize: '1.6rem',
    fontWeight: 700,
    color: 'var(--alma-accent)',
    margin: 0,
  },
  subtitle: {
    fontSize: '0.95rem',
    color: 'var(--alma-text-muted)',
    margin: '0.4rem 0 0',
  },
  carousel: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
  },
  arrow: {
    flex: '0 0 auto',
    width: '40px',
    height: '40px',
    borderRadius: '50%',
    border: '1px solid var(--alma-border)',
    backgroundColor: 'var(--alma-surface)',
    color: 'var(--alma-accent)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    boxShadow: '0 4px 12px rgba(17, 7, 74, 0.12)',
    transition: 'transform 0.15s ease',
  },
  stage: {
    flex: '1 1 auto',
    minWidth: 0,
  },
  imageWrap: {
    position: 'relative',
    width: '100%',
    aspectRatio: '16 / 9',
    borderRadius: '14px',
    overflow: 'hidden',
    backgroundColor: 'var(--alma-accent)',
    boxShadow: '0 8px 24px rgba(17, 7, 74, 0.18)',
  },
  visualWrap: {
    position: 'relative',
    width: '100%',
    aspectRatio: '16 / 9',
    borderRadius: '14px',
    overflow: 'auto',
    backgroundColor: 'var(--alma-surface)',
    border: '1px solid var(--alma-border)',
    boxShadow: '0 8px 24px rgba(17, 7, 74, 0.10)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '1rem',
  },
  dots: {
    display: 'flex',
    justifyContent: 'center',
    gap: '0.5rem',
    margin: '1rem 0 0.5rem',
  },
  dot: {
    width: '9px',
    height: '9px',
    borderRadius: '50%',
    border: 'none',
    padding: 0,
    backgroundColor: 'var(--alma-border)',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
  },
  dotActive: {
    backgroundColor: 'var(--alma-accent)',
    transform: 'scale(1.25)',
  },
  content: {
    textAlign: 'center',
    padding: '0.5rem 1rem 0',
  },
  counter: {
    fontSize: '0.75rem',
    fontWeight: 600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: 'var(--alma-text-muted)',
  },
  featureTitle: {
    fontSize: '1.35rem',
    fontWeight: 700,
    color: 'var(--alma-accent)',
    margin: '0.35rem 0 0.5rem',
  },
  featureDescription: {
    fontSize: '0.98rem',
    color: 'var(--alma-text)',
    lineHeight: 1.6,
    margin: '0 auto 1rem',
    maxWidth: '560px',
  },
  exploreButton: {
    display: 'inline-block',
    backgroundColor: 'var(--alma-accent)',
    color: 'var(--alma-on-accent)',
    textDecoration: 'none',
    padding: '0.6rem 1.5rem',
    borderRadius: '10px',
    fontSize: '0.95rem',
    fontWeight: 600,
  },
  footer: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: '1.5rem',
    paddingTop: '1rem',
    borderTop: '1px solid var(--alma-border)',
  },
  dismissButton: {
    background: 'none',
    border: 'none',
    color: 'var(--alma-text-muted)',
    fontSize: '0.9rem',
    cursor: 'pointer',
    padding: '0.4rem',
  },
  gotItButton: {
    backgroundColor: 'var(--alma-surface)',
    color: 'var(--alma-accent)',
    border: '2px solid var(--alma-accent)',
    padding: '0.55rem 1.4rem',
    borderRadius: '10px',
    fontSize: '0.95rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
};
