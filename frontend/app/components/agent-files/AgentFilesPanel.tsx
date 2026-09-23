'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { Database, FileText, FolderOpen, Loader2, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { useLanguage } from '../../contexts/LanguageContext';
import { useAppBusyOptional } from '../../contexts/AppBusyContext';
import { agentTextExtensions, isAgentFileSupported, type AgentCorpusRef, type AgentInputMetadata } from '../../lib/agentFiles';
import { MAX_FILE_SIZE_BYTES } from '../../lib/fileValidation';
import ProjectFilePicker, { type SelectedFile } from '../ProjectFilePicker';
import { useAgentFilesLibrary } from './useAgentFilesLibrary';
import './agent-files.css';

interface Props {
  metadata?: AgentInputMetadata;
  onChange: (metadata: AgentInputMetadata) => Promise<void>;
  projectId?: string | null;
  projectCorpora?: Array<{ corpusId: string; displayName: string }>;
  disabled?: boolean;
  allowCorpora?: boolean;
}

const sourceTabs = ['saved', 'upload', 'drive', 'corpora'] as const;
type Tab = typeof sourceTabs[number];
const tabIcons = { saved: FileText, upload: Upload, drive: FolderOpen, corpora: Database };

export default function AgentFilesPanel({ metadata, onChange, projectId, projectCorpora = [], disabled = false, allowCorpora = true }: Props) {
  const { t } = useLanguage();
  const { isBusy } = useAppBusyOptional();
  const { data: session } = useSession();
  const lib = useAgentFilesLibrary(Boolean(session), session?.user?.email ?? '');
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const tabId = useId();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('saved');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [uploads, setUploads] = useState<File[]>([]);
  const [driveFiles, setDriveFiles] = useState<SelectedFile[]>([]);
  const [corpora, setCorpora] = useState<AgentCorpusRef[]>([]);
  const [corporaLoading, setCorporaLoading] = useState(false);
  const [corporaError, setCorporaError] = useState<string | null>(null);
  const [corporaRefresh, setCorporaRefresh] = useState(0);
  const mounted = useRef(true);
  const fileIds = metadata?.fileIds ?? [];
  const corpusRefs = metadata?.corpusRefs ?? [];
  const tabs = allowCorpora ? sourceTabs : sourceTabs.filter(value => value !== 'corpora');
  const attachedCount = fileIds.length + (allowCorpora ? corpusRefs.length : 0);
  const locked = busy || disabled || isBusy;
  const corporaErrorMessage = t('agentFiles.corporaError');

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const element = dialog.current;
    if (!element || !open) return;
    if (typeof element.showModal === 'function') element.showModal();
    else element.setAttribute('open', '');
  }, [open]);

  useEffect(() => {
    if (!allowCorpora && tab === 'corpora') setTab('saved');
  }, [allowCorpora, tab]);

  useEffect(() => {
    if (!allowCorpora || !open || tab !== 'corpora') return;
    const controller = new AbortController();
    setCorpora([]);
    setCorporaLoading(true);
    setCorporaError(null);
    void fetch('/api/rag/corpora', { credentials: 'include', cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(corporaErrorMessage);
        const data = await response.json();
        if (!Array.isArray(data.corpora)) throw new Error(corporaErrorMessage);
        const entries: AgentCorpusRef[] = data.corpora
          .filter((entry: { id?: unknown; displayName?: unknown }) => typeof entry?.id === 'string' && entry.id.startsWith('filesearch-'))
          .map((entry: { id: string; displayName?: string }) => ({ corpusId: entry.id, displayName: entry.displayName || entry.id }));
        if (!controller.signal.aborted) setCorpora(entries);
      }).catch(failure => {
        if (!controller.signal.aborted) setCorporaError(failure instanceof Error ? failure.message : corporaErrorMessage);
      }).finally(() => { if (!controller.signal.aborted) setCorporaLoading(false); });
    return () => controller.abort();
  }, [allowCorpora, open, tab, corporaRefresh, corporaErrorMessage, session?.user?.email]);

  const availableCorpora = new Map(corpora.map(ref => [ref.corpusId, ref]));
  for (const ref of projectCorpora) {
    if (!availableCorpora.has(ref.corpusId)) availableCorpora.set(ref.corpusId, { ...ref, ...(projectId ? { projectId } : {}) });
  }

  const perform = async (operation: () => Promise<void>) => {
    if (locked) return;
    setBusy(true);
    setError(null);
    try { await operation(); }
    catch (failure) {
      if (mounted.current && !(failure instanceof Error && failure.name === 'AbortError')) setError(failure instanceof Error ? failure.message : t('agentFiles.saveError'));
    } finally {
      if (mounted.current) { setBusy(false); setProgress(null); }
    }
  };

  const attach = async (ids: string[]) => {
    if (!mounted.current) return;
    await onChange({ fileIds: Array.from(new Set([...fileIds, ...ids])), corpusRefs });
  };

  const importAndAttach = async (sources: Array<File | { sourceId: string }>) => {
    if (sources.some(source => source instanceof File && (!isAgentFileSupported(source.type, source.name) || !source.size || source.size > MAX_FILE_SIZE_BYTES))) {
      throw new Error(t('agentFiles.unsupported'));
    }
    const ids: string[] = [];
    for (const [index, source] of sources.entries()) {
      setProgress({ current: index + 1, total: sources.length });
      const entry = await lib.create(source);
      ids.push(entry.id);
    }
    await attach(ids);
    if (mounted.current) { setUploads([]); setDriveFiles([]); setTab('saved'); }
  };

  const openLibrary = (trigger: HTMLButtonElement) => {
    returnFocusRef.current = trigger;
    setOpen(true);
    setError(null);
    void lib.refresh();
  };
  const close = () => {
    if (busy) return;
    if (typeof dialog.current?.close === 'function') dialog.current.close();
    setOpen(false);
    returnFocusRef.current?.focus();
  };
  const errorText = error || lib.error;

  return <>
    <section className="agent-files-bar" aria-label={t('agentFiles.title')}>
      <div className="agent-files-header">
        <div className="agent-files-heading">
          <strong>{t('agentFiles.title')}</strong>
          <output className="agent-files-count" aria-label={t('agentFiles.attachedCount', { count: attachedCount })} title={t('agentFiles.attachedCount', { count: attachedCount })}>{attachedCount}</output>
        </div>
        <div className="agent-files-controls" role="group" aria-label={t('agentFiles.controls')}>
          <select aria-label={t('agentFiles.saved')} value="" disabled={locked} aria-busy={lib.loading} onFocus={() => { void lib.refresh(); }}
            onChange={event => { const id = event.target.value; if (id) void perform(() => attach([id])); }}>
            <option value="">{lib.loading ? t('agentFiles.loading') : t('agentFiles.select')}</option>
            {lib.library.map(file => <option key={file.id} value={file.id} disabled={fileIds.includes(file.id)}>{file.name}</option>)}
          </select>
          <button type="button" className="agent-files-manage" title={t('agentFiles.manage')} aria-label={t('agentFiles.manage')} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? `${tabId}-dialog` : undefined}
            disabled={locked} onClick={event => openLibrary(event.currentTarget)}><FolderOpen size={17} aria-hidden="true" /><span>{t('agentFiles.manageAction')}</span></button>
          <span className="agent-files-status" role="status">
            {(busy || lib.loading) && <><Loader2 size={16} className="agent-files-spinner" aria-hidden="true" /><span className="agent-files-sr-only">{t(busy ? 'agentFiles.saving' : 'agentFiles.loading')}</span></>}
          </span>
        </div>
      </div>
      {attachedCount > 0 && <ul className="agent-files-chips" aria-label={t('agentFiles.attached')}>
        {fileIds.map(id => {
          const file = lib.library.find(entry => entry.id === id);
          const name = file?.name ?? (lib.loading ? t('agentFiles.loading') : t('agentFiles.missing'));
          return <li key={id} className={!file && !lib.loading ? 'agent-files-missing' : ''}>
            <FileText size={15} aria-hidden="true" /><span title={name}>{name}</span>
            <button type="button" title={t('agentFiles.detach')} aria-label={`${t('agentFiles.detach')}: ${name}`} disabled={locked}
              onClick={() => { void perform(() => onChange({ fileIds: fileIds.filter(value => value !== id), corpusRefs })); }}><X size={14} /></button>
          </li>;
        })}
        {(allowCorpora ? corpusRefs : []).map(ref => <li key={`corpus:${ref.corpusId}`} className="agent-files-corpus">
          <Database size={15} aria-hidden="true" /><span title={ref.displayName || ref.corpusId}>{ref.displayName || ref.corpusId}</span><small>RAG</small>
          <button type="button" title={t('agentFiles.detach')} aria-label={`${t('agentFiles.detach')}: ${ref.displayName || ref.corpusId}`} disabled={locked}
            onClick={() => { void perform(() => onChange({ fileIds, corpusRefs: corpusRefs.filter(value => value.corpusId !== ref.corpusId) })); }}><X size={14} /></button>
        </li>)}
      </ul>}
      {errorText && !open && <div className="agent-files-error" role="alert">{errorText}<button type="button" aria-label={t('agentFiles.retry')} title={t('agentFiles.retry')} onClick={event => openLibrary(event.currentTarget)}><RefreshCw size={16} /></button></div>}
    </section>
    {open && <dialog ref={dialog} id={`${tabId}-dialog`} className="agent-files-dialog" aria-labelledby={`${tabId}-title`} onCancel={event => { event.preventDefault(); close(); }}>
      <header><div className="agent-files-dialog-heading"><h2 id={`${tabId}-title`}>{t('agentFiles.manage')}</h2><span className="agent-files-selection-summary" aria-live="polite">{t('agentFiles.attachedCount', { count: attachedCount })}</span></div><button type="button" title={t('agentFiles.close')} aria-label={t('agentFiles.close')} disabled={busy} onClick={close}><X size={20} /></button></header>
      <div className="agent-files-tabs" role="tablist" aria-label={t('agentFiles.sources')}>
        {tabs.map((value, index) => {
          const Icon = tabIcons[value];
          return <button type="button" role="tab" key={value} id={`${tabId}-${value}`} aria-controls={`${tabId}-content`} aria-selected={tab === value}
          tabIndex={tab === value ? 0 : -1} disabled={locked} onClick={() => setTab(value)}
          onKeyDown={event => {
            const nextIndex = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
            if (nextIndex < 0) return;
            event.preventDefault(); setTab(tabs[nextIndex]); document.getElementById(`${tabId}-${tabs[nextIndex]}`)?.focus();
          }}><Icon size={16} aria-hidden="true" /><span>{t(`agentFiles.${value}`)}</span></button>;
        })}
      </div>
      <div className="agent-files-body" role="tabpanel" id={`${tabId}-content`} aria-labelledby={`${tabId}-${tab}`}>
        {tab === 'saved' && <>
          <div className="agent-files-toolbar"><span>{t('agentFiles.personal')}</span><button type="button" aria-label={t('agentFiles.retry')} title={t('agentFiles.retry')} disabled={lib.loading || locked} onClick={() => { void lib.refresh(); }}><RefreshCw size={16} /></button></div>
          {lib.loading && <p role="status">{t('agentFiles.loading')}</p>}
          {!lib.loading && !lib.error && !lib.library.length && <p>{t('agentFiles.empty')}</p>}
          <ul className="agent-files-list">{lib.library.map(file => <li key={file.id} data-selected={fileIds.includes(file.id)}>
            <label><input type="checkbox" checked={fileIds.includes(file.id)} disabled={locked} onChange={event => {
              const checked = event.target.checked;
              void perform(() => onChange({ fileIds: checked ? Array.from(new Set([...fileIds, file.id])) : fileIds.filter(id => id !== file.id), corpusRefs }));
            }} /><FileText size={18} aria-hidden="true" /><span>{file.name}<small>{t('agentFiles.fullFile')} / {(file.size / 1024).toFixed(0)} KB</small></span></label>
            <button type="button" className="agent-files-delete" title={t('agentFiles.remove')} aria-label={`${t('agentFiles.remove')}: ${file.name}`} disabled={locked} onClick={() => {
              if (!window.confirm(t('agentFiles.removeConfirm'))) return;
              void perform(async () => {
                if (fileIds.includes(file.id)) await onChange({ fileIds: fileIds.filter(id => id !== file.id), corpusRefs });
                await lib.remove(file.id);
              });
            }}><Trash2 size={16} /></button>
          </li>)}</ul>
        </>}
        {tab === 'upload' && <>
          <label className="agent-files-upload"><Upload size={22} /><span>{t('agentFiles.choose')}</span>
            <input type="file" multiple aria-label={t('agentFiles.choose')} disabled={locked} accept={['.pdf', ...Array.from(agentTextExtensions, extension => `.${extension}`)].join(',')}
              onChange={event => setUploads(Array.from(event.target.files ?? []))} />
          </label>
          <ul className="agent-files-pending">{uploads.map((file, index) => <li key={`${index}:${file.name}`}>{file.name}</li>)}</ul>
          <button type="button" className="agent-files-command" disabled={locked || !uploads.length} onClick={() => { void perform(() => importAndAttach(uploads)); }}><Upload size={16} />{t('agentFiles.uploadAttach')}</button>
        </>}
        {tab === 'drive' && <>
          <fieldset disabled={locked} className="agent-files-picker"><ProjectFilePicker selectedFiles={driveFiles} onFilesSelected={setDriveFiles} acceptsFile={isAgentFileSupported} /></fieldset>
          <button type="button" className="agent-files-command" disabled={locked || !driveFiles.length} onClick={() => { void perform(() => importAndAttach(driveFiles.map(file => ({ sourceId: file.id })))); }}><Plus size={16} />{t('agentFiles.attachSelected')}</button>
        </>}
        {allowCorpora && tab === 'corpora' && <>
          {corporaLoading && <p role="status">{t('agentFiles.loading')}</p>}
          {corporaError && <div role="alert" className="agent-files-error">{corporaError}<button type="button" aria-label={t('agentFiles.retry')} onClick={() => setCorporaRefresh(value => value + 1)}><RefreshCw size={16} /></button></div>}
          {!corporaLoading && !corporaError && !availableCorpora.size && <p>{t('agentFiles.noCorpora')}</p>}
          <ul className="agent-files-list">{Array.from(availableCorpora.values(), ref => <li key={ref.corpusId} data-source="corpus" data-selected={corpusRefs.some(value => value.corpusId === ref.corpusId)}><label>
            <input type="checkbox" checked={corpusRefs.some(value => value.corpusId === ref.corpusId)} disabled={locked} onChange={event => {
              const checked = event.target.checked;
              void perform(() => onChange({ fileIds, corpusRefs: checked ? [...corpusRefs, ref] : corpusRefs.filter(value => value.corpusId !== ref.corpusId) }));
            }} /><Database size={18} aria-hidden="true" /><span>{ref.displayName || ref.corpusId}<small>{t('agentFiles.retrieval')}</small></span>
          </label></li>)}</ul>
        </>}
      </div>
      <footer>
        <div className="agent-files-feedback">
          {errorText && <div className="agent-files-error" role="alert">{errorText}</div>}
          {busy && <div className="agent-files-progress" role="status"><Loader2 size={16} className="agent-files-spinner" aria-hidden="true" />{progress ? `${progress.current} / ${progress.total}` : t('agentFiles.saving')}</div>}
        </div>
        <button type="button" className="agent-files-command" disabled={busy} onClick={close}>{t('agentFiles.done')}</button>
      </footer>
    </dialog>}
  </>;
}

export function AgentFilesIndicator({ metadata }: { metadata?: AgentInputMetadata }) {
  const { t } = useLanguage();
  const files = metadata?.fileIds?.length ?? 0;
  const corpora = metadata?.corpusRefs?.length ?? 0;
  if (!files && !corpora) return null;
  return <span className="agent-files-indicator" title={t('agentFiles.inherited')}><FileText size={13} aria-hidden="true" />{t('agentFiles.title')} {files}{corpora > 0 && <><Database size={13} aria-hidden="true" />RAG {corpora}</>}</span>;
}