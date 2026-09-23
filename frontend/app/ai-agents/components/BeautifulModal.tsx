'use client';

import React, { useEffect, useState } from 'react';
import { FaCheckCircle, FaExclamationCircle, FaExclamationTriangle, FaInfoCircle, FaTimes } from 'react-icons/fa';

export interface ModalProps {
  isOpen: boolean;
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message: string;
  onClose: () => void;
  onConfirm?: () => void;
  confirmText?: string;
  cancelText?: string;
  autoClose?: boolean;
  autoCloseDelay?: number;
}

const BeautifulModal: React.FC<ModalProps> = ({
  isOpen,
  type,
  title,
  message,
  onClose,
  onConfirm,
  confirmText = 'OK',
  cancelText = 'Cancel',
  autoClose = false,
  autoCloseDelay = 2000
}) => {
  const [progress, setProgress] = useState(100);

  useEffect(() => {
    if (isOpen && autoClose) {
      setProgress(100);

      const startTime = Date.now();
      const progressInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const remaining = Math.max(0, 100 - (elapsed / autoCloseDelay) * 100);
        setProgress(remaining);

        if (remaining <= 0) {
          clearInterval(progressInterval);
        }
      }, 50);

      const timer = setTimeout(() => {
        if (onConfirm) {
          onConfirm();
        } else {
          onClose();
        }
      }, autoCloseDelay);

      return () => {
        clearTimeout(timer);
        clearInterval(progressInterval);
      };
    }
  }, [isOpen, autoClose, autoCloseDelay, onClose, onConfirm]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const getIcon = () => {
    switch (type) {
      case 'success':
        return <FaCheckCircle className="modal-icon success" />;
      case 'error':
        return <FaExclamationCircle className="modal-icon error" />;
      case 'warning':
        return <FaExclamationTriangle className="modal-icon warning" />;
      case 'info':
      default:
        return <FaInfoCircle className="modal-icon info" />;
    }
  };

  const getColorClass = () => {
    switch (type) {
      case 'success':
        return 'modal-success';
      case 'error':
        return 'modal-error';
      case 'warning':
        return 'modal-warning';
      case 'info':
      default:
        return 'modal-info';
    }
  };

  return (
    <>
      {}
      <div
        className="modal-backdrop"
        onClick={onClose}
      />

      {}
      <div className={`modal-container ${getColorClass()}`}>
        <div className="modal-content">
          {}
          <div className="modal-header">
            <div className="modal-header-content">
              {getIcon()}
              <h3 className="modal-title">{title}</h3>
            </div>
            <button
              className="modal-close-btn"
              onClick={onClose}
              type="button"
            >
              <FaTimes />
            </button>
          </div>

          {}
          <div className="modal-body">
            <p className="modal-message">{message}</p>

            {}
            {autoClose && (
              <div className="auto-close-progress">
                <div className="auto-close-bar" style={{ width: `${progress}%` }}></div>
              </div>
            )}
          </div>

          {}
          <div className="modal-footer">
            {!autoClose && (
              <>
                {onConfirm ? (
                  <>
                    <button
                      className="modal-btn modal-btn-secondary"
                      onClick={onClose}
                      type="button"
                    >
                      {cancelText}
                    </button>
                    <button
                      className="modal-btn modal-btn-primary"
                      onClick={onConfirm}
                      type="button"
                    >
                      {confirmText}
                    </button>
                  </>
                ) : (
                  <button
                    className="modal-btn modal-btn-primary"
                    onClick={onClose}
                    type="button"
                  >
                    {confirmText}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <style jsx>{`
        .modal-backdrop {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.6);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          z-index: 9998;
          animation: fadeIn 0.3s ease-out;
        }

        .modal-container {
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          z-index: 9999;
          animation: slideIn 0.3s ease-out;
          max-width: 90vw;
          max-height: 90vh;
        }

        .modal-content {
          background: white;
          border-radius: 16px;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
          width: 400px;
          max-width: 100%;
          overflow: hidden;
        }

        .modal-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px 0 20px;
        }

        .modal-header-content {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .modal-title {
          margin: 0;
          font-size: 1.25rem;
          font-weight: 600;
          color: #1f2937;
        }

        .modal-close-btn {
          background: none;
          border: none;
          padding: 8px;
          cursor: pointer;
          border-radius: 8px;
          color: #6b7280;
          transition: all 0.2s ease;
        }

        .modal-close-btn:hover {
          background: #f3f4f6;
          color: #374151;
        }

        .modal-body {
          padding: 12px 20px;
        }

        .modal-message {
          margin: 0;
          color: #4b5563;
          line-height: 1.6;
          white-space: pre-wrap;
        }

        .modal-footer {
          padding: 8px 20px 16px;
          display: flex;
          gap: 12px;
          justify-content: flex-end;
        }

        .modal-btn {
          padding: 10px 20px;
          border-radius: 8px;
          border: none;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s ease;
          font-size: 0.875rem;
          min-width: 80px;
        }

        .modal-btn-primary {
          background: #3b82f6;
          color: white;
        }

        .modal-btn-primary:hover {
          background: #2563eb;
          transform: translateY(-1px);
        }

        .modal-btn-secondary {
          background: #f3f4f6;
          color: #374151;
        }

        .modal-btn-secondary:hover {
          background: #e5e7eb;
        }

        /* Icon styles */
        .modal-icon {
          font-size: 1.5rem;
        }

        .modal-icon.success {
          color: #10b981;
        }

        .modal-icon.error {
          color: #ef4444;
        }

        .modal-icon.warning {
          color: #f59e0b;
        }

        .modal-icon.info {
          color: #3b82f6;
        }

        /* Modal type specific styles */
        .modal-success .modal-btn-primary {
          background: #10b981;
        }

        .modal-success .modal-btn-primary:hover {
          background: #059669;
        }

        .modal-error .modal-btn-primary {
          background: #ef4444;
        }

        .modal-error .modal-btn-primary:hover {
          background: #dc2626;
        }

        .modal-warning .modal-btn-primary {
          background: #f59e0b;
        }

        .modal-warning .modal-btn-primary:hover {
          background: #d97706;
        }

        /* Auto-close progress bar styles */
        .auto-close-progress {
          width: 100%;
          height: 8px;
          background-color: #e5e7eb;
          border-radius: 4px;
          margin-top: 16px;
          overflow: hidden;
        }

        .auto-close-bar {
          height: 100%;
          background: linear-gradient(90deg, #10b981 0%, #3b82f6 100%);
          border-radius: 4px;
          width: 0%; /* Start at 0% */
        }

        /* Animations */
        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }

        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translate(-50%, -48%) scale(0.95);
          }
          to {
            opacity: 1;
            transform: translate(-50%, -50%) scale(1);
          }
        }

        /* Responsive */
        @media (max-width: 640px) {
          .modal-content {
            width: 100%;
            margin: 20px;
            max-width: calc(100vw - 40px);
          }
          
          .modal-footer {
            flex-direction: column-reverse;
          }
          
          .modal-btn {
            width: 100%;
          }
        }
      `}</style>
    </>
  );
};

export default BeautifulModal; 