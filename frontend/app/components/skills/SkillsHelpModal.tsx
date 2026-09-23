'use client';

import { useEffect } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import './skills.css';

interface SkillsHelpModalProps {
  open: boolean;
  onClose: () => void;
}

// A visual, read-only explainer for the Skills feature: what a skill is, how it
// layers on top of every step, how to add one, worked examples, and an FAQ.
// Mirrors SkillModal's inline-backdrop + Escape-to-close pattern (no portal).
export default function SkillsHelpModal({ open, onClose }: SkillsHelpModalProps) {
  const { t } = useLanguage();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const stepWord = t('skills.help.stepLabel');
  const howSteps = [1, 2, 3].map((n) => ({
    n,
    title: t(`skills.help.how${n}Title`),
    body: t(`skills.help.how${n}Body`),
  }));
  const examples = [
    { icon: '🗣️', name: t('skills.help.ex1Name'), body: t('skills.help.ex1Body') },
    { icon: '📎', name: t('skills.help.ex2Name'), body: t('skills.help.ex2Body') },
    { icon: '{ }', name: t('skills.help.ex3Name'), body: t('skills.help.ex3Body') },
  ];
  const faqs = [1, 2, 3, 4, 5].map((n) => ({
    q: t(`skills.help.faq${n}Q`),
    a: t(`skills.help.faq${n}A`),
  }));

  return (
    <div
      className="skill-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="skills-help-title"
      onClick={onClose}
    >
      <div className="skill-modal skills-help" onClick={(e) => e.stopPropagation()}>
        <div className="skill-modal__header">
          <span className="skills-help__badge" aria-hidden="true">✨</span>
          <span className="skill-modal__title" id="skills-help-title">
            {t('skills.help.title')}
          </span>
          <span className="skill-modal__spacer" />
          <button type="button" className="skill-modal__close" onClick={onClose} aria-label={t('skills.close')}>
            ✕
          </button>
        </div>

        <div className="skill-modal__body skills-help__body">
          {/* Intro */}
          <p className="skills-help__lead">{t('skills.help.lead')}</p>

          {/* Diagram: a skill layers on top of every step */}
          <section className="skills-help__section">
            <h3 className="skills-help__h">{t('skills.help.appliesTitle')}</h3>
            <p className="skills-help__p">{t('skills.help.appliesBody')}</p>

            <div className="skills-help__diagram" role="img" aria-label={t('skills.help.appliesBody')}>
              <svg viewBox="0 0 480 220" width="100%" preserveAspectRatio="xMidYMid meet">
                <defs>
                  <marker id="skills-help-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                    <path d="M0,0 L6,3 L0,6 Z" fill="#8b83c9" />
                  </marker>
                </defs>

                {/* connectors from the skill down to each step */}
                {[100, 240, 380].map((cx) => (
                  <line
                    key={cx}
                    x1="240"
                    y1="58"
                    x2={cx}
                    y2="146"
                    stroke="#8b83c9"
                    strokeWidth="1.6"
                    strokeDasharray="4 4"
                    markerEnd="url(#skills-help-arrow)"
                  />
                ))}

                {/* the skill node */}
                <rect x="160" y="12" width="160" height="46" rx="23" fill="#11074a" />
                <text x="240" y="32" textAnchor="middle" fill="#ffffff" fontSize="14" fontWeight="700">
                  ✨ {t('skills.barLabel')}
                </text>
                <text x="240" y="48" textAnchor="middle" fill="#cfc9f2" fontSize="10">
                  {t('skills.help.diagramInstruction')}
                </text>

                {/* the steps */}
                {[100, 240, 380].map((cx, i) => (
                  <g key={cx}>
                    <rect x={cx - 58} y="150" width="116" height="52" rx="10" fill="#f3f1fb" stroke="#c9c3ec" />
                    <text x={cx} y="172" textAnchor="middle" fill="#1a2b5b" fontSize="12" fontWeight="600">
                      {stepWord} {i + 1}
                    </text>
                    <text x={cx} y="190" textAnchor="middle" fill="#8388a0" fontSize="10">
                      {t('skills.help.diagramApplied')}
                    </text>
                  </g>
                ))}
              </svg>
            </div>
          </section>

          {/* How to add a skill — 3 step flow */}
          <section className="skills-help__section">
            <h3 className="skills-help__h">{t('skills.help.howTitle')}</h3>
            <div className="skills-help__flow">
              {howSteps.map((s, i) => (
                <div className="skills-help__flow-item" key={s.n}>
                  <div className="skills-help__flow-card">
                    <span className="skills-help__flow-num">{s.n}</span>
                    <div className="skills-help__flow-text">
                      <span className="skills-help__flow-title">{s.title}</span>
                      <span className="skills-help__flow-body">{s.body}</span>
                    </div>
                  </div>
                  {i < howSteps.length - 1 && (
                    <span className="skills-help__flow-arrow" aria-hidden="true">→</span>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* Examples */}
          <section className="skills-help__section">
            <h3 className="skills-help__h">{t('skills.help.examplesTitle')}</h3>
            <div className="skills-help__examples">
              {examples.map((ex) => (
                <div className="skills-help__example" key={ex.name}>
                  <span className="skills-help__example-icon" aria-hidden="true">{ex.icon}</span>
                  <span className="skills-help__example-name">{ex.name}</span>
                  <span className="skills-help__example-body">“{ex.body}”</span>
                </div>
              ))}
            </div>
          </section>

          {/* FAQ */}
          <section className="skills-help__section">
            <h3 className="skills-help__h">{t('skills.help.faqTitle')}</h3>
            <div className="skills-help__faq">
              {faqs.map((f, i) => (
                <details className="skills-help__faq-item" key={i}>
                  <summary className="skills-help__faq-q">{f.q}</summary>
                  <p className="skills-help__faq-a">{f.a}</p>
                </details>
              ))}
            </div>
          </section>
        </div>

        <div className="skill-modal__footer">
          <span className="skill-modal__footer-spacer" />
          <button type="button" className="skill-btn skill-btn--primary" onClick={onClose}>
            {t('skills.help.gotIt')}
          </button>
        </div>
      </div>
    </div>
  );
}
