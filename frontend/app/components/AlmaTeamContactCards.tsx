'use client';

import React, { useState } from 'react';
import {
  FRANCESCO_EMAIL,
  FRANCESCO_PHOTO,
  ROBERTO_EMAIL,
  ROBERTO_PHOTO,
} from '../lib/almaTeamContacts';
import { useLanguage } from '../contexts/LanguageContext';
import './questions-modal.css';

function buildMailto(email: string, subject: string): string {
  const q = encodeURIComponent(subject);
  return `mailto:${email}?subject=${q}`;
}

export interface AlmaTeamContactCardsProps {
  className?: string;
  isHomepage?: boolean;
}

export default function AlmaTeamContactCards({ className, isHomepage = false }: AlmaTeamContactCardsProps) {
  const { t, locale } = useLanguage();
  const [francescoImgError, setFrancescoImgError] = useState(false);
  const [robertoImgError, setRobertoImgError] = useState(false);
  const mailtoSubject = t('questionsModal.mailtoSubject');

  const francescoNote =
    locale === 'ja'
      ? t('questionsModal.francescoHireMe')
      : isHomepage && locale === 'en'
        ? t('home.francescoThankYou')
        : null;

  const grid = (
    <div className="questions-modal-grid">
      <article className="questions-modal-card">
        {!francescoImgError ? (
          <img
            src={FRANCESCO_PHOTO}
            alt={t('questionsModal.francescoName')}
            className="questions-modal-avatar"
            onError={() => setFrancescoImgError(true)}
          />
        ) : (
          <div className="questions-modal-avatar-fallback" aria-hidden>
            FC
          </div>
        )}
        <div className="questions-modal-card-body">
          <h3 className="questions-modal-name">{t('questionsModal.francescoName')}</h3>
          <p className="questions-modal-role">{t('questionsModal.francescoRole')}</p>
          <p className="questions-modal-bio">{t('questionsModal.francescoBio')}</p>
          {francescoNote ? (
            <p
              className={
                isHomepage && locale === 'en'
                  ? 'questions-modal-hire-note questions-modal-hire-note--thank-you'
                  : 'questions-modal-hire-note'
              }
            >
              {francescoNote}
            </p>
          ) : null}
          <a href={buildMailto(FRANCESCO_EMAIL, mailtoSubject)} className="questions-modal-ask">
            {t('questionsModal.ask')}
          </a>
        </div>
      </article>

      <article className="questions-modal-card">
        {!robertoImgError ? (
          <img
            src={ROBERTO_PHOTO}
            alt={t('questionsModal.robertoName')}
            className="questions-modal-avatar"
            onError={() => setRobertoImgError(true)}
          />
        ) : (
          <div className="questions-modal-avatar-fallback" aria-hidden>
            RA
          </div>
        )}
        <div className="questions-modal-card-body">
          <h3 className="questions-modal-name">{t('questionsModal.robertoName')}</h3>
          <p className="questions-modal-role">{t('questionsModal.robertoRole')}</p>
          <p className="questions-modal-bio">{t('questionsModal.robertoMessage')}</p>
          <a href={buildMailto(ROBERTO_EMAIL, mailtoSubject)} className="questions-modal-ask">
            {t('questionsModal.ask')}
          </a>
        </div>
      </article>
    </div>
  );

  if (className) {
    return <div className={className}>{grid}</div>;
  }
  return grid;
}
