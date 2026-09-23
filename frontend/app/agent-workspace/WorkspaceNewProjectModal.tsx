'use client';

import React, { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import { FolderPlus } from 'lucide-react';
import { useSession } from 'next-auth/react';
import { useLanguage } from '../contexts/LanguageContext';
import { MAX_PROJECT_NAME_LENGTH } from '../lib/project-constants';

interface WorkspaceNewProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (project: { id: string; name: string }) => void;
}

const NAME_PATTERN = /^[a-zA-Z0-9 _-]+$/;

// Create-project modal for the Alma Studio left bar. Mirrors AlmaStudioWipModal's
// light white/lavender/navy styling (the /projects NewWorkflowPopup2 is dark
// glassmorphism and would clash here). Posts to the shared /api/create-project.
export default function WorkspaceNewProjectModal({
  isOpen,
  onClose,
  onCreated,
}: WorkspaceNewProjectModalProps) {
  const { t } = useLanguage();
  const { data: session } = useSession();
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isOpen]);

  // Reset transient state each time the modal opens.
  useEffect(() => {
    if (isOpen) {
      setName('');
      setErrorMessage(null);
      setSubmitting(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const submit = async () => {
    setErrorMessage(null);
    const sanitized = DOMPurify.sanitize(name.trim());

    if (!sanitized) {
      setErrorMessage(t('almaStudioProjects.nameInvalid'));
      return;
    }
    if (sanitized.length > MAX_PROJECT_NAME_LENGTH) {
      setErrorMessage(t('almaStudioProjects.nameTooLong', { max: MAX_PROJECT_NAME_LENGTH }));
      return;
    }
    if (!NAME_PATTERN.test(sanitized)) {
      setErrorMessage(t('almaStudioProjects.nameInvalid'));
      return;
    }

    const token = session?.accessToken;
    if (!token) {
      setErrorMessage(t('almaStudioProjects.createError', { message: 'Not authenticated' }));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/create-project', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ project_name: sanitized, collaborators: [] }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'Unknown error');
      }
      if (!data?.project_id) {
        throw new Error('Malformed response: missing project_id');
      }

      onCreated({ id: data.project_id, name: data.project_name ?? sanitized });
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setErrorMessage(t('almaStudioProjects.createError', { message }));
    } finally {
      setSubmitting(false);
    }
  };

  const titleId = 'aw-new-project-title';

  return (
    <div style={styles.overlay} onClick={submitting ? undefined : onClose}>
      <div
        style={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={styles.iconWrap}>
          <FolderPlus size={26} color="#11074A" />
        </div>

        <h2 id={titleId} style={styles.title}>
          {t('almaStudioProjects.modalTitle')}
        </h2>

        {errorMessage && <div style={styles.error}>{errorMessage}</div>}

        <input
          type="text"
          style={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('almaStudioProjects.namePlaceholder', { max: MAX_PROJECT_NAME_LENGTH })}
          maxLength={MAX_PROJECT_NAME_LENGTH}
          disabled={submitting}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim() && !submitting) submit();
          }}
        />

        <div style={styles.actions}>
          <button
            type="button"
            style={styles.cancelButton}
            onClick={onClose}
            disabled={submitting}
          >
            {t('almaStudioProjects.cancel')}
          </button>
          <button
            type="button"
            style={{
              ...styles.createButton,
              ...(!name.trim() || submitting ? styles.createButtonDisabled : {}),
            }}
            onClick={submit}
            disabled={!name.trim() || submitting}
          >
            {submitting ? t('almaStudioProjects.creating') : t('almaStudioProjects.create')}
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
    backgroundColor: 'rgba(17, 7, 74, 0.55)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    padding: '1.5rem',
    zIndex: 10200,
  },
  modal: {
    position: 'relative',
    backgroundColor: '#ffffff',
    borderRadius: '20px',
    padding: '2rem',
    width: '100%',
    maxWidth: '420px',
    boxShadow: '0 25px 50px rgba(17, 7, 74, 0.4)',
    textAlign: 'center',
  },
  iconWrap: {
    width: '56px',
    height: '56px',
    borderRadius: '16px',
    backgroundColor: '#EEF0FB',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto 1rem',
  },
  title: {
    fontSize: '1.4rem',
    fontWeight: 700,
    color: '#11074A',
    margin: '0 0 1.25rem',
  },
  error: {
    backgroundColor: '#FEE2E2',
    color: '#991B1B',
    padding: '0.6rem 0.9rem',
    borderRadius: '10px',
    fontSize: '0.85rem',
    marginBottom: '1rem',
    textAlign: 'left',
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '0.75rem 1rem',
    fontSize: '0.95rem',
    color: '#1f2033',
    backgroundColor: '#F8F7FC',
    border: '1px solid #E3DDF5',
    borderRadius: '12px',
    outline: 'none',
    marginBottom: '1.25rem',
  },
  actions: {
    display: 'flex',
    gap: '0.75rem',
  },
  cancelButton: {
    flex: 1,
    backgroundColor: '#F3EEFF',
    color: '#4B2FAE',
    border: 'none',
    padding: '0.75rem 1rem',
    borderRadius: '12px',
    fontSize: '0.95rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  createButton: {
    flex: 1,
    backgroundColor: '#11074A',
    color: '#ffffff',
    border: 'none',
    padding: '0.75rem 1rem',
    borderRadius: '12px',
    fontSize: '0.95rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  createButtonDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
};
