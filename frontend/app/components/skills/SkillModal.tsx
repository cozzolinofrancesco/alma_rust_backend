'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useLanguage, type TranslateFn } from '../../contexts/LanguageContext';
import { DEFAULT_MODEL } from '../../lib/modelConfig';
import { importGoogleDocText } from '../../lib/importGoogleDoc';
import type { Skill, SkillCreateInput, SkillSource, SkillUpdateInput } from '../../lib/agentSkills';
import { SkillAppearanceSchema } from '../../lib/skillAppearance';
import SkillIconPicker, { type SkillAppearanceDraft } from './SkillIconPicker';
import SkillBadge from './SkillBadge';
import './skills.css';

type ContentTab = 'text' | 'file' | 'gdoc';

interface SkillModalProps {
  open: boolean;
  library: Skill[];
  attachedIds: string[];
  libraryLoading?: boolean;
  libraryError?: string | null;
  onRefresh?: () => void;
  // When set, the modal opens directly in edit mode for this skill.
  editingSkill?: Skill | null;
  onClose: () => void;
  onCreate: (input: SkillCreateInput) => Promise<Skill>;
  onUpdate: (id: string, patch: SkillUpdateInput) => Promise<Skill>;
  onDelete: (id: string) => Promise<void>;
  onAttach: (id: string) => void;
  onDetach: (id: string) => void;
}

const TEXT_LIKE = /\.(txt|md|markdown|csv|json|html?|xml|rtf)$/i;

function Spinner() {
  return <span className="skill-modal__spinner" aria-hidden="true" />;
}

function UploadIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 5 17 10" />
      <line x1="12" y1="5" x2="12" y2="16" />
    </svg>
  );
}

interface ResultCardProps {
  title: string;
  count: number;
  preview: string;
  onEdit: () => void;
  onReplace: () => void;
  busy: boolean;
  t: TranslateFn;
}

function ResultCard({ title, count, preview, onEdit, onReplace, busy, t }: ResultCardProps) {
  return (
    <div className="skill-modal__result">
      <div className="skill-modal__result-head">
        <span className="skill-modal__result-title">
          <span className="skill-modal__result-check" aria-hidden="true">✓</span>
          {title}
        </span>
        <span className="skill-modal__result-count">{t('skills.charCount', { count })}</span>
      </div>
      <p className="skill-modal__result-preview">{preview}</p>
      <div className="skill-modal__result-actions">
        <button type="button" className="skill-btn" onClick={onEdit} disabled={busy}>
          {t('skills.editText')}
        </button>
        <button type="button" className="skill-btn" onClick={onReplace} disabled={busy}>
          {t('skills.replace')}
        </button>
      </div>
    </div>
  );
}

