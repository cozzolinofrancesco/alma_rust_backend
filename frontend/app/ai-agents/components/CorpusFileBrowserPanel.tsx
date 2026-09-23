'use client';

import React from 'react';
import {
  FaCheckCircle,
  FaChevronRight,
  FaCopy,
  FaExternalLinkAlt,
  FaFileAlt,
  FaFolder,
  FaPlus,
  FaSpinner,
  FaSync,
} from 'react-icons/fa';

export interface CorpusFileBrowserBreadcrumb {
  id: string;
  name: string;
}

export interface CorpusFileBrowserDriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
}

export interface CorpusFileBrowserFolder {
  id: string;
  name: string;
}

interface RagSupportResult {
  supported: boolean;
  reason?: string;
}

export type CorpusFileSortMode = 'name' | 'size' | 'created' | 'updated';

export interface CorpusFileBrowserPanelProps {
  selectedFolder: CorpusFileBrowserFolder | null;
  corpusInitiated: boolean;
  sessionPrefixReady: boolean;
  creatingFolder: boolean;
  onInitiateCorpus: () => void;
  onOpenInDrive: () => void;
  onRefresh: () => void;
  onCopyFolderId: () => void;
  copied: boolean;
  currentFolderId: string | null;
  loadingFiles: boolean;
  breadcrumbs: CorpusFileBrowserBreadcrumb[];
  onNavigateBreadcrumb: (index: number) => void;
  fileTypeFilter: string;
  onFileTypeFilterChange: (value: string) => void;
  fileTypeOptions: string[];
  sortMode: CorpusFileSortMode;
  onSortModeChange: (mode: CorpusFileSortMode) => void;
  onToggleSelectAllVisible: () => void;
  visibleSupportedCount: number;
  allVisibleSupportedSelected: boolean;
  selectedFileIds: Set<string>;
  folderItems: CorpusFileBrowserDriveFile[];
  sortedFolderItems: CorpusFileBrowserDriveFile[];
  isFolderMime: (mime: string) => boolean;
  ragSupport: (file: CorpusFileBrowserDriveFile) => RagSupportResult;
  formatMimeLabel: (mime: string, name: string) => string;
  formatFileSize: (size?: number) => string;
  onNavigateToFolder: (id: string, name: string) => void;
  onToggleFile: (file: CorpusFileBrowserDriveFile) => void;
  emptyHint?: string;
  className?: string;
}

const iconBtn =
  'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40';

const selectClass =
  'h-9 min-w-0 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 shadow-sm focus:border-[#11074A]/40 focus:outline-none focus:ring-2 focus:ring-[#11074A]/15';

