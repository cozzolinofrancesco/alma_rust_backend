'use client';

import React, { useState, useEffect } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { ModalLocaleToggle } from './ModalLocaleToggle';

interface DisclaimerPopupProps {
  isTriggered: boolean;
  onClose: () => void;
}

type TabType = 'privacy' | 'terms' | 'voice';

async function fetchPolicyPair(privacyUrl: string, termsUrl: string): Promise<[string, string]> {
  const [privacyRes, termsRes] = await Promise.all([
    fetch(privacyUrl),
    fetch(termsUrl),
  ]);
  if (!privacyRes.ok || !termsRes.ok) {
    throw new Error('policy fetch failed');
  }
  return Promise.all([privacyRes.text(), termsRes.text()]) as Promise<[string, string]>;
}

const DisclaimerPopup: React.FC<DisclaimerPopupProps> = ({ isTriggered, onClose }) => {
  const { t, locale } = useLanguage();
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('privacy');
  const [privacyContent, setPrivacyContent] = useState<string>('');
  const [termsContent, setTermsContent] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [acceptedPrivacy, setAcceptedPrivacy] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acceptedVoice, setAcceptedVoice] = useState(false);

  useEffect(() => {
    if (isTriggered) {
      setIsOpen(true);
    }
  }, [isTriggered]);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = 'unset';
      };
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);

    const enPrivacy = '/policies/privacy-disclaimer.txt';
    const enTerms = '/policies/terms-of-use.txt';
    const jaPrivacy = '/policies/privacy-disclaimer-ja.txt';
    const jaTerms = '/policies/terms-of-use-ja.txt';

    (async () => {
      try {
        let pair: [string, string];
        if (locale === 'ja') {
          try {
            pair = await fetchPolicyPair(jaPrivacy, jaTerms);
          } catch {
            pair = await fetchPolicyPair(enPrivacy, enTerms);
          }
        } else {
          pair = await fetchPolicyPair(enPrivacy, enTerms);
        }
        if (!cancelled) {
          setPrivacyContent(pair[0]);
          setTermsContent(pair[1]);
          setLoading(false);
        }
      } catch (error) {
        console.error('Error loading policies:', error);
        if (!cancelled) {
          setPrivacyContent(t('policiesModal.loadErrorPrivacy'));
          setTermsContent(t('policiesModal.loadErrorTerms'));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, locale, t]);

  const handleAgree = async () => {
    if (acceptedPrivacy && acceptedTerms && acceptedVoice) {
      setIsOpen(false);
      onClose();
    }
  };

  const canSubmit = acceptedPrivacy && acceptedTerms && acceptedVoice;
  const voiceBody = t('policiesModal.voiceBody');

  if (!isOpen) return null;

  return (
    <div style={overlayStyle}>
      <div
        style={modalStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="disclaimer-modal-title"
      >
        <div style={headerStyle}>
          <ModalLocaleToggle
            variant="onDark"
            style={{ position: 'absolute', top: '16px', right: '16px' }}
          />
          <h1 id="disclaimer-modal-title" style={titleStyle}>{t('policiesModal.title')}</h1>
          <p style={subtitleStyle}>{t('policiesModal.subtitle')}</p>
        </div>

        <div style={tabsContainerStyle}>
          <button
            type="button"
            onClick={() => setActiveTab('privacy')}
            style={{
              ...tabButtonStyle,
              ...(activeTab === 'privacy' ? activeTabStyle : inactiveTabStyle),
            }}
          >
            {t('policiesModal.tabPrivacy')}
            {acceptedPrivacy && <span style={checkmarkStyle}>✓</span>}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('terms')}
            style={{
              ...tabButtonStyle,
              ...(activeTab === 'terms' ? activeTabStyle : inactiveTabStyle),
            }}
          >
            {t('policiesModal.tabTerms')}
            {acceptedTerms && <span style={checkmarkStyle}>✓</span>}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('voice')}
            style={{
              ...tabButtonStyle,
              ...(activeTab === 'voice' ? activeTabStyle : inactiveTabStyle),
            }}
          >
            {t('policiesModal.tabVoice')}
            {acceptedVoice && <span style={checkmarkStyle}>✓</span>}
          </button>
        </div>

        <div style={contentStyle}>
          {loading ? (
            <div style={loadingStyle}>
              <p>{t('policiesModal.loading')}</p>
            </div>
          ) : (
            <>
              {activeTab === 'privacy' && (
                <div style={tabContentStyle}>
                  <pre style={policyTextStyle}>{privacyContent}</pre>
                  <div style={checkboxContainerStyle}>
                    <input
                      type="checkbox"
                      id="acceptPrivacy"
                      checked={acceptedPrivacy}
                      onChange={(e) => setAcceptedPrivacy(e.target.checked)}
                      style={checkboxStyle}
                    />
                    <label htmlFor="acceptPrivacy" style={checkboxLabelStyle}>
                      {t('policiesModal.checkPrivacy')}
                    </label>
                  </div>
                </div>
              )}

              {activeTab === 'terms' && (
                <div style={tabContentStyle}>
                  <pre style={policyTextStyle}>{termsContent}</pre>
                  <div style={checkboxContainerStyle}>
                    <input
                      type="checkbox"
                      id="acceptTerms"
                      checked={acceptedTerms}
                      onChange={(e) => setAcceptedTerms(e.target.checked)}
                      style={checkboxStyle}
                    />
                    <label htmlFor="acceptTerms" style={checkboxLabelStyle}>
                      {t('policiesModal.checkTerms')}
                    </label>
                  </div>
                </div>
              )}

              {activeTab === 'voice' && (
                <div style={tabContentStyle}>
                  <pre style={policyTextStyle}>{voiceBody}</pre>
                  <div style={checkboxContainerStyle}>
                    <input
                      type="checkbox"
                      id="acceptVoice"
                      checked={acceptedVoice}
                      onChange={(e) => setAcceptedVoice(e.target.checked)}
                      style={checkboxStyle}
                    />
                    <label htmlFor="acceptVoice" style={checkboxLabelStyle}>
                      {t('policiesModal.checkVoice')}
                    </label>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div style={footerStyle}>
          <div style={agreementStatusStyle}>
            <div style={statusItemStyle}>
              <span style={acceptedPrivacy ? statusCheckStyle : statusPendingStyle}>
                {acceptedPrivacy ? '✓' : '○'}
              </span>
              {t('policiesModal.statusPrivacy')}
            </div>
            <div style={statusItemStyle}>
              <span style={acceptedTerms ? statusCheckStyle : statusPendingStyle}>
                {acceptedTerms ? '✓' : '○'}
              </span>
              {t('policiesModal.statusTerms')}
            </div>
            <div style={statusItemStyle}>
              <span style={acceptedVoice ? statusCheckStyle : statusPendingStyle}>
                {acceptedVoice ? '✓' : '○'}
              </span>
              {t('policiesModal.statusVoice')}
            </div>
          </div>
          <button
            type="button"
            onClick={handleAgree}
            disabled={!canSubmit}
            style={{
              ...agreeButtonStyle,
              backgroundColor: canSubmit ? '#11074A' : '#AFA8BA',
              cursor: canSubmit ? 'pointer' : 'not-allowed',
              opacity: canSubmit ? 1 : 0.6,
            }}
          >
            {canSubmit ? t('policiesModal.agreeReady') : t('policiesModal.agreeDisabled')}
          </button>
        </div>
      </div>
    </div>
  );
};

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  width: '100vw',
  height: 'var(--app-height)',
  backgroundColor: 'rgba(0, 0, 0, 0.3)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '20px',
  zIndex: 10000,
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  boxSizing: 'border-box',
};

const modalStyle: React.CSSProperties = {
  backgroundColor: '#fff',
  borderRadius: '16px',
  maxWidth: '900px',
  width: '90%',
  maxHeight: '90vh',
  display: 'flex',
  flexDirection: 'column',
  boxShadow: '0 25px 50px rgba(17, 7, 74, 0.4)',
  border: '2px solid #11074A',
  overflow: 'hidden',
};

const headerStyle: React.CSSProperties = {
  position: 'relative',
  background: 'linear-gradient(135deg, #11074A 0%, #4A4453 100%)',
  color: 'white',
  padding: '2rem',
  paddingTop: '2.5rem',
  textAlign: 'center',
};

const titleStyle: React.CSSProperties = {
  margin: '0 0 0.5rem',
  paddingLeft: '72px',
  paddingRight: '72px',
  fontSize: '2rem',
  fontWeight: '700',
};

const subtitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: '1rem',
  opacity: 0.9,
  fontWeight: 400,
  paddingLeft: '72px',
  paddingRight: '72px',
};

const tabsContainerStyle: React.CSSProperties = {
  display: 'flex',
  borderBottom: '2px solid #e5e7eb',
  backgroundColor: '#f9fafb',
};

const tabButtonStyle: React.CSSProperties = {
  flex: 1,
  padding: '1rem 1.5rem',
  border: 'none',
  fontSize: '1rem',
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'all 0.2s',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '8px',
};

const activeTabStyle: React.CSSProperties = {
  backgroundColor: 'white',
  color: '#11074A',
  borderBottom: '3px solid #11074A',
};

const inactiveTabStyle: React.CSSProperties = {
  backgroundColor: '#f9fafb',
  color: '#6b7280',
  borderBottom: '3px solid transparent',
};

const checkmarkStyle: React.CSSProperties = {
  color: '#10b981',
  fontSize: '1.2rem',
  fontWeight: 'bold',
};

const contentStyle: React.CSSProperties = {
  flex: 1,
  overflow: 'auto',
  backgroundColor: '#f9fafb',
};

const loadingStyle: React.CSSProperties = {
  textAlign: 'center',
  padding: '3rem',
  color: '#4A4453',
  fontSize: '1.1rem',
};

const tabContentStyle: React.CSSProperties = {
  padding: '2rem',
};

const policyTextStyle: React.CSSProperties = {
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif",
  fontSize: '0.9rem',
  lineHeight: '1.7',
  color: '#1f2937',
  whiteSpace: 'pre-wrap',
  wordWrap: 'break-word',
  margin: '0 0 2rem 0',
  background: 'white',
  padding: '1.5rem',
  borderRadius: '8px',
  border: '1px solid #e5e7eb',
  maxHeight: '400px',
  overflowY: 'auto',
};

const checkboxContainerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  padding: '1rem',
  backgroundColor: 'white',
  borderRadius: '8px',
  border: '2px solid #11074A',
};

const checkboxStyle: React.CSSProperties = {
  width: '20px',
  height: '20px',
  accentColor: '#11074A',
  cursor: 'pointer',
};

const checkboxLabelStyle: React.CSSProperties = {
  fontSize: '1rem',
  fontWeight: 600,
  color: '#11074A',
  cursor: 'pointer',
  flex: 1,
};

const footerStyle: React.CSSProperties = {
  padding: '1.5rem 2rem',
  borderTop: '2px solid #e5e7eb',
  backgroundColor: 'white',
};

const agreementStatusStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  gap: '2rem',
  marginBottom: '1rem',
  flexWrap: 'wrap',
};

const statusItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  fontSize: '0.9rem',
  color: '#4A4453',
  fontWeight: 500,
};

const statusCheckStyle: React.CSSProperties = {
  color: '#10b981',
  fontSize: '1.2rem',
  fontWeight: 'bold',
};

const statusPendingStyle: React.CSSProperties = {
  color: '#d1d5db',
  fontSize: '1.2rem',
};

const agreeButtonStyle: React.CSSProperties = {
  width: '100%',
  padding: '1rem',
  border: 'none',
  borderRadius: '8px',
  color: 'white',
  fontSize: '1.1rem',
  fontWeight: 700,
  cursor: 'pointer',
  transition: 'all 0.2s',
};

export default DisclaimerPopup;
