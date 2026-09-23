'use client';

import Script from 'next/script';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import AlmaTeamContactCards from "./components/AlmaTeamContactCards";
import ThisWeekUpdatesPatch from "./components/ThisWeekUpdatesPatch";
import DisclaimerPopup from "./components/DisclaimerModal";
import GettingStartedModal from "./components/GettingStartedModal";
import WelcomeFeaturesModal from "./components/WelcomeFeaturesModal";
import PageReadyProvider from "./components/PageReadyProvider";
import { TutorialSystem } from "./components/tutorial/TutorialSystem";
import { isDisclaimerAccepted, setDisclaimerAccepted, recordDisclaimerAcceptance } from "./lib/disclaimerUtils";
import { FRANCESCO_EMAIL, FRANCESCO_PHOTO } from "./lib/almaTeamContacts";
import { useLanguage } from "./contexts/LanguageContext";
import { useSession } from "next-auth/react";
import {
  wasWelcomeSeenThisSession,
  markWelcomeSeenThisSession,
} from "./lib/welcomeUtils";
import {
  CURRENT_ONBOARDING_VERSION,
  isOnboardingVersionDoneCached,
  setOnboardingVersionDoneCached,
  fetchOnboardingStatus,
  markOnboardingCompleted,
} from "./lib/onboardingStatus";

interface VantaEffect {
  destroy: () => void;
  resize: () => void;
}

declare global {
  interface Window {
    THREE?: unknown;
    VANTA?: {
      CLOUDS: (options: unknown) => VantaEffect;
      NET: (options: unknown) => VantaEffect;
      HALO: (options: unknown) => VantaEffect;
      CELLS: (options: unknown) => VantaEffect;
      RINGS: (options: unknown) => VantaEffect;
    };
  }
}

interface NewsPost {
  id: number;
  title: string;
  excerpt: string;
  content: string;
  date: string;
  author: string;
  category: string;
}

