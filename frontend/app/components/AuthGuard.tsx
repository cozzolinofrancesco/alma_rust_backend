"use client";

import { signOut, useSession } from "next-auth/react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { RotateCw } from 'lucide-react';
import { useLanguage } from "../contexts/LanguageContext";
import { ModalLocaleToggle } from "./ModalLocaleToggle";
import { useAppContext } from './RootProvider';
import { reloadBrowserSession, SessionRefreshCancelledError, signInToGoogle } from '../lib/clientSession';

interface AuthGuardProps {
  children: React.ReactNode;
}

const AUTH_ERROR_PREFIX = "/auth/error";

const ALLOWED_EMAIL_REGEX = /@([a-z0-9-]+\.)*roche\.com$/i;

// Support contact is configured via env — no personal email hardcoded in source.
const CONTACT_NAME = process.env.NEXT_PUBLIC_SUPPORT_CONTACT_NAME ?? "";
const CONTACT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL ?? "";

const AuthGuard: React.FC<AuthGuardProps> = ({ children }) => {
  const { data: session, status } = useSession();
  const { refreshSession } = useAppContext();
  const [recoveryFailed, setRecoveryFailed] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const { t } = useLanguage();
  const pathname = usePathname();
  const isAuthErrorRoute =
    pathname === AUTH_ERROR_PREFIX || pathname?.startsWith(`${AUTH_ERROR_PREFIX}/`);

  const userEmail = session?.user?.email?.trim().toLowerCase() ?? null;
  const isAuthorizedDomain =
    userEmail !== null && ALLOWED_EMAIL_REGEX.test(userEmail);

  useEffect(() => {
    if (isAuthErrorRoute || status !== 'unauthenticated') return;
    let disposed = false;
    let checking = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function checkSession() {
      if (disposed || checking) return;
      if (!navigator.onLine) {
        setRecoveryFailed(true);
        return;
      }
      checking = true;
      attempts += 1;
      try {
        const recovered = await refreshSession();
        if (disposed) return;
        setRecoveryFailed(false);
        if (recovered) {
          reloadBrowserSession();
        } else {
          await signInToGoogle();
        }
      } catch (failure) {
        if (disposed || failure instanceof SessionRefreshCancelledError) return;
        setRecoveryFailed(true);
        if (attempts < 4) timer = setTimeout(() => { void checkSession(); }, 1000 * 2 ** (attempts - 1));
      } finally {
        checking = false;
      }
    }

    function resume() {
      if (document.visibilityState !== 'visible') return;
      clearTimeout(timer);
      attempts = 0;
      void checkSession();
    }

    void checkSession();
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [status, isAuthErrorRoute, refreshSession, retryVersion]);

  if (isAuthErrorRoute) {
    return <>{children}</>;
  }

  if ((status === 'loading' && !session) || status === 'unauthenticated') {
    return (
      <div style={{ 
        display: 'flex', 
        justifyContent: 'center', 
        alignItems: 'center', 
        height: 'var(--app-height)',
        backgroundColor: '#f5f5f5'
      }}>
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '16px'
        }}>
          <div style={{
            width: '40px',
            height: '40px',
            border: '4px solid #e5e7eb',
            borderTopColor: '#11074A',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite'
          }} />
          <style>{`
            @keyframes spin {
              to { transform: rotate(360deg); }
            }
          `}</style>
          <span role="status" style={{ color: '#6b7280', fontSize: '14px' }}>
            {recoveryFailed ? 'Connection interrupted.' : t('authGuard.loading')}
          </span>
          {recoveryFailed && (
            <button
              type="button"
              onClick={() => setRetryVersion(current => current + 1)}
              className="inline-flex items-center gap-2 rounded border border-gray-300 px-3 py-2 text-sm"
              title="Retry connection"
            >
              <RotateCw size={16} aria-hidden="true" />
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  if (session && !isAuthorizedDomain) {
    return (
      <>
        <div
          aria-hidden="true"
          style={{
            filter: "grayscale(100%) blur(2px)",
            pointerEvents: "none",
            userSelect: "none",
            opacity: 0.4,
          }}
        >
          {children}
        </div>
        <UnauthorizedDomainModal email={session?.user?.email ?? ""} />
      </>
    );
  }

  return <>{children}</>;
};

interface UnauthorizedDomainModalProps {
  email: string;
}

const UnauthorizedDomainModal: React.FC<UnauthorizedDomainModalProps> = ({
  email,
}) => {
  const { t } = useLanguage();
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="unauthorized-domain-title"
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(17, 7, 74, 0.55)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        zIndex: 10000,
        padding: "16px",
      }}
    >
      <div
        style={{
          position: "relative",
          backgroundColor: "#ffffff",
          borderRadius: "12px",
          maxWidth: "480px",
          width: "100%",
          boxShadow: "0 20px 48px rgba(0, 0, 0, 0.25)",
          padding: "28px 28px 24px",
          fontFamily:
            "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        }}
      >
        <ModalLocaleToggle
          variant="onLight"
          style={{ position: "absolute", top: "14px", right: "14px" }}
        />
        <h2
          id="unauthorized-domain-title"
          style={{
            margin: 0,
            marginBottom: "12px",
            paddingRight: "88px",
            fontSize: "20px",
            fontWeight: 600,
            color: "#11074A",
          }}
        >
          {t("accessRestrictedModal.title")}
        </h2>
        <p
          style={{
            margin: 0,
            marginBottom: "12px",
            fontSize: "14px",
            lineHeight: 1.5,
            color: "#374151",
          }}
        >
          {t("accessRestrictedModal.body")}
        </p>
        {email && (
          <p
            style={{
              margin: 0,
              marginBottom: "16px",
              fontSize: "13px",
              color: "#6b7280",
            }}
          >
            {t("accessRestrictedModal.signedInAs", { email })}
          </p>
        )}
        <p
          style={{
            margin: 0,
            marginBottom: "8px",
            fontSize: "14px",
            lineHeight: 1.5,
            color: "#374151",
          }}
        >
          {t("accessRestrictedModal.contactIntro")}
        </p>
        <p
          style={{
            margin: 0,
            marginBottom: "20px",
            fontSize: "14px",
            lineHeight: 1.5,
            color: "#374151",
          }}
        >
          {CONTACT_NAME && (
            <>
              <strong>{CONTACT_NAME}</strong>
              <br />
            </>
          )}
          {CONTACT_EMAIL && (
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              style={{ color: "#11074A", fontWeight: 500 }}
            >
              {CONTACT_EMAIL}
            </a>
          )}
        </p>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "8px",
          }}
        >
          <button
            type="button"
            onClick={() => signOut({ callbackUrl: "/" })}
            style={{
              backgroundColor: "#11074A",
              color: "#ffffff",
              border: "none",
              padding: "10px 18px",
              borderRadius: "8px",
              fontSize: "14px",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            {t("accessRestrictedModal.signOut")}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AuthGuard;
