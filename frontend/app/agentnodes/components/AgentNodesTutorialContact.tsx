'use client';

import { useCallback, useState } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import {
  ALMA_GOOGLE_CHAT_SPACE,
  FRANCESCO_EMAIL,
  FRANCESCO_PHOTO,
  googleChatDmUrl,
  mailtoUrl,
  ROBERTO_EMAIL,
  ROBERTO_PHOTO,
} from '../../lib/almaTeamContacts';

function ContactAvatar({
  src,
  initials,
  alt,
}: {
  src: string;
  initials: string;
  alt: string;
}) {
  const [failed, setFailed] = useState(false);
  const onError = useCallback(() => setFailed(true), []);

  if (failed) {
    return (
      <div
        className="spotlight-tour__contact-avatar spotlight-tour__contact-avatar--fallback"
        aria-label={alt}
      >
        {initials}
      </div>
    );
  }
  return (
    <img
      className="spotlight-tour__contact-avatar"
      src={src}
      alt={alt}
      width={72}
      height={72}
      onError={onError}
    />
  );
}

function ContactCard({
  photoSrc,
  photoInitials,
  name,
  role,
  bio,
  email,
  hireNote,
}: {
  photoSrc: string;
  photoInitials: string;
  name: string;
  role: string;
  bio: string;
  email: string;
  hireNote?: string;
}) {
  const { t } = useLanguage();
  const chatHref = googleChatDmUrl(email);
  const mailHref = mailtoUrl(email);

  return (
    <div className="spotlight-tour__contact-card">
      <ContactAvatar src={photoSrc} initials={photoInitials} alt={name} />
      <div className="spotlight-tour__contact-body">
        <h3 className="spotlight-tour__contact-name">{name}</h3>
        <p className="spotlight-tour__contact-role">{role}</p>
        <p className="spotlight-tour__contact-bio">{bio}</p>
        {hireNote ? <p className="spotlight-tour__contact-hire-note">{hireNote}</p> : null}
        <div className="spotlight-tour__contact-actions">
          <a
            className="spotlight-tour__contact-btn spotlight-tour__contact-btn--primary"
            href={chatHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('agentnodesPage.tutorial.contactChatAria', { name })}
          >
            {t('agentnodesPage.tutorial.contactChatCta')}
          </a>
          <a
            className="spotlight-tour__contact-btn spotlight-tour__contact-btn--secondary"
            href={mailHref}
            aria-label={t('agentnodesPage.tutorial.contactEmailAria', { name })}
          >
            {t('agentnodesPage.tutorial.contactEmailCta')}
          </a>
        </div>
      </div>
    </div>
  );
}

export default function AgentNodesTutorialContact() {
  const { t, locale } = useLanguage();

  return (
    <div className="spotlight-tour__contact-root">
      <div className="tutorial-step">
        <div className="tutorial-step-header">
          <h2 className="tutorial-step-title">{t('agentnodesPage.tutorial.step7Title')}</h2>
          <p className="tutorial-step-subtitle">{t('agentnodesPage.tutorial.step7Subtitle')}</p>
        </div>
        <div className="tutorial-step-content spotlight-tour__contact-intro-wrap">
          <p className="tutorial-paragraph spotlight-tour__contact-intro">{t('agentnodesPage.tutorial.contactIntro')}</p>
          <p className="tutorial-paragraph spotlight-tour__contact-space-line">
            <a
              href={ALMA_GOOGLE_CHAT_SPACE}
              target="_blank"
              rel="noopener noreferrer"
              className="spotlight-tour__contact-inline-link"
              aria-label={t('agentnodesPage.tutorial.contactSpaceAria')}
            >
              {t('agentnodesPage.tutorial.contactSpaceCta')}
            </a>
          </p>
        </div>
      </div>

      <div className="spotlight-tour__contact-cards">
        <ContactCard
          photoSrc={FRANCESCO_PHOTO}
          photoInitials="FC"
          name={t('jaWelcomeModal.francescoName')}
          role={t('jaWelcomeModal.francescoRole')}
          bio={t('jaWelcomeModal.francescoBio')}
          email={FRANCESCO_EMAIL}
          hireNote={locale === 'ja' ? t('jaWelcomeModal.francescoHireMe') : undefined}
        />
        <ContactCard
          photoSrc={ROBERTO_PHOTO}
          photoInitials="RA"
          name={t('jaWelcomeModal.robertoName')}
          role={t('jaWelcomeModal.robertoRole')}
          bio={t('jaWelcomeModal.robertoMessage')}
          email={ROBERTO_EMAIL}
        />
      </div>
    </div>
  );
}
