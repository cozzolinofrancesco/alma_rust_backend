'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';

interface ShareTargetProject {
  id: string;
  name: string;
  displayName?: string;
}

interface CollaboratorEntry {
  email: string;
  role: string;
}

interface ShareProjectModalProps {
  project: ShareTargetProject;
  onClose: () => void;
  onShared?: () => void;
}

const ShareProjectModal: React.FC<ShareProjectModalProps> = ({ project, onClose, onShared }) => {
  const { t } = useLanguage();

  const [collaborators, setCollaborators] = useState<CollaboratorEntry[]>([]);
  const [loadingList, setLoadingList] = useState<boolean>(true);
  const [email, setEmail] = useState<string>('');
  const [role, setRole] = useState<'reader' | 'writer'>('reader');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadCollaborators = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/collaborators`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setCollaborators(Array.isArray(data.collaborators) ? data.collaborators : []);
      }
    } catch (err) {
      console.error('Error loading collaborators:', err);
    } finally {
      setLoadingList(false);
    }
  }, [project.id]);

  useEffect(() => {
    loadCollaborators();
  }, [loadCollaborators]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) {
      setError(t('projectsPage.shareEmailRequired'));
      return;
    }

    setSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch(`/api/projects/${project.id}/collaborators`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmed, role }),
      });

      if (res.ok) {
        setSuccess(t('projectsPage.shareSuccess', { email: trimmed }));
        setEmail('');
        await loadCollaborators();
        onShared?.();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || t('projectsPage.shareError'));
      }
    } catch (err) {
      console.error('Error sharing project:', err);
      setError(t('projectsPage.shareError'));
    } finally {
      setSubmitting(false);
    }
  };

  const roleLabel = (r: string) =>
    r === 'writer' ? t('projectsPage.roleEditor') : t('projectsPage.roleViewer');

  const projectLabel = project.displayName || project.name;
  const avatarInitial = (email: string) => (email.trim().charAt(0) || '·').toUpperCase();

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(17, 7, 74, 0.32)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        animation: 'shareFade 0.18s ease',
      }}
    >
      <style jsx>{`
        @keyframes shareFade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes sharePop { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
        .share-add-btn { transition: background-color 0.16s ease, box-shadow 0.16s ease; }
        .share-add-btn:not(:disabled):hover { box-shadow: 0 6px 16px rgba(17, 7, 74, 0.28); }
        .share-input { transition: border-color 0.15s ease, box-shadow 0.15s ease; outline: none; }
        .share-input:focus { border-color: #11074A; box-shadow: 0 0 0 3px rgba(17, 7, 74, 0.12); }
      `}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: '#ffffff',
          borderRadius: '18px',
          padding: '1.5rem 1.6rem',
          width: '90%',
          maxWidth: '470px',
          boxShadow: '0 24px 60px -12px rgba(17, 7, 74, 0.35)',
          animation: 'sharePop 0.2s ease',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.25rem', gap: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', minWidth: 0 }}>
            <span
              aria-hidden="true"
              style={{
                flex: '0 0 auto',
                width: '38px',
                height: '38px',
                borderRadius: '11px',
                background: 'linear-gradient(135deg, #6D5BD0 0%, #11074A 100%)',
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="5" r="3" />
                <circle cx="6" cy="12" r="3" />
                <circle cx="18" cy="19" r="3" />
                <line x1="8.6" y1="10.5" x2="15.4" y2="6.5" />
                <line x1="8.6" y1="13.5" x2="15.4" y2="17.5" />
              </svg>
            </span>
            <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#1a1330', margin: 0, letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t('projectsPage.shareModalTitle', { name: projectLabel })}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label={t('projectsPage.shareClose')}
            style={{ background: 'none', border: 'none', fontSize: '1.35rem', lineHeight: 1, cursor: 'pointer', color: '#9c98a8', flex: '0 0 auto' }}
          >
            ×
          </button>
        </div>

        <form onSubmit={handleAdd} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <input
              type="email"
              className="share-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('projectsPage.shareEmailPlaceholder')}
              disabled={submitting}
              style={{
                flex: '1 1 220px',
                minWidth: 0,
                padding: '0.6rem 0.85rem',
                border: '1px solid #ddd8ec',
                borderRadius: '10px',
                fontSize: '0.9rem',
              }}
            />
            <select
              value={role}
              className="share-input"
              onChange={(e) => setRole(e.target.value as 'reader' | 'writer')}
              disabled={submitting}
              style={{
                padding: '0.6rem 0.85rem',
                border: '1px solid #ddd8ec',
                borderRadius: '10px',
                fontSize: '0.9rem',
                backgroundColor: '#fff',
                cursor: 'pointer',
              }}
            >
              <option value="reader">{t('projectsPage.roleViewer')}</option>
              <option value="writer">{t('projectsPage.roleEditor')}</option>
            </select>
          </div>
          <button
            type="submit"
            className="share-add-btn"
            disabled={submitting}
            style={{
              alignSelf: 'flex-start',
              padding: '0.6rem 1.4rem',
              backgroundColor: submitting ? '#9c98a8' : '#11074A',
              color: '#fff',
              border: 'none',
              borderRadius: '999px',
              fontSize: '0.88rem',
              fontWeight: 600,
              cursor: submitting ? 'not-allowed' : 'pointer',
            }}
          >
            {submitting ? t('projectsPage.shareLoading') : t('projectsPage.addCollaborator')}
          </button>

          {error && <p style={{ margin: 0, color: '#b91c1c', fontSize: '0.85rem' }}>{error}</p>}
          {success && <p style={{ margin: 0, color: '#166534', fontSize: '0.85rem' }}>{success}</p>}
        </form>

        <div style={{ borderTop: '1px solid #f0eef7', paddingTop: '1rem' }}>
          <h3 style={{ fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#8b8794', margin: '0 0 0.75rem 0' }}>
            {t('projectsPage.sharedWithTitle')}
          </h3>
          {loadingList ? (
            <p style={{ margin: 0, color: '#8b8794', fontSize: '0.85rem' }}>{t('projectsPage.shareLoading')}</p>
          ) : collaborators.length > 0 ? (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.6rem', maxHeight: '200px', overflowY: 'auto' }}>
              {collaborators.map((c) => (
                <li
                  key={c.email}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', fontSize: '0.85rem', color: '#374151' }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', minWidth: 0 }}>
                    <span
                      aria-hidden="true"
                      style={{
                        flex: '0 0 auto',
                        width: '28px',
                        height: '28px',
                        borderRadius: '50%',
                        backgroundColor: '#efeaff',
                        color: '#5b3ec7',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontWeight: 700,
                        fontSize: '0.75rem',
                      }}
                    >
                      {avatarInitial(c.email)}
                    </span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.email}</span>
                  </span>
                  <span style={{ flex: '0 0 auto', color: '#6b7280', fontSize: '0.75rem', fontWeight: 600, backgroundColor: '#f4f2fa', borderRadius: '999px', padding: '2px 10px' }}>{roleLabel(c.role)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ margin: 0, color: '#8b8794', fontSize: '0.85rem' }}>{t('projectsPage.noCollaboratorsYet')}</p>
          )}
        </div>
      </div>
    </div>
  );
};

export default ShareProjectModal;