export default function Home() {
  const { t } = useLanguage();
  const { data: session, status } = useSession();
  const supportMailHref = `mailto:${FRANCESCO_EMAIL}?subject=${encodeURIComponent(t('questionsModal.mailtoSubject'))}`;
  const copyrightYear = new Date().getFullYear();

  const [selectedPost, setSelectedPost] = useState<NewsPost | null>(null);
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  const [showGettingStarted, setShowGettingStarted] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [showDevBlogModal, setShowDevBlogModal] = useState(false);
  const [devBlogImageError, setDevBlogImageError] = useState(false);
  const vantaRef = useRef<HTMLDivElement>(null);
  const [vantaEffect, setVantaEffect] = useState<VantaEffect | null>(null);
  const [threeLoaded, setThreeLoaded] = useState(false);
  const [vantaLoaded, setVantaLoaded] = useState(false);
  const [primaryHovered, setPrimaryHovered] = useState(false);
  const [secondaryHovered, setSecondaryHovered] = useState(false);
  const [devBlogHovered, setDevBlogHovered] = useState(false);

  console.log('🔄 Component render:', { threeLoaded, vantaLoaded, hasRef: !!vantaRef.current, hasEffect: !!vantaEffect });

  useEffect(() => {
    if (!isDisclaimerAccepted()) {
      setShowDisclaimer(true);
    }
  }, []);

  // First-login onboarding (optional welcome features)
  const maybeShowOnboarding = useCallback(async () => {
    if (status !== 'authenticated') return;
    const userId = session?.user?.email ?? '';
    if (!userId) return;
    if (!isDisclaimerAccepted()) return;
    if (wasWelcomeSeenThisSession()) return;
    if (isOnboardingVersionDoneCached(userId, CURRENT_ONBOARDING_VERSION)) return;
    const data = await fetchOnboardingStatus();
    if (data?.completed) {
      setOnboardingVersionDoneCached(userId, CURRENT_ONBOARDING_VERSION);
      return;
    }
    if (data && !data.completed) {
      markWelcomeSeenThisSession();
      setShowWelcome(true);
    }
  }, [status, session?.user?.email]);

  useEffect(() => {
    void maybeShowOnboarding();
  }, [maybeShowOnboarding]);

  useEffect(() => {
    if (showDevBlogModal) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = 'unset';
      };
    }
  }, [showDevBlogModal]);

  useEffect(() => {
    console.log('🎯 Vanta useEffect triggered:', { threeLoaded, vantaLoaded, hasRef: !!vantaRef.current, hasEffect: !!vantaEffect });

    if (threeLoaded && vantaLoaded && vantaRef.current && !vantaEffect) {
      console.log('🚀 All conditions met, attempting to initialize Vanta...');

      const VANTA = window.VANTA;
      const THREE = window.THREE;

      console.log('🔍 Global objects check:', {
        VANTA: !!VANTA,
        THREE: !!THREE,
        VANTA_CELLS: !!(VANTA && VANTA.CELLS),
        vantaKeys: VANTA ? Object.keys(VANTA) : 'VANTA is undefined'
      });

      if (VANTA && typeof VANTA.CELLS === 'function') {
        console.log('✅ VANTA.CELLS is available, creating effect...');

        const effect = VANTA.CELLS({
          el: vantaRef.current,
          mouseControls: true,
          touchControls: true,
          gyroControls: false,
          minHeight: 200.00,
          minWidth: 200.00,
          scale: 1.00,
          color1: 0x8a7fff,
          color2: 0xb3a3ff,
          size: 1.50,
          speed: 2.50
        });

        console.log('🎉 Vanta effect created:', effect);
        setVantaEffect(effect);
      } else {
        console.error('❌ VANTA.CELLS not available!');
      }
    } else {
      console.log('⏳ Waiting for conditions:', {
        threeLoaded,
        vantaLoaded,
        hasRef: !!vantaRef.current,
        hasEffect: !!vantaEffect
      });
    }

    return () => {
      if (vantaEffect) {
        console.log('🧹 Cleaning up Vanta effect');
        vantaEffect.destroy();
      }
    };
  }, [threeLoaded, vantaLoaded, vantaEffect]);

  const handleGettingStarted = () => {
    setShowGettingStarted(true);
  };

  const handleDisclaimerClose = () => {
    setShowDisclaimer(false);
    setDisclaimerAccepted();
    recordDisclaimerAcceptance();
    void maybeShowOnboarding();
  };

  return (
    <PageReadyProvider>
      <style jsx global>{`
        @keyframes heartPulse {
          0% {
            box-shadow: 
              0 0 15px rgba(188, 172, 255, 0.2),
              0 0 25px rgba(188, 172, 255, 0.1),
              inset 0 0 15px rgba(188, 172, 255, 0.05);
            border-color: rgba(255, 255, 255, 0.8);
            transform: scale(1);
          }
          10% {
            box-shadow: 
              0 0 40px rgba(188, 172, 255, 0.8),
              0 0 60px rgba(188, 172, 255, 0.5),
              inset 0 0 35px rgba(188, 172, 255, 0.3);
            border-color: rgba(255, 255, 255, 1);
            transform: scale(1.1);
          }
          20% {
            box-shadow: 
              0 0 20px rgba(188, 172, 255, 0.3),
              0 0 35px rgba(188, 172, 255, 0.15),
              inset 0 0 20px rgba(188, 172, 255, 0.1);
            border-color: rgba(255, 255, 255, 0.9);
            transform: scale(1.02);
          }
          30% {
            box-shadow: 
              0 0 45px rgba(188, 172, 255, 0.9),
              0 0 70px rgba(188, 172, 255, 0.6),
              inset 0 0 40px rgba(188, 172, 255, 0.4);
            border-color: rgba(255, 255, 255, 1);
            transform: scale(1.08);
          }
          40% {
            box-shadow: 
              0 0 15px rgba(188, 172, 255, 0.2),
              0 0 25px rgba(188, 172, 255, 0.1),
              inset 0 0 15px rgba(188, 172, 255, 0.05);
            border-color: rgba(255, 255, 255, 0.8);
            transform: scale(1);
          }
          100% {
            box-shadow: 
              0 0 15px rgba(188, 172, 255, 0.2),
              0 0 25px rgba(188, 172, 255, 0.1),
              inset 0 0 15px rgba(188, 172, 255, 0.05);
            border-color: rgba(255, 255, 255, 0.8);
            transform: scale(1);
          }
        }
      `}</style>
      
      <Script
        src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r121/three.min.js"
        strategy="afterInteractive"
        onLoad={() => {
          console.log('📦 Three.js loaded successfully');
          console.log('🔍 THREE object:', !!window.THREE);
          setThreeLoaded(true);
        }}
        onError={(e) => {
          console.error('❌ Three.js failed to load:', e);
        }}
      />

      {threeLoaded && (
        <Script
          src="https://cdn.jsdelivr.net/npm/vanta@latest/dist/vanta.cells.min.js"
          strategy="afterInteractive"
          onLoad={() => {
            console.log('📦 Vanta.js loaded successfully');
            console.log('🔍 VANTA object:', !!window.VANTA);
            setVantaLoaded(true);
          }}
          onError={(e) => {
            console.error('❌ Vanta.js failed to load:', e);
          }}
        />
      )}

      <div className="home-scroll-wrapper">
        <div style={styles.pageContainer}>
        <div id="hero" ref={vantaRef} style={styles.heroSection} data-tour="home-hero">
          <div style={styles.heroContent}>
            <h1 style={styles.heroTitle}>Welcome to ALMA Research Platform</h1>
            <p style={styles.heroSubtitle}>
              Empowering scientific discovery through AI-powered tools and collaborative workflows
            </p>
            <div style={styles.heroButtons} data-tour="home-get-started">
              <button
                onClick={handleGettingStarted}
                onMouseEnter={() => setPrimaryHovered(true)}
                onMouseLeave={() => setPrimaryHovered(false)}
                style={{
                  ...styles.primaryButton,
                  ...(primaryHovered ? styles.primaryButtonHover : {})
                }}
              >
                {t('home.getStarted')}
              </button>
              <a
                href="https://mail.google.com/chat/u/0/#chat/space/AAQAf_PDi18"
                target="_blank"
                rel="noopener noreferrer"
                onMouseEnter={() => setSecondaryHovered(true)}
                onMouseLeave={() => setSecondaryHovered(false)}
                style={{
                  ...styles.secondaryButton,
                  ...(secondaryHovered ? styles.secondaryButtonHover : {})
                }}
              >
                {t('home.chatWithUs')}
              </a>
              <button
                onClick={() => setShowDevBlogModal(true)}
                onMouseEnter={() => setDevBlogHovered(true)}
                onMouseLeave={() => setDevBlogHovered(false)}
                style={{
                  ...styles.devBlogButton,
                  ...(devBlogHovered ? styles.devBlogButtonHover : {})
                }}
              >
                {t('home.devBlog')}
              </button>
            </div>
          </div>
        </div>

        <main style={styles.mainWrapper}>
          <div style={styles.container}>
            <section
              id="team-contact"
              className="home-team-contact-section"
              data-tour="home-team"
              aria-labelledby="home-team-contact-title"
            >
              <h2 id="home-team-contact-title" className="home-team-contact-title">
                {t('questionsModal.title')}
              </h2>
              <AlmaTeamContactCards isHomepage />
            </section>
            <div id="updates" data-tour="home-updates">
              <ThisWeekUpdatesPatch />
            </div>
          </div>
        </main>

        <footer style={footerStyles.footer}>
          <div style={footerStyles.container}>
            <div style={footerStyles.content}>
              <div style={footerStyles.section}>
                <h4 style={footerStyles.sectionTitle}>{t('home.footer.team')}</h4>
                <a
                  href="https://sites.google.com/roche.com/alma/home"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={footerStyles.link}
                  onMouseEnter={(e) => e.currentTarget.style.color = 'var(--alma-on-accent)'}
                  onMouseLeave={(e) => e.currentTarget.style.color = 'rgba(255, 255, 255, 0.8)'}
                >
                  {t('home.footer.about')}
                </a>
                <a
                  href={supportMailHref}
                  style={footerStyles.link}
                  onMouseEnter={(e) => e.currentTarget.style.color = 'var(--alma-on-accent)'}
                  onMouseLeave={(e) => e.currentTarget.style.color = 'rgba(255, 255, 255, 0.8)'}
                >
                  {t('home.footer.contactSupport')}
                </a>
                <a
                  href="https://forms.gle/hojeY8kRjqoae2pPA"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={footerStyles.link}
                  onMouseEnter={(e) => e.currentTarget.style.color = 'var(--alma-on-accent)'}
                  onMouseLeave={(e) => e.currentTarget.style.color = 'rgba(255, 255, 255, 0.8)'}
                >
                  {t('home.footer.reportBug')}
                </a>
              </div>
              <div style={footerStyles.section}>
                <h4 style={footerStyles.sectionTitle}>{t('home.footer.resources')}</h4>
                <a
                  href="https://mail.google.com/chat/u/0/#chat/space/AAQAf_PDi18"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={footerStyles.link}
                  onMouseEnter={(e) => e.currentTarget.style.color = 'var(--alma-on-accent)'}
                  onMouseLeave={(e) => e.currentTarget.style.color = 'rgba(255, 255, 255, 0.8)'}
                >
                  {t('home.chatWithUs')}
                </a>
                <a
                  href="https://www.linkedin.com/in/cozzolinofrancesco/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={footerStyles.link}
                  onMouseEnter={(e) => e.currentTarget.style.color = 'var(--alma-on-accent)'}
                  onMouseLeave={(e) => e.currentTarget.style.color = 'rgba(255, 255, 255, 0.8)'}
                >
                  {t('home.connectFrancesco')}
                </a>
                <button
                  type="button"
                  onClick={() => setShowDevBlogModal(true)}
                  style={footerStyles.linkButton}
                  onMouseEnter={(e) => e.currentTarget.style.color = 'var(--alma-on-accent)'}
                  onMouseLeave={(e) => e.currentTarget.style.color = 'rgba(255, 255, 255, 0.8)'}
                >
                  {t('home.devBlog')}
                </button>
              </div>
              <div style={footerStyles.section}>
                <h4 style={footerStyles.sectionTitle}>{t('home.footer.legal')}</h4>
                <a
                  href="#"
                  style={footerStyles.link}
                  onMouseEnter={(e) => e.currentTarget.style.color = 'var(--alma-on-accent)'}
                  onMouseLeave={(e) => e.currentTarget.style.color = 'rgba(255, 255, 255, 0.8)'}
                >
                  {t('home.footer.privacy')}
                </a>
                <a
                  href="#"
                  style={footerStyles.link}
                  onMouseEnter={(e) => e.currentTarget.style.color = 'var(--alma-on-accent)'}
                  onMouseLeave={(e) => e.currentTarget.style.color = 'rgba(255, 255, 255, 0.8)'}
                >
                  {t('home.footer.terms')}
                </a>
              </div>
            </div>
            <div style={footerStyles.copyright}>
              <p style={footerStyles.copyrightText}>
                {t('home.footer.copyright', { year: copyrightYear })}
              </p>
            </div>
          </div>
        </footer>

        {selectedPost && (
          <div style={styles.modalOverlay} onClick={() => setSelectedPost(null)}>
            <div style={styles.modalContent} onClick={(e) => e.stopPropagation()}>
              <div style={styles.modalHeader}>
                <h1 style={styles.modalTitle}>{selectedPost.title}</h1>
                <button style={styles.closeButton} onClick={() => setSelectedPost(null)}>×</button>
              </div>
              <div style={styles.modalMeta}>
                <span style={styles.postCategory}>{selectedPost.category}</span>
                <time style={styles.postDate}>{new Date(selectedPost.date).toLocaleDateString()}</time>
                <span style={styles.postAuthor}>By {selectedPost.author}</span>
              </div>
              <div style={styles.modalBody}>
                <p>{selectedPost.content}</p>
              </div>
            </div>
          </div>
        )}

        <DisclaimerPopup
          isTriggered={showDisclaimer}
          onClose={handleDisclaimerClose}
        />
        <GettingStartedModal
          isOpen={showGettingStarted}
          onClose={() => setShowGettingStarted(false)}
        />
        <WelcomeFeaturesModal
          isOpen={showWelcome}
          onClose={() => {
            const userId = session?.user?.email ?? '';
            if (userId) setOnboardingVersionDoneCached(userId, CURRENT_ONBOARDING_VERSION);
            void markOnboardingCompleted(CURRENT_ONBOARDING_VERSION, 'skipped');
            setShowWelcome(false);
          }}
          onComplete={() => {
            const userId = session?.user?.email ?? '';
            if (userId) setOnboardingVersionDoneCached(userId, CURRENT_ONBOARDING_VERSION);
            void markOnboardingCompleted(CURRENT_ONBOARDING_VERSION, 'completed');
            setShowWelcome(false);
          }}
        />
        {showDevBlogModal && (
          <div style={devBlogModalStyles.overlay} onClick={() => setShowDevBlogModal(false)}>
            <div style={devBlogModalStyles.modal} onClick={(e) => e.stopPropagation()}>
              <div style={devBlogModalStyles.header}>
                <button
                  type="button"
                  style={devBlogModalStyles.closeButton}
                  onClick={() => setShowDevBlogModal(false)}
                  aria-label={t('home.devBlogCloseAria')}
                >
                  ×
                </button>
              </div>
              <div style={devBlogModalStyles.content}>
                <a
                  href="https://www.linkedin.com/in/cozzolinofrancesco/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={devBlogModalStyles.aboutSection}
                >
                  {!devBlogImageError ? (
                    <img
                      src={FRANCESCO_PHOTO}
                      alt={t('home.devBlogAvatarAria')}
                      style={devBlogModalStyles.profileImage}
                      onError={() => setDevBlogImageError(true)}
                    />
                  ) : (
                    <div style={devBlogModalStyles.profileFallback} aria-label={t('home.devBlogAvatarAria')}>
                      <span style={devBlogModalStyles.profileFallbackText}>FC</span>
                    </div>
                  )}
                  <div style={devBlogModalStyles.aboutText}>
                    <h2 style={devBlogModalStyles.aboutTitle}>{t('home.devBlogAboutTitle')}</h2>
                    <p style={devBlogModalStyles.aboutDescription}>
                      {t('home.devBlogBio')}
                    </p>
                    <span style={devBlogModalStyles.connectButton}>{t('home.devBlogConnect')}</span>
                  </div>
                </a>
              </div>
            </div>
          </div>
        )}
        <TutorialSystem context="homepage" />
        </div>
      </div>
    </PageReadyProvider>
  );
}

