'use client';

import { useEffect } from 'react';
import { useNavigationLoading } from '../contexts/NavigationLoadingContext';

export default function NavigationLoadingOverlay() {
  const { isNavigating, message } = useNavigationLoading();

  useEffect(() => {
    if (isNavigating) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = 'unset';
      };
    }
  }, [isNavigating]);

  if (!isNavigating) return null;

  return (
    <div className="navigation-loading-overlay" role="status" aria-live="polite" aria-label={message}>
      <div className="navigation-loading-modal">
        <div className="navigation-loading-content">
          <div className="navigation-loading-spinner" />
          <div className="navigation-loading-message">{message}</div>
        </div>
      </div>
      <style jsx>{`
        .navigation-loading-overlay {
          position: fixed;
          inset: 0;
          background: rgba(17, 7, 74, 0.4);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10001;
          animation: navLoadingFadeIn 0.2s ease-out;
        }

        @keyframes navLoadingFadeIn {
          from {
            opacity: 0;
            backdrop-filter: blur(0px);
            -webkit-backdrop-filter: blur(0px);
          }
          to {
            opacity: 1;
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
          }
        }

        @keyframes navLoadingSpin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }

        .navigation-loading-modal {
          background: rgba(255, 255, 255, 0.95);
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          border: 1px solid rgba(255, 255, 255, 0.3);
          border-radius: 16px;
          padding: 2rem;
          box-shadow:
            0 20px 60px rgba(17, 7, 74, 0.2),
            0 8px 32px rgba(17, 7, 74, 0.1);
          animation: navLoadingSlideIn 0.3s ease-out;
          min-width: 280px;
          max-width: 400px;
          text-align: center;
        }

        @keyframes navLoadingSlideIn {
          from {
            opacity: 0;
            transform: translateY(-20px) scale(0.95);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }

        .navigation-loading-content {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 1rem;
        }

        .navigation-loading-spinner {
          width: 32px;
          height: 32px;
          border: 3px solid rgba(17, 7, 74, 0.2);
          border-top: 3px solid #11074a;
          border-radius: 50%;
          animation: navLoadingSpin 1s linear infinite;
        }

        .navigation-loading-message {
          color: #11074a;
          font-size: 1.1rem;
          font-weight: 600;
          margin: 0;
        }
      `}</style>
    </div>
  );
}