export default function SkillModal({
  open,
  library,
  attachedIds,
  libraryLoading = false,
  libraryError = null,
  onRefresh,
  editingSkill,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
  onAttach,
  onDetach,
}: SkillModalProps) {
  const { t } = useLanguage();
  const viewId = useId();
  const [view, setView] = useState<'browse' | 'edit'>('browse');
  const [tab, setTab] = useState<ContentTab>('text');
  const [label, setLabel] = useState('');
  const [appearance, setAppearance] = useState<SkillAppearanceDraft>({});
  const [text, setText] = useState('');
  const [source, setSource] = useState<SkillSource>('typed');
  const [gdocUrl, setGdocUrl] = useState('');
  const [importedName, setImportedName] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // (Re)initialise whenever the modal opens or the target skill changes.
  useEffect(() => {
    if (!open) return;
    if (editingSkill) {
      setView('edit');
      setLabel(editingSkill.label);
      setAppearance(editingSkill.appearance ?? (editingSkill.icon ? { icon: { kind: 'legacy', value: editingSkill.icon } } : {}));
      setText(editingSkill.text);
      setSource(editingSkill.source ?? 'typed');
    } else {
      setView('browse');
      setLabel('');
      setAppearance({});
      setText('');
      setSource('typed');
    }
    setTab('text');
    setGdocUrl('');
    setImportedName('');
    setDragActive(false);
    setError(null);
    setBusy(false);
  }, [open, editingSkill]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const isEditingExisting = Boolean(editingSkill);
  const hasContent = Boolean(text.trim());
  const parsedAppearance = SkillAppearanceSchema.safeParse(appearance);
  const appearanceRequired = !editingSkill || Boolean(editingSkill.appearance) || Boolean(appearance.color) || appearance.icon?.kind === 'lucide';
  const appearanceValid = parsedAppearance.success || !appearanceRequired;

  const startNew = () => {
    setView('edit');
    setLabel('');
    setAppearance({});
    setText('');
    setSource('typed');
    setTab('text');
    setGdocUrl('');
    setImportedName('');
    setError(null);
  };

  const clearContent = () => {
    setText('');
    setSource('typed');
    setImportedName('');
    setGdocUrl('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const onPickFile = async (file: File | null | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      let extracted = '';
      if (TEXT_LIKE.test(file.name) || file.type.startsWith('text/')) {
        extracted = await file.text();
      } else {
        // Binary doc (pdf/docx/…): transcribe to text via the existing endpoint.
        const fd = new FormData();
        fd.append('file0', file);
        fd.append(
          'messages',
          JSON.stringify([{ role: 'user', text: t('skills.extractPrompt') }]),
        );
        fd.append('model', DEFAULT_MODEL);
        const res = await fetch('/api/gemini', { method: 'POST', body: fd });
        if (!res.ok) throw new Error(t('skills.fileImportFailed'));
        const data = (await res.json()) as { response?: string };
        extracted = data.response?.trim() ?? '';
      }
      if (!extracted) throw new Error(t('skills.fileImportEmpty'));
      setText(extracted);
      setSource('file');
      setImportedName(file.name);
      if (!label.trim()) setLabel(file.name.replace(/\.[^.]+$/, ''));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('skills.fileImportFailed'));
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const onImportGdoc = async () => {
    if (!gdocUrl.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const imported = await importGoogleDocText(gdocUrl.trim());
      if (!imported.trim()) throw new Error(t('skills.gdocImportEmpty'));
      setText(imported);
      setSource('gdoc');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('skills.gdocImportFailed'));
    } finally {
      setBusy(false);
    }
  };

  const onSave = async () => {
    if (!label.trim() || !text.trim() || !appearanceValid) {
      setError(t('skills.requiredFields'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (editingSkill) {
        await onUpdate(editingSkill.id, {
          label: label.trim(),
          appearance: parsedAppearance.success ? parsedAppearance.data : undefined,
          text: text.trim(),
          source,
        });
      } else {
        const created = await onCreate({
          label: label.trim(),
          appearance: parsedAppearance.success ? parsedAppearance.data : undefined,
          text: text.trim(),
          source,
        });
        onAttach(created.id);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('skills.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async () => {
    if (!editingSkill) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete(editingSkill.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('skills.deleteFailed'));
    } finally {
      setBusy(false);
    }
  };

  const tabs: Array<{ id: ContentTab; label: string }> = [
    { id: 'text', label: t('skills.tabText') },
    { id: 'file', label: t('skills.tabFile') },
    { id: 'gdoc', label: t('skills.tabGdoc') },
  ];

  const views = [
    { id: 'browse', label: t('skills.selectLabel') },
    { id: 'edit', label: t('skills.newSkill') },
  ] as const;
  const changeView = (nextView: 'browse' | 'edit') => {
    setView(nextView);
    if (nextView === 'browse') onRefresh?.();
  };

  const title = isEditingExisting
    ? t('skills.modalEditTitle')
    : view === 'browse'
      ? t('skills.modalAddTitle')
      : t('skills.modalNewTitle');

  return (
    <div
      className="skill-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="skill-modal">
        <div className="skill-modal__header">
          <span className="skill-modal__title">{title}</span>
          <div className="skill-modal__spacer" />
          <button
            type="button"
            className="skill-modal__close"
            aria-label={t('skills.close')}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {!isEditingExisting && (
          <div className="skill-modal__tabs skill-modal__view-tabs" role="tablist" aria-label={t('skills.modalAddTitle')}>
            {views.map((item, index) => (
              <button
                key={item.id}
                id={`${viewId}-${item.id}-tab`}
                type="button"
                role="tab"
                aria-selected={view === item.id}
                aria-controls={`${viewId}-${item.id}-panel`}
                tabIndex={view === item.id ? 0 : -1}
                disabled={busy}
                className={'skill-modal__tab' + (view === item.id ? ' skill-modal__tab--active' : '')}
                onClick={() => changeView(item.id)}
                onKeyDown={(event) => {
                  const nextIndex = event.key === 'Home' ? 0
                    : event.key === 'End' ? 1
                      : event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? 1 - index
                        : null;
                  if (nextIndex === null) return;
                  event.preventDefault();
                  changeView(views[nextIndex].id);
                  const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
                  buttons?.[nextIndex]?.focus();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}

        {view === 'browse' ? (
          <>
            <div className="skill-modal__body" role="tabpanel" id={`${viewId}-browse-panel`} aria-labelledby={`${viewId}-browse-tab`}>
              <div className="skill-modal__hint">{t('skills.browseHint')}</div>
              {libraryLoading && library.length === 0 ? (
                <div className="skill-modal__hint" role="status"><Spinner /> {t('skills.loadingLibrary')}</div>
              ) : library.length === 0 && !libraryError ? (
                <div className="skill-modal__hint">{t('skills.libraryEmpty')}</div>
              ) : (
                <div className="skill-modal__library">
                  {library.map((s) => {
                    const attached = attachedIds.includes(s.id);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        className={
                          'skill-modal__library-item' +
                          (attached ? ' skill-modal__library-item--attached' : '')
                        }
                        disabled={attached}
                        onClick={() => {
                          onAttach(s.id);
                          onClose();
                        }}
                      >
                        <SkillBadge appearance={s.appearance} legacyIcon={s.icon} label={s.label} small />
                        <span className="skill-modal__library-text">
                          <span className="skill-modal__library-name">{s.label}</span>
                          <span className="skill-modal__library-preview">{s.text}</span>
                        </span>
                        {attached && (
                          <span className="skill-modal__hint">{t('skills.attached')}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              {libraryError && (
                <div className="skill-modal__error" role="alert">
                  {libraryError}
                  {onRefresh && (
                    <button
                      type="button"
                      className="skills-bar__retry"
                      aria-label={t('skills.reloadLibrary')}
                      title={t('skills.reloadLibrary')}
                      disabled={libraryLoading}
                      onClick={onRefresh}
                    >
                      <RefreshCw size={16} aria-hidden="true" />
                    </button>
                  )}
                </div>
              )}
              {error && <div className="skill-modal__error">{error}</div>}
            </div>
            <div className="skill-modal__footer">
              <div className="skill-modal__footer-spacer" />
              <button type="button" className="skill-btn" onClick={onClose}>
                {t('skills.cancel')}
              </button>
              <button type="button" className="skill-btn skill-btn--primary" onClick={startNew}>
                {t('skills.newSkill')}
              </button>
            </div>
          </>
        ) : (
          <>
            <div
              className="skill-modal__body"
              role={isEditingExisting ? undefined : 'tabpanel'}
              id={`${viewId}-edit-panel`}
              aria-labelledby={isEditingExisting ? undefined : `${viewId}-edit-tab`}
            >
              <div className="skill-modal__row">
                <div className="skill-modal__group skill-modal__group--grow">
                  <label className="skill-modal__label" htmlFor="skill-label">
                    {t('skills.labelField')}
                  </label>
                  <input
                    id="skill-label"
                    className="skill-modal__input"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder={t('skills.labelPlaceholder')}
                  />
                </div>
              </div>

              <SkillIconPicker
                value={appearance}
                onChange={setAppearance}
                disabled={busy}
                usedColors={library.flatMap((skill) => skill.appearance ? [skill.appearance.color] : [])}
              />

              <div className="skill-modal__tabs" role="tablist">
                {tabs.map((tb) => (
                  <button
                    key={tb.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === tb.id}
                    className={'skill-modal__tab' + (tab === tb.id ? ' skill-modal__tab--active' : '')}
                    onClick={() => setTab(tb.id)}
                  >
                    {tb.label}
                  </button>
                ))}
              </div>

              {tab === 'text' && (
                <div className="skill-modal__group">
                  <label className="skill-modal__label" htmlFor="skill-text">
                    {t('skills.textField')}
                  </label>
                  <textarea
                    id="skill-text"
                    className="skill-modal__textarea"
                    value={text}
                    onChange={(e) => {
                      setText(e.target.value);
                      setSource('typed');
                    }}
                    placeholder={t('skills.textPlaceholder')}
                  />
                  <span className="skill-modal__charcount">
                    {t('skills.charCount', { count: text.trim().length })}
                  </span>
                </div>
              )}

              {tab === 'file' && (
                hasContent ? (
                  <ResultCard
                    title={importedName ? t('skills.importedFromFile', { name: importedName }) : t('skills.importedFromGdoc')}
                    count={text.trim().length}
                    preview={text}
                    onEdit={() => setTab('text')}
                    onReplace={clearContent}
                    busy={busy}
                    t={t}
                  />
                ) : (
                  <>
                    <div
                      className={
                        'skill-modal__dropzone' +
                        (dragActive ? ' skill-modal__dropzone--drag' : '') +
                        (busy ? ' skill-modal__dropzone--busy' : '')
                      }
                      role="button"
                      tabIndex={0}
                      aria-disabled={busy}
                      onClick={() => { if (!busy) fileInputRef.current?.click(); }}
                      onKeyDown={(e) => {
                        if ((e.key === 'Enter' || e.key === ' ') && !busy) {
                          e.preventDefault();
                          fileInputRef.current?.click();
                        }
                      }}
                      onDragOver={(e) => { e.preventDefault(); if (!busy) setDragActive(true); }}
                      onDragEnter={(e) => { e.preventDefault(); if (!busy) setDragActive(true); }}
                      onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragActive(false);
                        if (!busy) onPickFile(e.dataTransfer.files?.[0]);
                      }}
                    >
                      <span className="skill-modal__dropzone-icon">
                        {busy ? <Spinner /> : <UploadIcon />}
                      </span>
                      <span className="skill-modal__dropzone-cta">
                        {busy ? t('skills.reading') : dragActive ? t('skills.dropActive') : t('skills.dropCta')}
                      </span>
                      <span className="skill-modal__dropzone-hint">{t('skills.dropTypes')}</span>
                    </div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      hidden
                      accept=".txt,.md,.markdown,.csv,.json,.pdf,.doc,.docx,.rtf,.html"
                      onChange={(e) => onPickFile(e.target.files?.[0])}
                      disabled={busy}
                    />
                  </>
                )
              )}

              {tab === 'gdoc' && (
                <>
                  <div className="skill-modal__row">
                    <div className="skill-modal__group skill-modal__group--grow">
                      <label className="skill-modal__label" htmlFor="skill-gdoc">
                        {t('skills.gdocField')}
                      </label>
                      <input
                        id="skill-gdoc"
                        className="skill-modal__input"
                        value={gdocUrl}
                        onChange={(e) => setGdocUrl(e.target.value)}
                        placeholder="https://docs.google.com/document/d/…"
                        disabled={busy}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && gdocUrl.trim() && !busy) {
                            e.preventDefault();
                            onImportGdoc();
                          }
                        }}
                      />
                    </div>
                    <button
                      type="button"
                      className="skill-btn skill-btn--primary"
                      onClick={onImportGdoc}
                      disabled={busy || !gdocUrl.trim()}
                    >
                      {busy ? <><Spinner /> {t('skills.importing')}</> : t('skills.importBtn')}
                    </button>
                  </div>
                  {hasContent && (
                    <ResultCard
                      title={t('skills.importedFromGdoc')}
                      count={text.trim().length}
                      preview={text}
                      onEdit={() => setTab('text')}
                      onReplace={clearContent}
                      busy={busy}
                      t={t}
                    />
                  )}
                </>
              )}

              {error && <div className="skill-modal__error">{error}</div>}
            </div>

            <div className="skill-modal__footer">
              {isEditingExisting && (
                <>
                  <button
                    type="button"
                    className="skill-btn skill-btn--danger"
                    onClick={onRemove}
                    disabled={busy}
                  >
                    {t('skills.delete')}
                  </button>
                  <button
                    type="button"
                    className="skill-btn"
                    onClick={() => {
                      onDetach(editingSkill!.id);
                      onClose();
                    }}
                    disabled={busy}
                  >
                    {t('skills.detach')}
                  </button>
                </>
              )}
              <div className="skill-modal__footer-spacer" />
              <button type="button" className="skill-btn" onClick={onClose} disabled={busy}>
                {t('skills.cancel')}
              </button>
              <button
                type="button"
                className="skill-btn skill-btn--primary"
                onClick={onSave}
                disabled={busy || !label.trim() || !text.trim() || !appearanceValid}
              >
                {busy ? <><Spinner /> {t('skills.saving')}</> : t('skills.save')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