const styles: { [key: string]: React.CSSProperties } = {
  pageContainer: {
    minHeight: "100vh",
    backgroundColor: "var(--alma-surface-sunken)",
    width: "100%",
  },
  mainWrapper: {
    padding: "0 5%",
    width: "100%",
    boxSizing: "border-box",
  },
  container: {
    margin: "0.5rem auto",
    maxWidth: "1200px",
    fontFamily: "Arial, sans-serif",
    color: "var(--alma-text)",
    width: "100%",
    padding: "0.5rem 1rem",
  },
  heroSection: {
    position: "relative",
    color: "var(--alma-on-accent)",
    padding: "4rem 2rem",
    borderRadius: "0px",
    margin: "0",
    width: "100%",
    minHeight: "360px",
    overflow: "hidden",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  heroContent: {
    margin: "0",
    padding: "0 2rem",
    position: "relative",
    zIndex: 2,
    width: "100%",
    maxWidth: "800px",
    boxSizing: "border-box",
    textAlign: "left",
  },
  heroTitle: {
    fontSize: "3rem",
    fontWeight: "700",
    margin: "0 0 1rem",
    lineHeight: "1.2",
  },
  heroSubtitle: {
    fontSize: "1.25rem",
    margin: "0 0 2rem",
    opacity: "0.9",
    lineHeight: "1.6",
  },
  heroButtons: {
    display: "flex",
    gap: "1rem",
    justifyContent: "flex-start",
    flexWrap: "wrap",
    alignItems: "center",
  },
  primaryButton: {
    backgroundColor: "var(--alma-surface)",
    color: "var(--alma-accent)",
    padding: "0.75rem 2rem",
    borderRadius: "8px",
    textDecoration: "none",
    fontWeight: "600",
    border: "none",
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.1)",
    transition: "all 0.3s ease",
    cursor: "pointer",
    fontSize: "inherit",
    fontFamily: "inherit",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryButton: {
    backgroundColor: "var(--alma-surface)",
    color: "var(--alma-accent)",
    padding: "0.75rem 2rem",
    borderRadius: "8px",
    textDecoration: "none",
    fontWeight: "600",
    border: "none",
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.1)",
    transition: "all 0.3s ease",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonHover: {
    transform: "translateY(-2px)",
    boxShadow: "0 8px 20px rgba(0, 0, 0, 0.15)",
  },
  secondaryButtonHover: {
    transform: "translateY(-2px)",
    boxShadow: "0 8px 20px rgba(0, 0, 0, 0.15)",
  },
  devBlogButton: {
    backgroundColor: "transparent",
    color: "var(--alma-on-accent)",
    width: "60px",
    height: "60px",
    borderRadius: "50%",
    textDecoration: "none",
    fontWeight: "600",
    border: "2px solid var(--alma-on-accent)",
    transition: "all 0.3s ease",
    fontSize: "0.7rem",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    lineHeight: "1.2",
    marginLeft: "2rem",
    boxShadow: "0 0 15px rgba(188, 172, 255, 0.2), inset 0 0 15px rgba(188, 172, 255, 0.05)",
    animation: "heartPulse 2.5s ease-in-out infinite",
  },
  devBlogButtonHover: {
    backgroundColor: "rgba(188, 172, 255, 0.1)",
    transform: "translateY(-2px) scale(1.05)",
    boxShadow: "0 0 50px rgba(188, 172, 255, 0.8), 0 0 80px rgba(188, 172, 255, 0.4), inset 0 0 30px rgba(188, 172, 255, 0.3)",
    border: "2px solid rgba(255, 255, 255, 1)",
    animation: "heartPulse 0.8s ease-in-out infinite",
  },
  newsSection: {
    margin: "4rem 0",
  },
  sectionHeader: {
    textAlign: "center",
    marginBottom: "3rem",
  },
  sectionTitle: {
    fontSize: "2.5rem",
    fontWeight: "700",
    color: "var(--alma-accent)",
    margin: "0 0 1rem",
  },
  sectionSubtitle: {
    fontSize: "1.1rem",
    color: "var(--alma-text-muted)",
    margin: "0",
  },
  postsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
    gap: "2rem",
    margin: "2rem 0",
  },
  postCard: {
    backgroundColor: "var(--alma-surface)",
    borderRadius: "12px",
    padding: "1.5rem",
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.1)",
    cursor: "pointer",
    transition: "transform 0.2s ease, box-shadow 0.2s ease",
    border: "1px solid var(--alma-border)",
  },
  postHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "1rem",
  },
  postCategory: {
    backgroundColor: "var(--alma-accent)",
    color: "var(--alma-on-accent)",
    padding: "0.25rem 0.75rem",
    borderRadius: "20px",
    fontSize: "0.8rem",
    fontWeight: "600",
  },
  postDate: {
    color: "var(--alma-text-muted)",
    fontSize: "0.9rem",
  },
  postTitle: {
    fontSize: "1.3rem",
    fontWeight: "600",
    color: "var(--alma-accent)",
    margin: "0 0 1rem",
    lineHeight: "1.4",
  },
  postExcerpt: {
    color: "var(--alma-text-muted)",
    lineHeight: "1.6",
    margin: "0 0 1rem",
  },
  postFooter: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  postAuthor: {
    color: "var(--alma-text-muted)",
    fontSize: "0.9rem",
  },
  readMore: {
    color: "var(--alma-accent)",
    fontWeight: "600",
    fontSize: "0.9rem",
  },
  quickActionsSection: {
    margin: "4rem 0",
    textAlign: "center",
  },
  actionsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
    gap: "2rem",
    margin: "2rem 0",
  },
  actionCard: {
    backgroundColor: "var(--alma-surface)",
    borderRadius: "12px",
    padding: "2rem",
    textDecoration: "none",
    color: "inherit",
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.1)",
    border: "1px solid var(--alma-border)",
    transition: "transform 0.2s ease, box-shadow 0.2s ease",
    cursor: "pointer",
    fontSize: "inherit",
    fontFamily: "inherit",
    textAlign: "center"
  },

  actionTitle: {
    fontSize: "1.2rem",
    fontWeight: "600",
    color: "var(--alma-accent)",
    margin: "0 0 0.5rem",
  },
  actionDescription: {
    color: "var(--alma-text-muted)",
    margin: "0",
    lineHeight: "1.5",
  },
  modalOverlay: {
    position: "fixed",
    top: "0",
    left: "0",
    right: "0",
    bottom: "0",
    backgroundColor: "var(--alma-overlay)",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 1000,
  },
  modalContent: {
    backgroundColor: "var(--alma-surface)",
    borderRadius: "12px",
    padding: "2rem",
    maxWidth: "600px",
    width: "90%",
    maxHeight: "80vh",
    overflow: "auto",
    position: "relative",
  },
  modalHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: "1rem",
  },
  modalTitle: {
    fontSize: "1.5rem",
    fontWeight: "600",
    color: "var(--alma-accent)",
    margin: "0",
    flex: "1",
    paddingRight: "1rem",
  },
  closeButton: {
    background: "none",
    border: "none",
    fontSize: "2rem",
    cursor: "pointer",
    color: "var(--alma-text-muted)",
    padding: "0",
    lineHeight: "1",
  },
  modalMeta: {
    display: "flex",
    gap: "1rem",
    alignItems: "center",
    marginBottom: "1rem",
    flexWrap: "wrap",
  },
  modalBody: {
    color: "var(--alma-text)",
    lineHeight: "1.6",
  },
};

