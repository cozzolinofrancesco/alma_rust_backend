'use client';

import { useEffect, useState } from 'react';
import '../styles/PolicyModal.css';

interface PolicyModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  policyFile: string;
}

const PolicyModal: React.FC<PolicyModalProps> = ({ isOpen, onClose, title, policyFile }) => {
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = 'unset';
      };
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      setLoading(true);
      fetch(policyFile)
        .then((response) => response.text())
        .then((text) => {
          setContent(text);
          setLoading(false);
        })
        .catch((error) => {
          console.error('Error loading policy:', error);
          setContent('Error loading policy content. Please try again later.');
          setLoading(false);
        });
    }
  }, [isOpen, policyFile]);

  if (!isOpen) return null;

  return (
    <div className="policy-modal-overlay" onClick={onClose}>
      <div className="policy-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="policy-modal-header">
          <h2>{title}</h2>
          <button className="policy-modal-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="policy-modal-body">
          {loading ? (
            <div className="policy-modal-loading">Loading...</div>
          ) : (
            <pre className="policy-modal-text">{content}</pre>
          )}
        </div>
        <div className="policy-modal-footer">
          <button className="policy-modal-button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default PolicyModal;

