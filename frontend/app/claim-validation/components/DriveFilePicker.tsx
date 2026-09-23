'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useLanguage } from '@/app/contexts/LanguageContext';
import { useProjectState } from '@/app/components/CompatibilityHooks';
import type { Document } from '../types';

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  modifiedTime: string | null;
}

interface Props {
  onSelect: (doc: Document) => void;
  disabled?: boolean;
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function DriveFilePicker({ onSelect, disabled }: Props) {
  const { t } = useLanguage();
  const { projectFolder } = useProjectState();
  const [query,         setQuery]         = useState('');
  const [files,         setFiles]         = useState<DriveFile[]>([]);
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState<string | null>(null);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [registering,   setRegistering]   = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchFiles = useCallback(async (q: string, pageToken?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ q });
      if (pageToken) params.set('pageToken', pageToken);
      if (projectFolder?.projectId) params.set('projectId', projectFolder.projectId);
      const res = await fetch(`/api/claim-validation/drive-files?${params}`);
      const data = await res.json() as { files?: DriveFile[]; nextPageToken?: string | null; error?: string };
      if (!res.ok) throw new Error(data.error ?? t('claimValidation.errDriveLoad'));
      setFiles((prev) => pageToken ? [...prev, ...(data.files ?? [])] : (data.files ?? []));
      setNextPageToken(data.nextPageToken ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('claimValidation.errDriveLoad'));
    } finally {
      setLoading(false);
    }
  }, [projectFolder?.projectId, t]);

  useEffect(() => {
    setFiles([]);
    setNextPageToken(null);
    fetchFiles(query);
  }, [projectFolder?.projectId, fetchFiles]);

  const handleSearch = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setFiles([]);
      setNextPageToken(null);
      fetchFiles(value);
    }, 400);
  };

  const handleSelect = async (file: DriveFile) => {
    if (disabled || registering) return;
    setRegistering(file.id);
    setError(null);
    try {
      const res = await fetch('/api/claim-validation/drive-register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: file.id }),
      });
      const data = await res.json() as { fileUri?: string; filename?: string; mimeType?: string; document_id?: string; error?: string };
      if (!res.ok || !data.fileUri) throw new Error(data.error ?? 'Registration failed');

      const doc: Document = {
        document_id:      data.document_id!,
        filename:         data.filename!,
        gemini_file_uri:  data.fileUri!,
        mime_type:        data.mimeType ?? 'application/pdf',
        upload_timestamp: new Date().toISOString(),
        status:           'ready',
      };
      onSelect(doc);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('claimValidation.errSelectFile'));
    } finally {
      setRegistering(null);
    }
  };

  const handleReload = () => {
    setFiles([]);
    setNextPageToken(null);
    fetchFiles(query);
  };

  return (
    <div className="space-y-3">
      {}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 0 5 11a6 6 0 0 0 12 0z" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder={projectFolder?.projectId ? t('claimValidation.searchPdfProject') : t('claimValidation.searchPdfDrive')}
            disabled={disabled}
            className="w-full pl-9 pr-10 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
          />
          {loading && (
            <svg className="absolute right-9 top-1/2 -translate-y-1/2 animate-spin h-4 w-4 text-indigo-400" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
            </svg>
          )}
        </div>
        <button
          type="button"
          onClick={handleReload}
          disabled={disabled || loading}
          className="p-2 rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-50 hover:text-gray-700 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          title={t('claimValidation.reloadList')}
          aria-label={t('claimValidation.reloadList')}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} strokeWidth={2.25} />
        </button>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg border border-red-200">{error}</p>
      )}

      {projectFolder?.projectId && (
        <p className="text-xs text-gray-500 mb-1">
          {t('claimValidation.pdfFolderScope')}
        </p>
      )}
      {}
      {files.length === 0 && !loading ? (
        <div className="text-center text-sm text-gray-400 py-8 border border-dashed border-gray-200 rounded-xl">
          {projectFolder?.projectId
            ? (query ? t('claimValidation.emptyPdfProjectSearch') : t('claimValidation.emptyPdfProjectFolder'))
            : (query ? t('claimValidation.emptyPdfDriveSearch') : t('claimValidation.emptyPdfDrive'))}
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 overflow-hidden max-h-72 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 border-b border-gray-200 z-10">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{t('claimValidation.driveColName')}</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-20 hidden sm:table-cell">{t('claimValidation.driveColSize')}</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-28 hidden md:table-cell">{t('claimValidation.driveColModified')}</th>
                <th className="px-3 py-2 w-20"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {files.map((f) => (
                <tr key={f.id} className="hover:bg-indigo-50/40 transition-colors">
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2 min-w-0">
                      {}
                      <svg className="w-4 h-4 text-red-400 shrink-0" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 1.5L18.5 9H13V3.5zM9.5 14.5c0 .8-.7 1.5-1.5 1.5s-1.5-.7-1.5-1.5.7-1.5 1.5-1.5 1.5.7 1.5 1.5zm5 0c0 .8-.7 1.5-1.5 1.5H11v-3h2c.8 0 1.5.7 1.5 1.5zM7 12h2.5c.3 0 .5.2.5.5v4c0 .3-.2.5-.5.5H7c-.3 0-.5-.2-.5-.5v-4c0-.3.2-.5.5-.5z"/>
                      </svg>
                      <span className="truncate text-gray-800 font-medium">{f.name}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-gray-500 hidden sm:table-cell tabular-nums">
                    {formatSize(f.size)}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-gray-500 hidden md:table-cell">
                    {formatDate(f.modifiedTime)}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <button
                      onClick={() => handleSelect(f)}
                      disabled={disabled || registering !== null}
                      className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 ml-auto"
                    >
                      {registering === f.id ? (
                        <>
                          <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                          </svg>
                          <span>…</span>
                        </>
                      ) : (
                        t('claimValidation.select')
                      )}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {}
      {nextPageToken && !loading && (
        <button
          onClick={() => fetchFiles(query, nextPageToken)}
          className="w-full text-sm text-indigo-600 hover:text-indigo-800 py-1"
        >
          {t('claimValidation.loadMore')}
        </button>
      )}

      <p className="text-xs text-gray-400 flex items-center gap-1">
        <svg className="w-3.5 h-3.5 text-green-500 shrink-0" fill="currentColor" viewBox="0 0 24 24">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
        </svg>
        {t('claimValidation.drivePrivacyNote')}
      </p>
    </div>
  );
}