const devBlogModalStyles: { [key: string]: React.CSSProperties } = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'var(--alma-overlay)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingTop: '60px',
    paddingBottom: '60px',
    zIndex: 1000,
    overflow: 'auto',
  },
  modal: {
    backgroundColor: 'var(--alma-surface)',
    borderRadius: '16px',
    padding: '2rem',
    maxWidth: '1200px',
    width: '90%',
    maxHeight: '90vh',
    position: 'relative',
    boxShadow: '0 20px 40px rgba(0, 0, 0, 0.15)',
    overflow: 'auto',
  },
  header: {
    display: 'flex',
    justifyContent: 'flex-end',
    alignItems: 'center',
    marginBottom: '2rem',
    paddingBottom: '1rem',
    borderBottom: '1px solid var(--alma-border)',
  },
  title: {
    fontSize: '2rem',
    fontWeight: '700',
    color: 'var(--alma-accent)',
    margin: 0,
  },
  closeButton: {
    background: 'none',
    border: 'none',
    fontSize: '2rem',
    cursor: 'pointer',
    color: 'var(--alma-text-muted)',
    padding: 0,
    lineHeight: 1,
    width: '32px',
    height: '32px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '4px',
    transition: 'background-color 0.2s ease',
  },
  content: {
    overflow: 'auto',
  },
  aboutSection: {
    display: 'flex',
    gap: '1.5rem',
    marginBottom: '2rem',
    padding: '1.5rem',
    backgroundColor: 'var(--alma-surface-sunken)',
    borderRadius: '12px',
    border: '1px solid var(--alma-border)',
    boxShadow: '0 0 0 1px rgba(17, 7, 74, 0.06), 0 0 16px rgba(138, 127, 255, 0.18)',
    alignItems: 'flex-start',
    flexWrap: 'wrap',
    textDecoration: 'none',
    color: 'inherit',
    cursor: 'pointer',
    transition: 'transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease',
  },
  profileImage: {
    width: '120px',
    height: '120px',
    borderRadius: '50%',
    objectFit: 'cover',
    flexShrink: 0,
    border: '3px solid var(--alma-accent)',
    boxShadow: '0 4px 8px rgba(0, 0, 0, 0.1)',
  },
  profileFallback: {
    width: '120px',
    height: '120px',
    borderRadius: '50%',
    flexShrink: 0,
    border: '3px solid var(--alma-accent)',
    background: 'linear-gradient(135deg, var(--alma-accent-soft) 0%, var(--alma-surface) 100%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 4px 8px rgba(0, 0, 0, 0.08)',
  },
  profileFallbackText: {
    fontSize: '1.75rem',
    fontWeight: 800,
    color: 'var(--alma-accent)',
    letterSpacing: '0.04em',
  },
  aboutText: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    minWidth: '260px',
  },
  aboutTitle: {
    margin: 0,
    marginBottom: '0.75rem',
    fontSize: '2rem',
    fontWeight: 700,
    color: 'var(--alma-accent)',
  },
  aboutDescription: {
    margin: 0,
    fontSize: '1rem',
    lineHeight: '1.6',
    color: 'var(--alma-text-muted)',
  },
  connectButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: '0.9rem',
    padding: '0.45rem 0.9rem',
    borderRadius: '999px',
    backgroundColor: 'var(--alma-accent)',
    color: 'var(--alma-on-accent)',
    fontSize: '0.88rem',
    fontWeight: 700,
    letterSpacing: '0.01em',
    width: 'fit-content',
    boxShadow: '0 2px 8px rgba(17, 7, 74, 0.28)',
  },
};