export function CorpusFileBrowserPanel({
  selectedFolder,
  corpusInitiated,
  sessionPrefixReady,
  creatingFolder,
  onInitiateCorpus,
  onOpenInDrive,
  onRefresh,
  onCopyFolderId,
  copied,
  currentFolderId,
  loadingFiles,
  breadcrumbs,
  onNavigateBreadcrumb,
  fileTypeFilter,
  onFileTypeFilterChange,
  fileTypeOptions,
  sortMode,
  onSortModeChange,
  onToggleSelectAllVisible,
  visibleSupportedCount,
  allVisibleSupportedSelected,
  selectedFileIds,
  folderItems,
  sortedFolderItems,
  isFolderMime,
  ragSupport,
  formatMimeLabel,
  formatFileSize,
  onNavigateToFolder,
  onToggleFile,
  emptyHint = 'Enter a session name above, then initiate the corpus to browse project files.',
  className = '',
}: CorpusFileBrowserPanelProps) {
  const selectAllDisabled = !corpusInitiated || loadingFiles || visibleSupportedCount === 0;

  return (
    <div
      className={`flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200/90 bg-white shadow-sm ${className}`}
    >
      <div className="shrink-0 border-b border-slate-100 bg-gradient-to-r from-slate-50/90 to-white px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white shadow-sm"
              style={{ backgroundColor: '#11074A' }}
            >
              1
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold tracking-tight text-slate-900">Select files</h2>
              <p className="mt-0.5 text-xs text-slate-500">Browse your project folder and choose sources</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {corpusInitiated ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800">
                <FaCheckCircle className="text-emerald-600" aria-hidden />
                Corpus ready
              </span>
            ) : (
              <button
                type="button"
                onClick={onInitiateCorpus}
                disabled={creatingFolder || !sessionPrefixReady}
                className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ backgroundColor: '#11074A' }}
                title={
                  sessionPrefixReady
                    ? 'Create the report_creation_corpus folder in the project root'
                    : 'Enter a session name above first'
                }
              >
                {creatingFolder ? <FaSpinner className="animate-spin" /> : <FaPlus />}
                {creatingFolder ? 'Setting up…' : 'Initiate corpus'}
              </button>
            )}

            {selectedFolder && (
              <div className="flex items-center gap-1.5" role="toolbar" aria-label="Folder actions">
                <button
                  type="button"
                  onClick={onOpenInDrive}
                  disabled={!currentFolderId || !corpusInitiated}
                  className={iconBtn}
                  title="Open in Google Drive"
                >
                  <FaExternalLinkAlt className="text-sm" />
                </button>
                <button
                  type="button"
                  onClick={onRefresh}
                  disabled={!currentFolderId || loadingFiles || !corpusInitiated}
                  className={iconBtn}
                  title={loadingFiles ? 'Refreshing…' : 'Refresh folder'}
                >
                  {loadingFiles ? <FaSpinner className="animate-spin text-sm" /> : <FaSync className="text-sm" />}
                </button>
                <button
                  type="button"
                  onClick={onCopyFolderId}
                  disabled={!corpusInitiated}
                  className={iconBtn}
                  title={copied ? 'Copied' : 'Copy folder ID'}
                >
                  {copied ? <FaCheckCircle className="text-sm text-emerald-600" /> : <FaCopy className="text-sm" />}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-5">
        {!selectedFolder ? (
          <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50/60 px-6 py-12 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
              <FaFolder className="text-xl" />
            </div>
            <p className="max-w-sm text-sm text-slate-600">{emptyHint}</p>
          </div>
        ) : (
          <>
            {breadcrumbs.length > 0 && (
              <nav
                className="mb-4 flex min-w-0 flex-wrap items-center gap-1 rounded-lg border border-slate-100 bg-slate-50/80 px-3 py-2 text-sm"
                aria-label="Folder path"
              >
                {breadcrumbs.map((crumb, idx) => (
                  <React.Fragment key={crumb.id}>
                    {idx > 0 && <FaChevronRight className="mx-0.5 shrink-0 text-[10px] text-slate-300" aria-hidden />}
                    <button
                      type="button"
                      onClick={() => onNavigateBreadcrumb(idx)}
                      className={`max-w-[12rem] truncate rounded-md px-2 py-0.5 transition-colors hover:bg-white hover:text-slate-900 ${
                        idx === breadcrumbs.length - 1
                          ? 'font-semibold text-slate-900'
                          : 'text-slate-600 hover:underline'
                      }`}
                      title={crumb.name}
                    >
                      {crumb.name}
                    </button>
                  </React.Fragment>
                ))}
              </nav>
            )}

            <div className="mb-4 flex flex-wrap items-end gap-3">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Type</span>
                  <select
                    value={fileTypeFilter}
                    onChange={(e) => onFileTypeFilterChange(e.target.value)}
                    className={selectClass}
                    title="Filter by file type"
                  >
                    <option value="all">All types</option>
                    {fileTypeOptions.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Sort</span>
                  <select
                    value={sortMode}
                    onChange={(e) => onSortModeChange(e.target.value as CorpusFileSortMode)}
                    className={selectClass}
                    title="Sort files"
                  >
                    <option value="name">Name (A→Z)</option>
                    <option value="size">Size</option>
                    <option value="created">Created</option>
                    <option value="updated">Modified</option>
                  </select>
                </label>
                <button
                  type="button"
                  onClick={onToggleSelectAllVisible}
                  disabled={selectAllDisabled}
                  className="h-9 shrink-0 self-end rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {allVisibleSupportedSelected ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              <span className="ml-auto text-xs text-slate-400">
                {sortedFolderItems.length} item{sortedFolderItems.length !== 1 ? 's' : ''}
              </span>
            </div>

            {loadingFiles ? (
              <div className="flex flex-1 items-center justify-center py-16">
                <FaSpinner className="animate-spin text-2xl text-slate-300" aria-label="Loading files" />
              </div>
            ) : (
              <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-0.5">
                {folderItems.length === 0 && (
                  <p className="py-12 text-center text-sm text-slate-500">This folder is empty.</p>
                )}
                {folderItems.length > 0 && sortedFolderItems.length === 0 && (
                  <p className="py-12 text-center text-sm text-slate-500">No items match the current filter.</p>
                )}

                {sortedFolderItems.map((item) => {
                  const isFolder = isFolderMime(item.mimeType);
                  const support = ragSupport(item);
                  const typeLabel = formatMimeLabel(item.mimeType, item.name);

                  if (isFolder) {
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => onNavigateToFolder(item.id, item.name)}
                        className="group flex w-full items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors hover:border-slate-200 hover:bg-slate-50"
                        title="Open folder"
                      >
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600 group-hover:bg-amber-100">
                          <FaFolder />
                        </span>
                        <span className="min-w-0 flex-1 truncate font-medium text-slate-900">{item.name}</span>
                        <FaChevronRight className="shrink-0 text-slate-300 group-hover:text-slate-500" />
                      </button>
                    );
                  }

                  const checked = selectedFileIds.has(item.id);
                  const disabled = !support.supported || !corpusInitiated;

                  return (
                    <label
                      key={item.id}
                      className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                        checked
                          ? 'border-[#11074A]/25 bg-[#11074A]/5 ring-1 ring-[#11074A]/10'
                          : 'border-slate-100 hover:border-slate-200 hover:bg-slate-50/80'
                      } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => onToggleFile(item)}
                        disabled={disabled}
                        className="h-4 w-4 shrink-0 rounded border-slate-300 text-[#11074A] focus:ring-[#11074A]/30"
                        title={!support.supported ? support.reason || 'Not supported' : 'Select file'}
                      />
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                        <FaFileAlt />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-slate-900">{item.name}</span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
                          <span>{formatFileSize(item.size)}</span>
                          <span className="text-slate-300" aria-hidden>
                            ·
                          </span>
                          <span>{typeLabel}</span>
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                              support.supported
                                ? 'bg-emerald-50 text-emerald-700'
                                : 'bg-red-50 text-red-700'
                            }`}
                          >
                            {support.supported ? 'Supported' : 'Unsupported'}
                          </span>
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