const footerStyles: { [key: string]: React.CSSProperties } = {
  footer: {
    backgroundColor: 'var(--alma-accent)',
    color: 'var(--alma-on-accent)',
    padding: '3rem 2rem 2rem',
    marginTop: '4rem',
    borderTop: '1px solid rgba(255, 255, 255, 0.1)',
  },
  container: {
    maxWidth: '1200px',
    margin: '0 auto',
    width: '100%',
  },
  content: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: '2rem',
    marginBottom: '2rem',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  sectionTitle: {
    fontSize: '1rem',
    fontWeight: '600',
    margin: '0 0 0.5rem 0',
    color: 'var(--alma-on-accent)',
  },
  link: {
    color: 'rgba(255, 255, 255, 0.8)',
    textDecoration: 'none',
    fontSize: '0.9rem',
    transition: 'color 0.2s ease',
  },
  linkButton: {
    background: 'none',
    border: 'none',
    color: 'rgba(255, 255, 255, 0.8)',
    textDecoration: 'none',
    fontSize: '0.9rem',
    cursor: 'pointer',
    padding: 0,
    textAlign: 'left',
    fontFamily: 'inherit',
    transition: 'color 0.2s ease',
  },
  copyright: {
    borderTop: '1px solid rgba(255, 255, 255, 0.1)',
    paddingTop: '2rem',
    textAlign: 'center',
  },
  copyrightText: {
    margin: 0,
    fontSize: '0.85rem',
    color: 'rgba(255, 255, 255, 0.6)',
  },
};
