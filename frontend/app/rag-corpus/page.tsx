'use client';

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useSession } from 'next-auth/react';
import {
  FaSearch,
  FaFolder,
  FaFileAlt,
  FaPlus,
  FaCheck,
  FaSpinner,
  FaBrain,
  FaTimes,
  FaCopy,
  FaCheckCircle,
  FaCheckSquare,
  FaRegSquare,
  FaMinusSquare,
  FaInfoCircle,
  FaExternalLinkAlt,
  FaChevronRight,
  FaClipboardList,
  FaExclamationTriangle,
  FaSyncAlt,
  FaAngleDown,
  FaAngleUp,
  FaStop,
  FaRedo,
  FaTrash,
  FaBan,
  FaEdit,
  FaFilePdf,
  FaUpload,
  FaCloudUploadAlt,
  FaShieldAlt,
  FaWrench,
} from 'react-icons/fa';
import type { CorpusVerification } from '@/app/lib/rag/types';
import { useProjectList } from '@/app/hooks/useProjectList';
import {
  v1ScanProjectCorpusLinks,
  v1AddProjectCorpusLink,
  v1RemoveProjectCorpusLink,
  type ProjectCorpusLink,
} from '@/app/lib/agentnodesApi/agentnodesV1Client';
import { colorForUser, OWN_USER_COLOR, PROJECT_LINK_BORDER } from '@/app/lib/userColor';
import { getDisplayNameFromEmail } from '@/app/lib/formatName';

interface DriveFolder {
  id: string;
  name: string;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
  shared?: boolean;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  parents?: string[];
}

interface Corpus {
  id: string;
  displayName: string;
  corpusId: string;
  source: {
    folderName: string;
    ownerEmail?: string;
  };
  files: Array<{
    name: string;
    status: string;
  }>;
  createdAt: string;
  verification?: CorpusVerification;
}

interface JobLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  file?: string;
}

interface JobStatus {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'completed_with_errors' | 'cancelled';
  displayName: string;
  folderId: string;
  totalFiles: number;
  processedFiles: number;
  createdAt: string;
  updatedAt: string;
  corpusId?: string;
  error?: string;
  errorDetails?: unknown;
  selectedFiles?: Array<{ id: string; name: string; mimeType: string; size?: number }>;
  files?: Array<{
    id: string;
    name: string;
    mimeType: string;
    size?: number;
    status: 'pending' | 'indexing' | 'indexed' | 'error' | 'skipped';
    error?: string;
    updatedAt?: string;
  }>;
  skipFileIds?: string[];
  currentFileId?: string;
  startedAt?: string;
  currentFile?: string;
  currentFileIndex?: number;
  currentOperation?: string;
  processedChunks?: number;
  totalChunks?: number;
  logs?: JobLogEntry[];
}

type TabType = 'add' | 'jobs' | 'corpora' | 'project';

const MAX_LOCAL_FILE_SIZE_BYTES = 30 * 1024 * 1024;

// Extensions accepted for local upload. Kept intentionally aligned with what the
// /api/rag/corpora/local endpoint validates server-side (text/* + a narrow set of
// application/* types) so we don't stage files the server will reject as a batch.
const LOCAL_UPLOAD_EXTENSIONS = [
  'pdf', 'doc', 'docx', 'odt', 'txt', 'md', 'csv', 'tsv',
  'json', 'xml', 'xls', 'xlsx', 'pptx', 'sql', 'ts',
];
const LOCAL_UPLOAD_ACCEPT = LOCAL_UPLOAD_EXTENSIONS.map((ext) => `.${ext}`).join(',');

const formatFileSize = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(2)} MB`;

// Upload multipart form data with real byte-level progress. `fetch` cannot report
// upload progress, so local-file uploads (up to 30MB each) use XHR whose
// `upload.onprogress` drives the progress bar. `onProgress` gets 0–100; it reaches
// 100 while the server is still reading the body, so callers should show a
// "processing" state at 100 until the response resolves.
function uploadWithProgress(
  url: string,
  formData: FormData,
  onProgress: (percent: number) => void,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = xhr.responseText;
      }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, body });
    };
    xhr.onerror = () => reject(new Error('Network error during upload — check your connection and retry.'));
    xhr.ontimeout = () => reject(new Error('Upload timed out.'));
    xhr.send(formData);
  });
}

export default function RagCorpusManager() {
  const { data: session } = useSession();
  const currentUserEmail = session?.user?.email ?? '';

  const [activeTab, setActiveTab] = useState<TabType>('add');

  // Project ↔ corpus linking (Project tab).
  const { projects, loading: projectsLoading } = useProjectList();
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [projectLinks, setProjectLinks] = useState<ProjectCorpusLink[]>([]);
  const [projectLinksLoading, setProjectLinksLoading] = useState(false);
  const [projectLinksError, setProjectLinksError] = useState<string | null>(null);
  const [linkCorpusId, setLinkCorpusId] = useState<string>('');

  // Scan retroactively finds corpuses attached to any step in the project's agents,
  // backfills them into the link list, and returns the merged list.
  const loadProjectLinks = useCallback((projectId: string) => {
    if (!projectId) { setProjectLinks([]); return; }
    setProjectLinksLoading(true);
    setProjectLinksError(null);
    v1ScanProjectCorpusLinks(projectId)
      .then(setProjectLinks)
      .catch((err) => setProjectLinksError(err instanceof Error ? err.message : 'Failed to load project corpuses'))
      .finally(() => setProjectLinksLoading(false));
  }, []);

  useEffect(() => {
    if (activeTab === 'project' && selectedProjectId) loadProjectLinks(selectedProjectId);
  }, [activeTab, selectedProjectId, loadProjectLinks]);

  
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [jobFilesFromRegistry, setJobFilesFromRegistry] = useState<
    Record<
      string,
      Array<{
        id: string;
        name: string;
        mimeType: string;
        size?: number;
        status: 'pending' | 'indexing' | 'indexed' | 'error' | 'skipped';
        error?: string;
        updatedAt?: string;
      }>
    >
  >({});
  
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ kind: 'folder'; folder: DriveFolder } | { kind: 'file'; file: DriveFile }>>([]);
  const [searching, setSearching] = useState(false);
  
  const [selectedFolder, setSelectedFolder] = useState<DriveFolder | null>(null);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<Array<{ id: string; name: string }>>([]);
  const [folderItems, setFolderItems] = useState<DriveFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [selectedFilesMeta, setSelectedFilesMeta] = useState<Record<string, DriveFile>>({});
  const [corpusName, setCorpusName] = useState('');
  const [creating, setCreating] = useState(false);
  const [allowPartialSuccess, setAllowPartialSuccess] = useState(true);

  const [fileSource, setFileSource] = useState<'drive' | 'upload'>('drive');
  const [localFiles, setLocalFiles] = useState<File[]>([]);
  const [localDragActive, setLocalDragActive] = useState(false);
  const [localUploadError, setLocalUploadError] = useState<string | null>(null);
  // Preflight (scan detection) at selection: names of PDFs blocked as scanned/image-only,
  // and whether a check is currently running (shows a "checking…" indicator).
  const [localBlockedScans, setLocalBlockedScans] = useState<string[]>([]);
  const [localChecking, setLocalChecking] = useState(false);

  // Persistent, non-blocking status for the submit → background-job lifecycle.
  // Replaces the blocking alert()s so progress/outcome stays visible on the page.
  const [uploadNotice, setUploadNotice] = useState<
    { tone: 'info' | 'success' | 'warning' | 'error'; message: string } | null
  >(null);
  // Byte-level upload progress (0–100) for the local-file multipart POST; null when idle.
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);

  const [pdfPageRanges, setPdfPageRanges] = useState<Record<string, { startPage: number; endPage: number }>>({});
  const [pageRangeModalFile, setPageRangeModalFile] = useState<DriveFile | null>(null);
  const [tempStartPage, setTempStartPage] = useState<string>('');
  const [tempEndPage, setTempEndPage] = useState<string>('');
  
  const [corpora, setCorpora] = useState<Corpus[]>([]);

  const handleAddProjectLink = useCallback(() => {
    if (!selectedProjectId || !linkCorpusId) return;
    const corpus = corpora.find((c) => c.id === linkCorpusId || c.corpusId === linkCorpusId);
    v1AddProjectCorpusLink(selectedProjectId, {
      corpusId: linkCorpusId,
      displayName: corpus?.displayName || linkCorpusId,
      ownerEmail: currentUserEmail,
    })
      .then((links) => { setProjectLinks(links); setLinkCorpusId(''); })
      .catch((err) => setProjectLinksError(err instanceof Error ? err.message : 'Failed to add corpus'));
  }, [selectedProjectId, linkCorpusId, corpora, currentUserEmail]);

  const handleRemoveProjectLink = useCallback((corpusId: string, label: string) => {
    if (!selectedProjectId) return;
    const ok = typeof window === 'undefined'
      ? true
      : window.confirm(`Remove "${label}" from this project? It will also be detached from every step that uses it.`);
    if (!ok) return;
    setProjectLinksLoading(true);
    v1RemoveProjectCorpusLink(selectedProjectId, corpusId)
      .then(setProjectLinks)
      .catch((err) => setProjectLinksError(err instanceof Error ? err.message : 'Failed to remove corpus'))
      .finally(() => setProjectLinksLoading(false));
  }, [selectedProjectId]);
  const [loadingCorpora, setLoadingCorpora] = useState(false);
  const [expandedCorpusId, setExpandedCorpusId] = useState<string | null>(null);
  const [corpusMode, setCorpusMode] = useState<'new' | 'existing'>('new');
  // A new corpus must be created within a project (writes the shared project file too).
  const [createProjectId, setCreateProjectId] = useState<string>('');
  const [selectedExistingCorpusId, setSelectedExistingCorpusId] = useState<string | null>(null);
  
  const [editingCorpusId, setEditingCorpusId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);

  // Metadata verification / self-heal (see verifyCorpusMetadata.ts + heal route).
  const [verifyingCorpusId, setVerifyingCorpusId] = useState<string | null>(null);
  const [healingCorpusId, setHealingCorpusId] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<Record<string, string | null>>({});
  const [probingCorpusId, setProbingCorpusId] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<Record<string, { ok: boolean; chunkCount: number; charCount: number; sample: string } | { error: string }>>({});
  const [editingFileKey, setEditingFileKey] = useState<string | null>(null); // `${corpusId}:${fileId}`
  const [editingPdfName, setEditingPdfName] = useState('');
  
  const [errorDetails, setErrorDetails] = useState<unknown>(null);
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [showSupportedTypes, setShowSupportedTypes] = useState(false);
  
  const [searchFilter, setSearchFilter] = useState<'all' | 'alma' | 'regular'>('all');
  const [showHiddenInternalFolders, setShowHiddenInternalFolders] = useState(false);
  
  const [fileTypeFilter, setFileTypeFilter] = useState<string>('all');
  const [sortMode, setSortMode] = useState<'name' | 'size' | 'created' | 'updated'>('name');
  
  const [searchMode, setSearchMode] = useState<'name' | 'type'>('name');
  const [selectedSearchType, setSelectedSearchType] = useState<string>('');
  const [showTypePicker, setShowTypePicker] = useState(false);
  const [typePickerFilter, setTypePickerFilter] = useState('');
  
  const [searchResultsTypeFilter, setSearchResultsTypeFilter] = useState<string>('all');

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const localInputRef = useRef<HTMLInputElement>(null);

  const isAnyJobProcessing = useMemo(() => 
    jobs.some(job => job.status === 'processing' || job.status === 'pending'),
    [jobs]
  );
  const jobsPollRef = useRef<NodeJS.Timeout | null>(null);
  const selectedCount = selectedFileIds.size;
  const effectiveSelectedCount = fileSource === 'upload' ? localFiles.length : selectedCount;

  const isFolderMime = useCallback((mimeType: string) => mimeType === 'application/vnd.google-apps.folder', []);
  
  const isAlmaFolderName = useCallback((name: string): boolean => {
    const n = name.toLowerCase();
    return n.startsWith('alma_') || n.startsWith('alma-');
  }, []);

  const isAlmaRootFolderNameStrict = useCallback((name: string): boolean => {
    const n = name.toLowerCase();
    return /^alma_.+_\d{13}$/.test(n);
  }, []);

  const INTERNAL_ALMA_FOLDER_NAMES = useMemo(() => {
    return new Set([
      '_corpus',
      '_summaries',
      '_reports',
      '_agents',
      '_templates',
      '_config',
      'report_creation_corpus',
      '.alma_rag',
    ]);
  }, []);

  const SUPPORTED_EXTENSION_TOKENS = useMemo(() => {
    return new Set<string>([
      'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'rtf',
      'txt', 'md', 'html', 'htm', 'csv', 'tsv', 'xml',
      'json', 'yaml', 'yml',
      'py', 'js', 'ts', 'jsx', 'tsx', 'java', 'c', 'cpp', 'h', 'hpp',
      'go', 'rs', 'rb', 'php', 'swift', 'kt', 'scala', 'r',
      'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd',
      'sql', 'graphql',
      'css', 'scss', 'sass', 'less',
    ]);
  }, []);

  const typePickerOptions = useMemo(() => {
    const options: Array<{ id: string; label: string; kind: 'folder' | 'file_ext' }> = [
      { id: 'any', label: 'Anything (no type filter)', kind: 'folder' },
      { id: 'almaRoot', label: 'ALMA project folder (alma_…)', kind: 'folder' },
      { id: 'folder', label: 'Folder', kind: 'folder' },
      ...Array.from(SUPPORTED_EXTENSION_TOKENS)
        .sort((a, b) => a.localeCompare(b))
        .map((ext) => ({ id: ext, label: `${ext.toUpperCase()} (.${ext})`, kind: 'file_ext' as const })),
    ];

    const f = typePickerFilter.trim().toLowerCase();
    if (!f) return options;
    return options.filter((o) => o.id.toLowerCase().includes(f) || o.label.toLowerCase().includes(f));
  }, [SUPPORTED_EXTENSION_TOKENS, typePickerFilter]);

  const isDirectIdLookup = useMemo(() => {
    return /^[a-zA-Z0-9_-]{20,}$/.test((searchQuery || '').trim());
  }, [searchQuery]);

  const getEffectiveSearchQuery = useCallback(
    (raw: string): string => {
      const trimmed = (raw || '').trim();
      if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) return trimmed;

      if (searchMode === 'type') {
        if (!selectedSearchType) return '';
        if (selectedSearchType === 'almaRoot') return trimmed ? trimmed : 'alma_';
        if (selectedSearchType === 'folder') return trimmed;
        return `.${selectedSearchType.toLowerCase()}`;
      }

      return trimmed;
    },
    [searchMode, selectedSearchType]
  );

  const FILE_SEARCH_SUPPORTED_APPLICATION_MIME_TYPES = useMemo(() => {
    return new Set<string>([
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.oasis.opendocument.text',
      'application/json',
      'application/xml',
      'application/sql',
      'application/typescript',
      'application/ecmascript',
      'application/dart',
      'application/ms-java',
      'application/vnd.jupyter',
      'application/x-sh',
      'application/x-shellscript',
      'application/x-zsh',
      'application/x-csh',
      'application/x-powershell',
      'application/x-php',
      'application/x-tex',
      'application/x-latex',
      'application/zip',
    ]);
  }, []);

  const formatMimeLabel = useCallback((mimeType: string, name: string) => {
    if (mimeType === 'application/vnd.google-apps.folder') return 'Folder';
    if (mimeType === 'application/pdf') return 'PDF';
    if (mimeType === 'text/plain') return 'Text';
    if (mimeType === 'text/markdown') return 'Markdown';
    if (mimeType === 'text/html') return 'HTML';
    if (mimeType === 'text/csv') return 'CSV';
    if (mimeType === 'text/tab-separated-values') return 'TSV';
    if (mimeType === 'application/json') return 'JSON';
    if (mimeType === 'application/xml' || mimeType === 'text/xml') return 'XML';
    if (mimeType === 'application/msword') return 'DOC';
    if (mimeType === 'application/rtf') return 'RTF';
    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'DOCX';
    if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'PPTX';
    if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'XLSX';
    if (mimeType === 'application/vnd.ms-excel') return 'XLS';
    if (mimeType === 'application/vnd.google-apps.document') return 'Google Doc';
    if (mimeType === 'application/vnd.google-apps.spreadsheet') return 'Google Sheet';
    if (mimeType === 'application/vnd.google-apps.presentation') return 'Google Slides';
    const ext = name.includes('.') ? name.split('.').pop()?.toUpperCase() : undefined;
    return ext ? ext : mimeType;
  }, []);

  const ragSupport = useCallback((file: DriveFile) => {
    if (isFolderMime(file.mimeType)) return { supported: false, reason: 'Folder (navigate into it)' };

    if (file.mimeType === 'application/vnd.google-apps.document' || file.mimeType === 'application/vnd.google-apps.presentation') {
      return { supported: true, reason: 'Exported as PDF for File Search' };
    }
    if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
      return { supported: true, reason: 'Exported as CSV for File Search' };
    }

    if (file.mimeType.startsWith('text/')) return { supported: true, reason: undefined as string | undefined };
    if (FILE_SEARCH_SUPPORTED_APPLICATION_MIME_TYPES.has(file.mimeType)) return { supported: true, reason: undefined as string | undefined };

    return { supported: false, reason: 'Not supported by File Search' };
  }, [FILE_SEARCH_SUPPORTED_APPLICATION_MIME_TYPES, isFolderMime]);

  const selectedFilesForRequest = useMemo(() => Object.values(selectedFilesMeta), [selectedFilesMeta]);
  const selectedFilesList = useMemo(() => {
    const metas = Object.values(selectedFilesMeta);
    if (metas.length > 0) return metas;
    return Array.from(selectedFileIds).map((id) => ({ id, name: id, mimeType: 'application/octet-stream' } as DriveFile));
  }, [selectedFilesMeta, selectedFileIds]);

  const filteredSearchResults = useMemo(() => {
    let results = searchResults;

    if (searchFilter !== 'all') {
      results = results.filter((r) => {
        if (r.kind !== 'folder') return true;
        const isAlma = isAlmaFolderName(r.folder.name);
        return searchFilter === 'alma' ? isAlma : !isAlma;
      });
    }

    if (!showHiddenInternalFolders) {
      results = results.filter((r) => {
        if (r.kind !== 'folder') return true;
        const name = r.folder.name;
        if (name.startsWith('.')) return false;
        if (INTERNAL_ALMA_FOLDER_NAMES.has(name.toLowerCase())) return false;
        return true;
      });
    }

    if (searchResultsTypeFilter !== 'all') {
      results = results.filter((r) => {
        if (searchResultsTypeFilter === 'Folder') {
          return r.kind === 'folder';
        }
        if (r.kind === 'folder') return false;
        return formatMimeLabel(r.file.mimeType, r.file.name) === searchResultsTypeFilter;
      });
    }

    return results;
  }, [searchResults, searchFilter, showHiddenInternalFolders, isAlmaFolderName, INTERNAL_ALMA_FOLDER_NAMES, searchResultsTypeFilter, formatMimeLabel]);

  const searchResultsTypeOptions = useMemo(() => {
    const labels = new Set<string>();
    let hasFolder = false;
    for (const result of searchResults) {
      if (result.kind === 'folder') {
        hasFolder = true;
      } else {
        labels.add(formatMimeLabel(result.file.mimeType, result.file.name));
      }
    }
    const opts = Array.from(labels).sort((a, b) => a.localeCompare(b));
    if (hasFolder) opts.unshift('Folder');
    return opts;
  }, [searchResults, formatMimeLabel]);

  const fileTypeOptions = useMemo(() => {
    const labels = new Set<string>();
    let hasFolder = false;
    for (const item of folderItems) {
      if (isFolderMime(item.mimeType)) {
        hasFolder = true;
        continue;
      }
      labels.add(formatMimeLabel(item.mimeType, item.name));
    }
    const opts = Array.from(labels).sort((a, b) => a.localeCompare(b));
    if (hasFolder) opts.unshift('Folder');
    return opts;
  }, [folderItems, formatMimeLabel, isFolderMime]);

  const filteredFolderItems = useMemo(() => {
    if (fileTypeFilter === 'all') return folderItems;
    if (fileTypeFilter === 'Folder') {
      return folderItems.filter((item) => isFolderMime(item.mimeType));
    }
    return folderItems.filter((item) => {
      if (isFolderMime(item.mimeType)) return false;
      return formatMimeLabel(item.mimeType, item.name) === fileTypeFilter;
    });
  }, [fileTypeFilter, folderItems, formatMimeLabel, isFolderMime]);

  const getTimeMs = useCallback((item: DriveFile, field: 'created' | 'updated') => {
    const val = (item as unknown as Record<string, string>)[field === 'created' ? 'createdTime' : 'modifiedTime'];
    return val ? new Date(val).getTime() : 0;
  }, []);

  const sortedFolderItems = useMemo(() => {
    const items = [...filteredFolderItems];

    items.sort((a, b) => {
      const aFolder = isFolderMime(a.mimeType);
      const bFolder = isFolderMime(b.mimeType);
      if (fileTypeFilter === 'all' || fileTypeFilter === 'Folder') {
        if (aFolder && !bFolder) return -1;
        if (!aFolder && bFolder) return 1;
      }
      if (sortMode === 'name') {
        return a.name.localeCompare(b.name);
      }
      if (sortMode === 'size') {
        const sizeA = a.size ?? 0;
        const sizeB = b.size ?? 0;
        return sizeB - sizeA;
      }
      if (sortMode === 'created') {
        return getTimeMs(b, 'created') - getTimeMs(a, 'created');
      }
      return getTimeMs(b, 'updated') - getTimeMs(a, 'updated');
    });

    return items;
  }, [filteredFolderItems, fileTypeFilter, isFolderMime, sortMode, getTimeMs]);

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
      if (jobsPollRef.current) {
        clearInterval(jobsPollRef.current);
      }
    };
  }, []);

  const loadJobs = useCallback(async (showLoading: boolean = false) => {
    if (showLoading) {
      setLoadingJobs(true);
    }
    try {
      const response = await fetch('/api/rag/jobs');
      if (response.ok) {
        const data = await response.json();
        setJobs(data.jobs || []);
      }
    } catch (error) {
      console.error('Failed to load jobs:', error);
    } finally {
      if (showLoading) {
        setLoadingJobs(false);
      }
    }
  }, []);

  const loadCorpora = useCallback(async () => {
    setLoadingCorpora(true);
    try {
      const response = await fetch('/api/rag/corpora');
      if (response.ok) {
        const data = await response.json();
        setCorpora(data.corpora || []);
      }
    } catch (error) {
      console.error('Failed to load corpora:', error);
    } finally {
      setLoadingCorpora(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'jobs') {
      loadJobs(true);
      jobsPollRef.current = setInterval(() => loadJobs(false), 2000);
    } else {
      if (jobsPollRef.current) {
        clearInterval(jobsPollRef.current);
        jobsPollRef.current = null;
      }
    }
    return () => {
      if (jobsPollRef.current) {
        clearInterval(jobsPollRef.current);
      }
    };
  }, [activeTab, loadJobs]);

  useEffect(() => {
    if (activeTab === 'corpora' || activeTab === 'project') {
      loadCorpora();
    }
  }, [activeTab, loadCorpora]);

  useEffect(() => {
    if (!expandedJobId) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/rag/jobs/${expandedJobId}/files`);
        if (!res.ok) return;
        const data = await res.json();
        const files = (data.files || []) as Array<{
          fileId: string;
          name: string;
          mimeType: string;
          size: number;
          status: 'pending' | 'indexing' | 'indexed' | 'error' | 'skipped';
          error?: string;
          indexedAt?: string;
        }>;

        if (cancelled) return;

        setJobFilesFromRegistry((prev) => ({
          ...prev,
          [expandedJobId]: files.map((f) => ({
            id: f.fileId,
            name: f.name,
            mimeType: f.mimeType,
            size: f.size,
            status: f.status,
            error: f.error,
            updatedAt: f.indexedAt,
          })),
        }));
      } catch (e) {
        console.warn('Failed to fetch job files from registry', e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [expandedJobId]);

  const cancelJob = useCallback(async (jobId: string) => {
    if (!confirm('Are you sure you want to stop this job? This cannot be undone.')) {
      return;
    }
    try {
      const response = await fetch(`/api/rag/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      });
      if (response.ok) {
        loadJobs();
      } else {
        const data = await response.json();
        alert(`Failed to cancel job: ${data.error}`);
      }
    } catch (error) {
      console.error('Failed to cancel job:', error);
      alert('Failed to cancel job');
    }
  }, [loadJobs]);

  const restartJob = useCallback(async (jobId: string) => {
    try {
      const response = await fetch(`/api/rag/jobs/${jobId}/restart`, {
        method: 'POST',
      });
      if (response.ok) {
        const data = await response.json();
        alert(`Job restarted successfully! New job ID: ${data.newJobId}`);
        loadJobs();
      } else {
        const data = await response.json();
        alert(`Failed to restart job: ${data.error}`);
      }
    } catch (error) {
      console.error('Failed to restart job:', error);
      alert('Failed to restart job');
    }
  }, [loadJobs]);

  const skipJobFile = useCallback(async (jobId: string, fileId: string) => {
    try {
      const response = await fetch(`/api/rag/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'skip_file', fileId }),
      });
      if (response.ok) {
        loadJobs();
      } else {
        const data = await response.json();
        alert(`Failed to stop file: ${data.error}`);
      }
    } catch (error) {
      console.error('Failed to stop file:', error);
      alert('Failed to stop file');
    }
  }, [loadJobs]);

  const startSingleFileJob = useCallback(async (
    job: JobStatus,
    file: { id: string; name: string; mimeType: string; size?: number },
    mode: 'start' | 'restart'
  ) => {
    try {
      const displayName =
        mode === 'restart'
          ? `${job.displayName} • ${file.name} (Retry)`
          : `${job.displayName} • ${file.name}`;

      const response = await fetch('/api/rag/jobs/start-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folderId: job.folderId,
          displayName,
          file: { ...file, size: file.size ?? 0 },
        }),
      });

      if (response.ok) {
        const data = await response.json();
        alert(`Started single-file job! Job ID: ${data.jobId}`);
        loadJobs();
      } else {
        const data = await response.json();
        alert(`Failed to start single-file job: ${data.error}`);
      }
    } catch (error) {
      console.error('Failed to start single-file job:', error);
      alert('Failed to start single-file job');
    }
  }, [loadJobs]);

  const deleteJobFromRegistry = useCallback(async (jobId: string) => {
    if (!confirm('Are you sure you want to delete this job record? This is permanent.')) {
      return;
    }
    try {
      const response = await fetch(`/api/rag/jobs/${jobId}`, {
        method: 'DELETE',
      });
      if (response.ok) {
        loadJobs();
      } else {
        const data = await response.json();
        alert(`Failed to delete job: ${data.error}`);
      }
    } catch (error) {
      console.error('Failed to delete job:', error);
      alert('Failed to delete job');
    }
  }, [loadJobs]);

  const searchFolders = useCallback(async () => {
    const effectiveQuery = getEffectiveSearchQuery(searchQuery);
    
    if (searchMode === 'type' && selectedSearchType === 'folder' && !searchQuery.trim()) {
      alert('Folder type search needs a name term (we avoid global folder search).');
      return;
    }
    if (!effectiveQuery) return;
    
    setSearching(true);
    try {
      const response = await fetch(`/api/rag/drive/search?q=${encodeURIComponent(effectiveQuery)}`);
      if (response.ok) {
        const data = await response.json();
        let folders: DriveFolder[] = data.folders || [];
        let files: DriveFile[] = data.files || [];
        
        if (searchMode === 'type' && selectedSearchType && !isDirectIdLookup) {
          if (selectedSearchType === 'almaRoot') {
            folders = folders.filter((f) => isAlmaRootFolderNameStrict(f.name));
            files = [];
          } else if (selectedSearchType === 'folder') {
            files = [];
          } else {
            const ext = selectedSearchType.toLowerCase();
            files = files.filter((f) => f.name.toLowerCase().endsWith(`.${ext}`));
            folders = [];
          }
        }
        
        setSearchResults([
          ...folders.map((folder) => ({ kind: 'folder' as const, folder })),
          ...files.map((file) => ({ kind: 'file' as const, file })),
        ]);
      } else {
        console.error('Search failed');
      }
    } catch (error) {
      console.error('Search error:', error);
    } finally {
      setSearching(false);
    }
  }, [searchQuery, searchMode, selectedSearchType, isDirectIdLookup, getEffectiveSearchQuery, isAlmaRootFolderNameStrict]);

  const loadFolderContents = useCallback(async (folderId: string) => {
    setLoadingFiles(true);
    try {
      const response = await fetch(`/api/rag/drive/folder/${folderId}`);
      if (response.ok) {
        const data = await response.json();
        setFolderItems(data.files || []);
        if (data.folder?.name) {
          setBreadcrumbs((prev) => {
            if (prev.length === 0) return prev;
            if (prev[prev.length - 1]?.id !== folderId) return prev;
            const next = [...prev];
            next[next.length - 1] = { id: folderId, name: data.folder.name };
            return next;
          });
        }
      }
    } catch (error) {
      console.error('Failed to load folder:', error);
    } finally {
      setLoadingFiles(false);
    }
  }, []);

  const loadFolder = useCallback(async (folder: DriveFolder) => {
    setSelectedFolder(folder);
    setCurrentFolderId(folder.id);
    setBreadcrumbs([{ id: folder.id, name: folder.name }]);
    setFolderItems([]);
    setSelectedFileIds(new Set());
    setSelectedFilesMeta({});
    await loadFolderContents(folder.id);
  }, [loadFolderContents]);

  const loadFileResult = useCallback(async (file: DriveFile) => {
    const parentId = file.parents?.[0];
    if (!parentId) {
      alert('This file has no parent folder and cannot be used for corpus creation.');
      return;
    }

    try {
      const response = await fetch(`/api/rag/drive/folder/${parentId}`);
      if (!response.ok) return;
      const data = await response.json();
      const folder: DriveFolder = data.folder || { id: parentId, name: 'Folder' };

      setSelectedFolder(folder);
      setCurrentFolderId(parentId);
      setBreadcrumbs([{ id: parentId, name: folder.name }]);
      setFolderItems(data.files || []);

      setSelectedFileIds((prev) => new Set(prev).add(file.id));
      setSelectedFilesMeta((prev) => ({ ...prev, [file.id]: file }));
    } catch (e) {
      console.error('Failed to load parent folder for file result', e);
    }
  }, []);

  const navigateToFolder = useCallback(async (folderId: string, folderName: string) => {
    setCurrentFolderId(folderId);
    setBreadcrumbs((prev) => [...prev, { id: folderId, name: folderName }]);
    await loadFolderContents(folderId);
  }, [loadFolderContents]);

  const navigateToBreadcrumb = useCallback(async (index: number) => {
    const newCrumbs = breadcrumbs.slice(0, index + 1);
    const target = newCrumbs[newCrumbs.length - 1];
    if (!target) return;
    setBreadcrumbs(newCrumbs);
    setCurrentFolderId(target.id);
    await loadFolderContents(target.id);
  }, [breadcrumbs, loadFolderContents]);

  const toggleFile = useCallback((file: DriveFile) => {
    setSelectedFileIds((prev) => {
      const next = new Set(prev);
      if (next.has(file.id)) {
        next.delete(file.id);
      } else {
        next.add(file.id);
      }
      return next;
    });

    setSelectedFilesMeta((prev) => {
      const next = { ...prev };
      if (next[file.id]) {
        delete next[file.id];
      } else {
        next[file.id] = file;
      }
      return next;
    });
  }, []);

  const deselectById = useCallback((fileId: string) => {
    setSelectedFileIds((prev) => {
      const next = new Set(prev);
      next.delete(fileId);
      return next;
    });
    setSelectedFilesMeta((prev) => {
      if (!prev[fileId]) return prev;
      const next = { ...prev };
      delete next[fileId];
      return next;
    });
  }, []);

  const isSupportedLocalFile = useCallback((file: File): boolean => {
    const ext = file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() : undefined;
    if (ext && LOCAL_UPLOAD_EXTENSIONS.includes(ext)) return true;
    // Browsers often report an empty MIME for code/markdown; fall back to text/*.
    return file.type.startsWith('text/');
  }, []);

  const addLocalFiles = useCallback(async (incoming: FileList | null) => {
    if (!incoming) return;
    const accepted: File[] = [];
    const skipped: string[] = [];

    for (const file of Array.from(incoming)) {
      if (file.size > MAX_LOCAL_FILE_SIZE_BYTES) {
        skipped.push(`"${file.name}" — over the 30MB limit`);
        continue;
      }
      if (!isSupportedLocalFile(file)) {
        skipped.push(`"${file.name}" — unsupported file type`);
        continue;
      }
      accepted.push(file);
    }

    // Free the input immediately so re-selecting the same file after a block still fires.
    if (localInputRef.current) localInputRef.current.value = '';

    // Preflight: scan-detect PDFs at selection so a scanned/image-only PDF (no searchable
    // text layer — Gemini File Search does no OCR) is blocked here instead of failing
    // mid-import. Fail-open: only a confident 'scanned' verdict blocks; parse errors don't.
    const pdfs = accepted.filter((f) => f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/pdf');
    const stageable = accepted.filter((f) => !pdfs.includes(f));
    const blocked: string[] = [];

    if (pdfs.length > 0) {
      console.log(`🔎 [preflight] checking ${pdfs.length} PDF(s):`, pdfs.map((f) => f.name));
      setLocalChecking(true);
      try {
        const { classifyPdfFile } = await import('@/app/lib/rag/pdfClassifier.client');
        for (const pdf of pdfs) {
          const verdict = await classifyPdfFile(pdf);
          if (verdict.kind === 'scanned') blocked.push(pdf.name);
          else stageable.push(pdf);
        }
      } catch (err) {
        // Never lose files if the classifier chunk fails to load — stage them and
        // let the server preflight catch scans as the fallback.
        console.error('🔎 [preflight] classifier unavailable — staging PDFs unchecked:', err);
        stageable.push(...pdfs);
      } finally {
        setLocalChecking(false);
      }
    }

    if (stageable.length > 0) {
      setLocalFiles((prev) => {
        const seen = new Set(prev.map((f) => `${f.name}::${f.size}`));
        const deduped = stageable.filter((f) => !seen.has(`${f.name}::${f.size}`));
        return deduped.length > 0 ? [...prev, ...deduped] : prev;
      });
    }

    // Scanned PDFs are surfaced in a dedicated panel with Adobe fix-it steps.
    setLocalBlockedScans((prev) => {
      const merged = new Set([...prev, ...blocked]);
      return Array.from(merged);
    });

    // List every rejected file (not just the last), so a mostly-successful batch
    // doesn't read as a total failure. Accepted files still stage normally.
    if (skipped.length > 0) {
      const staged = stageable.length;
      const prefix =
        staged > 0
          ? `Added ${staged} file${staged === 1 ? '' : 's'}. Skipped ${skipped.length}:`
          : `Skipped ${skipped.length} file${skipped.length === 1 ? '' : 's'}:`;
      setLocalUploadError(`${prefix}\n${skipped.join('\n')}`);
    } else {
      setLocalUploadError(null);
    }
  }, [isSupportedLocalFile]);

  const handleLocalDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setLocalDragActive(true);
    else if (e.type === 'dragleave') setLocalDragActive(false);
  }, []);

  const handleLocalDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setLocalDragActive(false);
    if (creating) return;
    addLocalFiles(e.dataTransfer.files);
  }, [addLocalFiles, creating]);

  const removeLocalFile = useCallback((index: number) => {
    setLocalFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const copyError = useCallback(() => {
    if (!errorDetails) return;
    
    const errorText = JSON.stringify(errorDetails, null, 2);
    navigator.clipboard.writeText(errorText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [errorDetails]);

  const copyText = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, []);

  const openInDrive = useCallback(() => {
    if (!currentFolderId) return;
    window.open(`https://drive.google.com/drive/folders/${currentFolderId}`, '_blank', 'noopener,noreferrer');
  }, [currentFolderId]);

  useEffect(() => {
    if (corpusMode === 'existing' && corpora.length === 0 && activeTab === 'add') {
      loadCorpora();
    }
  }, [corpusMode, activeTab, corpora.length, loadCorpora]);

  const pollJob = useCallback((jobId: string, mode: 'new' | 'existing') => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);

    // If the job can't be found / reached for several polls in a row, the
    // instance that owned it is gone (in-memory registry) — stop polling and
    // surface an error instead of looping forever.
    let consecutiveMisses = 0;
    const MAX_CONSECUTIVE_MISSES = 4;

    pollIntervalRef.current = setInterval(async () => {
      try {
        const statusRes = await fetch(`/api/rag/jobs/${jobId}`);
        if (statusRes.ok) {
          consecutiveMisses = 0;
          const job = await statusRes.json();

          if (job.status === 'completed') {
            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
            loadCorpora();
            setUploadNotice({
              tone: 'success',
              message:
                mode === 'existing'
                  ? 'Files added to the corpus successfully.'
                  : `Corpus "${job.displayName}" created successfully.`,
            });
          } else if (job.status === 'completed_with_errors') {
            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
            loadCorpora();
            setUploadNotice({
              tone: 'warning',
              message:
                (mode === 'existing'
                  ? 'Files added, with some skipped. '
                  : `Corpus "${job.displayName}" created, with some files skipped. `) +
                'The successfully processed files are in the corpus — see the Jobs tab log for details.',
            });
          } else if (job.status === 'failed') {
            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
            setErrorDetails(job.errorDetails || { message: job.error });
            setShowErrorModal(true);
          }
        } else {
          consecutiveMisses += 1;
          if (consecutiveMisses >= MAX_CONSECUTIVE_MISSES) {
            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
            // Not a failure: the job likely lives on another instance (in-memory
            // registry + multi-instance deploy). Indexing is probably still running.
            setUploadNotice({
              tone: 'warning',
              message:
                'Lost live track of the indexing job (the server may have scaled or restarted). ' +
                'Indexing is likely still running — check the Corpora tab shortly, and retry any missing files.',
            });
          }
        }
      } catch (e) {
        console.error('Polling failed', e);
        consecutiveMisses += 1;
        if (consecutiveMisses >= MAX_CONSECUTIVE_MISSES) {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setUploadNotice({
            tone: 'warning',
            message: 'Lost connection while tracking the indexing job. Refresh and check the Corpora tab — indexing may have finished.',
          });
        }
      }
    }, 5000);
  }, [loadCorpora]);

  const createCorpus = useCallback(async () => {
    if (corpusMode === 'existing' && !selectedExistingCorpusId) {
      alert('Please select an existing corpus');
      return;
    }
    // A brand-new corpus must belong to a project so it lands in the shared project file.
    if (corpusMode === 'new' && !createProjectId) {
      alert('Please select a project for this corpus');
      return;
    }

    // Local upload source: send the staged files as multipart/form-data.
    if (fileSource === 'upload') {
      if (localFiles.length === 0) {
        alert('Please add at least one file');
        return;
      }
      if (corpusMode === 'new' && !corpusName.trim()) {
        alert('Please provide a corpus name');
        return;
      }

      setCreating(true);
      setUploadProgress(0);
      setUploadNotice(null);
      try {
        const formData = new FormData();
        formData.append('mode', corpusMode);
        formData.append('allowPartialSuccess', String(allowPartialSuccess));
        if (corpusMode === 'existing') {
          formData.append('existingCorpusId', selectedExistingCorpusId!);
        } else {
          formData.append('displayName', corpusName.trim());
          formData.append('projectId', createProjectId);
        }
        localFiles.forEach((file) => formData.append('file', file));

        const response = await uploadWithProgress('/api/rag/corpora/local', formData, setUploadProgress);

        const body = response.body;
        if (response.ok && body && typeof body === 'object' && 'jobId' in body && typeof body.jobId === 'string') {
          setUploadNotice({
            tone: 'info',
            message: 'Upload complete. Indexing started in the background — track live progress here in the Jobs tab.',
          });

          if (corpusMode === 'new') setCorpusName('');
          setLocalFiles([]);
          setLocalUploadError(null);
          setLocalBlockedScans([]);
          setUploadProgress(null);
          setCreating(false);
          setActiveTab('jobs');
          loadJobs(true);
          pollJob(body.jobId, corpusMode);
        } else {
          setUploadProgress(null);
          setCreating(false);
          const details =
            body && typeof body === 'object'
              ? ('error' in body && body.error) || ('details' in body && body.details) || body
              : body ?? { message: `Upload failed (HTTP ${response.status})` };
          setErrorDetails(details);
          setShowErrorModal(true);
        }
      } catch (error) {
        console.error('Create corpus (upload) error:', error);
        setUploadProgress(null);
        setCreating(false);
        setErrorDetails({
          message: error instanceof Error ? error.message : 'Unknown error occurred',
          stack: error instanceof Error ? error.stack : undefined,
          timestamp: new Date().toISOString(),
        });
        setShowErrorModal(true);
      }
      return;
    }

    // Google Drive source.
    if (selectedFileIds.size === 0) {
      alert('Please select at least one file');
      return;
    }
    if (corpusMode === 'new' && (!corpusName.trim() || !selectedFolder)) {
      alert('Please provide a corpus name and select a folder');
      return;
    }

    setCreating(true);
    try {
      const requestBody: Record<string, unknown> = {
        mode: corpusMode,
        selectedFileIds: Array.from(selectedFileIds),
        allowPartialSuccess,
        files: selectedFilesForRequest.map((f) => {
          const fileWithRange = {
            ...f,
            size: f.size ?? 0,
            pageRange: pdfPageRanges[f.id] || undefined,
          };
          if (pdfPageRanges[f.id]) {
            console.log(`📄 [PageRange] Sending file ${f.name} with range: pages ${pdfPageRanges[f.id].startPage}-${pdfPageRanges[f.id].endPage}`);
          }
          return fileWithRange;
        }),
      };
      if (corpusMode === 'existing') {
        requestBody.existingCorpusId = selectedExistingCorpusId;
      } else {
        requestBody.displayName = corpusName.trim();
        requestBody.folderId = selectedFolder!.id;
        requestBody.projectId = createProjectId;
      }

      const response = await fetch('/api/rag/corpora', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (response.ok) {
        const { jobId } = await response.json();
        setUploadNotice({
          tone: 'info',
          message: 'Indexing started in the background. Track live progress here in the Jobs tab — you can leave this page.',
        });

        if (corpusMode === 'new') setCorpusName('');
        setSelectedFileIds(new Set());
        setSelectedFilesMeta({});
        setPdfPageRanges({});
        setCreating(false);
        setActiveTab('jobs');
        loadJobs(true);

        pollJob(jobId, corpusMode);
      } else {
        setCreating(false);
        const data = await response.json();
        setErrorDetails(data.details || data);
        setShowErrorModal(true);
      }
    } catch (error) {
      console.error('Create corpus error:', error);
      setCreating(false);
      setErrorDetails({
        message: error instanceof Error ? error.message : 'Unknown error occurred',
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString(),
      });
      setShowErrorModal(true);
    }
  }, [fileSource, localFiles, corpusMode, corpusName, createProjectId, selectedFileIds, selectedFolder, selectedExistingCorpusId, selectedFilesForRequest, pdfPageRanges, allowPartialSuccess, pollJob, loadJobs]);

  const deleteCorpus = async (corpusId: string) => {
    if (!confirm('Are you sure you want to delete this corpus? This action cannot be undone.')) {
      return;
    }

    setDeleting(corpusId);
    try {
      const res = await fetch(`/api/rag/corpora/${corpusId}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        setCorpora((prev) => prev.filter((c) => c.id !== corpusId));
      } else {
        console.error('Failed to delete corpus:', res.statusText);
        alert('Failed to delete corpus');
      }
    } catch (error) {
      console.error('Error deleting corpus:', error);
      alert('Error deleting corpus');
    } finally {
      setDeleting(null);
    }
  };

  const verifyCorpus = async (corpusId: string) => {
    setVerifyingCorpusId(corpusId);
    setVerifyError((prev) => ({ ...prev, [corpusId]: null }));
    try {
      const res = await fetch(`/api/rag/corpora/${corpusId}/verify`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Verification failed');
      setCorpora((prev) =>
        prev.map((c) => (c.id === corpusId ? { ...c, verification: data.verification } : c)),
      );
      setExpandedCorpusId(corpusId);
    } catch (error) {
      setVerifyError((prev) => ({
        ...prev,
        [corpusId]: error instanceof Error ? error.message : 'Verification failed',
      }));
    } finally {
      setVerifyingCorpusId(null);
    }
  };

  // User-triggered QA probe: run one query and report whether the corpus returns
  // readable grounded content (catches scanned/empty corpora that imported "ok").
  const probeCorpus = async (corpusId: string) => {
    setProbingCorpusId(corpusId);
    setProbeResult((prev) => { const next = { ...prev }; delete next[corpusId]; return next; });
    try {
      const res = await fetch(`/api/rag/corpora/${corpusId}/qa-probe`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Check failed');
      setProbeResult((prev) => ({ ...prev, [corpusId]: { ok: data.ok, chunkCount: data.chunkCount, charCount: data.charCount, sample: data.sample } }));
      setExpandedCorpusId(corpusId);
    } catch (error) {
      setProbeResult((prev) => ({ ...prev, [corpusId]: { error: error instanceof Error ? error.message : 'Check failed' } }));
    } finally {
      setProbingCorpusId(null);
    }
  };

  const healCorpus = async (
    corpusId: string,
    fileIds?: string[],
    pdfNameOverrides?: Record<string, string>,
  ) => {
    setHealingCorpusId(corpusId);
    setVerifyError((prev) => ({ ...prev, [corpusId]: null }));
    try {
      const res = await fetch(`/api/rag/corpora/${corpusId}/heal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileIds, pdfNameOverrides }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Self-heal failed');
      setCorpora((prev) =>
        prev.map((c) => (c.id === corpusId ? { ...c, verification: data.verification } : c)),
      );
      if (Array.isArray(data.failures) && data.failures.length > 0) {
        setVerifyError((prev) => ({
          ...prev,
          [corpusId]: `${data.failures.length} file(s) could not be healed (check they still exist in Drive).`,
        }));
      }
      setEditingFileKey(null);
      setEditingPdfName('');
    } catch (error) {
      setVerifyError((prev) => ({
        ...prev,
        [corpusId]: error instanceof Error ? error.message : 'Self-heal failed',
      }));
    } finally {
      setHealingCorpusId(null);
    }
  };

  const startEditing = (corpus: Corpus) => {
    setEditingCorpusId(corpus.id);
    setEditingName(corpus.displayName);
  };

  const cancelEditing = () => {
    setEditingCorpusId(null);
    setEditingName('');
  };

  const saveRename = async (corpusId: string) => {
    if (!editingName.trim()) {
      alert('Name cannot be empty');
      return;
    }

    try {
      const res = await fetch(`/api/rag/corpora/${corpusId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: editingName }),
      });

      if (res.ok) {
        setCorpora((prev) =>
          prev.map((c) =>
            c.id === corpusId ? { ...c, displayName: editingName } : c
          )
        );
        setEditingCorpusId(null);
        setEditingName('');
      } else {
        console.error('Failed to rename corpus:', res.statusText);
        alert('Failed to rename corpus');
      }
    } catch (error) {
      console.error('Error renaming corpus:', error);
      alert('Error renaming corpus');
    }
  };

  if (!session) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <p className="text-gray-600 dark:text-gray-400">Please sign in to manage RAG corpora</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white p-6">
      {}
      {showInstructions && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-start justify-center z-50 p-4 pt-16 overflow-y-auto">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-lg font-semibold" style={{ color: '#11074A' }}>
                How to build a RAG corpus from Drive
              </h3>
              <button
                onClick={() => setShowInstructions(false)}
                className="text-gray-500 hover:text-gray-700"
                title="Close"
              >
                <FaTimes size={20} />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <div className="font-semibold text-gray-900 mb-2">Quick steps</div>
                <ol className="list-decimal ml-5 space-y-2 text-gray-700">
                  <li>
                    <span className="font-medium">Create a folder</span> in Google Drive.
                  </li>
                  <li>
                    <span className="font-medium">Drop the documents</span> you want to parse into that folder (use “Open in Drive” to drag &amp; drop).
                  </li>
                  <li>
                    <span className="font-medium">Paste a folder or file name/ID</span> into “Search Drive Folder / File”.
                  </li>
                  <li>
                    <span className="font-medium">Navigate subfolders</span>, select/deselect files, and only pick files marked “Supported”.
                  </li>
                  <li>
                    <span className="font-medium">Create corpus</span> (runs as a background job).
                  </li>
                </ol>
              </div>

              <div className="text-sm text-gray-600">
                File support is based on common formats supported by Gemini file ingestion + what our backend can download/export from Drive (Google Docs/Sheets/Slides are exported for ingestion).
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex justify-end">
              <button
                onClick={() => setShowInstructions(false)}
                className="px-4 py-2 text-white rounded-lg hover:opacity-90 transition-opacity"
                style={{ backgroundColor: '#11074A' }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {}
      {showSupportedTypes && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-start justify-center z-50 p-4 pt-16 overflow-y-auto">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-lg font-semibold" style={{ color: '#11074A' }}>
                Supported file types for ingestion
              </h3>
              <button
                onClick={() => setShowSupportedTypes(false)}
                className="text-gray-500 hover:text-gray-700"
                title="Close"
              >
                <FaTimes size={20} />
              </button>
            </div>
            <div className="p-6 space-y-4 text-gray-700">
              <div className="text-sm text-gray-600">
                Based on Google’s File Search docs (`https://ai.google.dev/gemini-api/docs/file-search`).
                Google Workspace files are exported server-side (Docs/Slides → PDF, Sheets → CSV).
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <div className="border border-gray-200 rounded-lg p-3">
                  <div className="font-semibold mb-1">Documents</div>
                  <div>PDF, DOC, DOCX, DOTX, ODT</div>
                  <div className="text-xs text-gray-500 mt-1">Google Docs/Slides exported as PDF.</div>
                </div>
                <div className="border border-gray-200 rounded-lg p-3">
                  <div className="font-semibold mb-1">Spreadsheets</div>
                  <div>XLS, XLSX, CSV</div>
                  <div className="text-xs text-gray-500 mt-1">Google Sheets exported as CSV.</div>
                </div>
                <div className="border border-gray-200 rounded-lg p-3">
                  <div className="font-semibold mb-1">Text / Web / Code</div>
                  <div>All `text/*` (e.g., TXT, Markdown, HTML, CSS, JS, TSX, Python, …)</div>
                </div>
                <div className="border border-gray-200 rounded-lg p-3">
                  <div className="font-semibold mb-1">Data</div>
                  <div>JSON, XML, SQL, TypeScript, ECMAScript</div>
                </div>
                <div className="border border-gray-200 rounded-lg p-3 sm:col-span-2">
                  <div className="font-semibold mb-1">Archives</div>
                  <div>ZIP</div>
                </div>
              </div>

              <div className="text-xs text-gray-500">
                “Supported” means it matches the File Search supported MIME types and we can download/export it from Drive.
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex justify-end">
              <button
                onClick={() => setShowSupportedTypes(false)}
                className="px-4 py-2 text-white rounded-lg hover:opacity-90 transition-opacity"
                style={{ backgroundColor: '#11074A' }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {}
      {pageRangeModalFile && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full overflow-hidden">
            {}
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-lg font-semibold flex items-center gap-2" style={{ color: '#11074A' }}>
                <FaFilePdf className="text-red-500" />
                Configure Page Range
              </h3>
              <button
                onClick={() => {
                  setPageRangeModalFile(null);
                  setTempStartPage('');
                  setTempEndPage('');
                }}
                className="text-gray-500 hover:text-gray-700"
              >
                <FaTimes size={20} />
              </button>
            </div>
            
            {}
            <div className="p-6">
              <div className="mb-4">
                <div className="text-sm font-medium text-gray-900 truncate mb-1">
                  {pageRangeModalFile.name}
                </div>
                <div className="text-xs text-gray-500">
                  Leave empty to include all pages. Set a range to only process specific pages.
                </div>
              </div>
              
              <div className="flex gap-4 items-center">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Start Page
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={tempStartPage}
                    onChange={(e) => setTempStartPage(e.target.value)}
                    placeholder="1"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div className="text-gray-400 pt-6">to</div>
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    End Page
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={tempEndPage}
                    onChange={(e) => setTempEndPage(e.target.value)}
                    placeholder="Last"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              </div>
              
              {pdfPageRanges[pageRangeModalFile.id] && (
                <div className="mt-3 text-sm text-blue-600">
                  Current range: pages {pdfPageRanges[pageRangeModalFile.id].startPage} - {pdfPageRanges[pageRangeModalFile.id].endPage}
                </div>
              )}
            </div>
            
            {}
            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex justify-between">
              {pdfPageRanges[pageRangeModalFile.id] && (
                <button
                  onClick={() => {
                    setPdfPageRanges(prev => {
                      const next = { ...prev };
                      delete next[pageRangeModalFile.id];
                      return next;
                    });
                    setPageRangeModalFile(null);
                    setTempStartPage('');
                    setTempEndPage('');
                  }}
                  className="px-4 py-2 text-red-600 border border-red-200 rounded-lg hover:bg-red-50"
                >
                  Clear Range
                </button>
              )}
              <div className="flex gap-2 ml-auto">
                <button
                  onClick={() => {
                    setPageRangeModalFile(null);
                    setTempStartPage('');
                    setTempEndPage('');
                  }}
                  className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    const start = parseInt(tempStartPage) || 1;
                    const end = parseInt(tempEndPage) || 999999;
                    if (start > 0 && end >= start) {
                      setPdfPageRanges(prev => ({
                        ...prev,
                        [pageRangeModalFile.id]: { startPage: start, endPage: end }
                      }));
                    }
                    setPageRangeModalFile(null);
                    setTempStartPage('');
                    setTempEndPage('');
                  }}
                  className="px-4 py-2 text-white rounded-lg hover:opacity-90"
                  style={{ backgroundColor: '#11074A' }}
                >
                  Save Range
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {}
      {showErrorModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[80vh] overflow-hidden flex flex-col">
            {}
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between bg-white">
              <h3 className="text-lg font-semibold" style={{ color: '#11074A' }}>
                Error Creating Corpus
              </h3>
              <button
                onClick={() => {
                  setShowErrorModal(false);
                  setErrorDetails(null);
                  setCopied(false);
                }}
                className="text-gray-500 hover:text-gray-700"
              >
                <FaTimes size={20} />
              </button>
            </div>
            
            {}
            <div className="p-6 overflow-y-auto flex-1">
              <p className="text-gray-700 mb-4">
                An error occurred while creating the corpus. Details below:
              </p>
              
              <div className="relative">
                <button
                  onClick={copyError}
                  className="absolute top-2 right-2 px-3 py-2 text-white rounded text-sm flex items-center gap-2 transition-colors z-10"
                  style={{ backgroundColor: '#11074A' }}
                  title="Copy error details"
                >
                  {copied ? (
                    <>
                      <FaCheckCircle size={14} />
                      Copied
                    </>
                  ) : (
                    <>
                      <FaCopy size={14} />
                      Copy
                    </>
                  )}
                </button>
                
                <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-sm font-mono border border-gray-700">
                  <code>{JSON.stringify(errorDetails, null, 2)}</code>
                </pre>
              </div>
            </div>
            
            {}
            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex justify-end">
              <button
                onClick={() => {
                  setShowErrorModal(false);
                  setErrorDetails(null);
                  setCopied(false);
                }}
                className="px-4 py-2 text-white rounded-lg hover:opacity-90 transition-opacity"
                style={{ backgroundColor: '#11074A' }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      
      <div className="max-w-7xl mx-auto" data-tour="rag-corpus-manager">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl font-bold flex items-center gap-2" style={{ color: '#11074A' }}>
            <FaBrain style={{ color: '#11074A' }} />
            RAG Corpus Manager
          </h1>
        </div>

        {}
        <div className="flex border-b border-gray-200 mb-6">
          <button
            onClick={() => setActiveTab('add')}
            className={`relative px-6 py-3 text-sm font-medium transition-colors ${
              activeTab === 'add'
                ? 'text-gray-900 bg-white'
                : 'text-gray-500 hover:text-gray-700 bg-gray-100 hover:bg-gray-50'
            }`}
            style={{
              borderTopLeftRadius: '8px',
              borderTopRightRadius: '8px',
              marginRight: '2px',
              ...(activeTab === 'add' ? {
                borderTop: '1px solid #e5e7eb',
                borderLeft: '1px solid #e5e7eb',
                borderRight: '1px solid #e5e7eb',
                borderBottom: '2px solid white',
                marginBottom: '-1px',
              } : {}),
            }}
          >
            <span className="flex items-center gap-2">
              <FaPlus size={14} />
              Add
            </span>
          </button>
          <button
            onClick={() => setActiveTab('jobs')}
            className={`relative px-6 py-3 text-sm font-medium transition-colors ${
              activeTab === 'jobs'
                ? 'text-gray-900 bg-white'
                : 'text-gray-500 hover:text-gray-700 bg-gray-100 hover:bg-gray-50'
            }`}
            style={{
              borderTopLeftRadius: '8px',
              borderTopRightRadius: '8px',
              ...(activeTab === 'jobs' ? {
                borderTop: '1px solid #e5e7eb',
                borderLeft: '1px solid #e5e7eb',
                borderRight: '1px solid #e5e7eb',
                borderBottom: '2px solid white',
                marginBottom: '-1px',
              } : {}),
            }}
          >
            <span className="flex items-center gap-2">
              <FaClipboardList size={14} />
              Jobs
              {jobs.filter(j => j.status === 'pending' || j.status === 'processing').length > 0 && (
                <span className="ml-1 px-2 py-0.5 text-xs rounded-full bg-blue-100 text-blue-700">
                  {jobs.filter(j => j.status === 'pending' || j.status === 'processing').length}
                </span>
              )}
            </span>
          </button>
          <button
            onClick={() => setActiveTab('corpora')}
            className={`relative px-6 py-3 text-sm font-medium transition-colors ${
              activeTab === 'corpora'
                ? 'text-gray-900 bg-white'
                : 'text-gray-500 hover:text-gray-700 bg-gray-100 hover:bg-gray-50'
            }`}
            style={{
              borderTopLeftRadius: '8px',
              borderTopRightRadius: '8px',
              ...(activeTab === 'corpora'
                ? {
                    borderTop: '1px solid #e5e7eb',
                    borderLeft: '1px solid #e5e7eb',
                    borderRight: '1px solid #e5e7eb',
                    borderBottom: '2px solid white',
                    marginBottom: '-1px',
                  }
                : {}),
            }}
          >
            <span className="flex items-center gap-2">
              <FaFolder size={14} />
              Corpora
            </span>
          </button>
          <button
            onClick={() => setActiveTab('project')}
            className={`relative px-6 py-3 text-sm font-medium transition-colors ${
              activeTab === 'project'
                ? 'text-gray-900 bg-white'
                : 'text-gray-500 hover:text-gray-700 bg-gray-100 hover:bg-gray-50'
            }`}
            style={{
              borderTopLeftRadius: '8px',
              borderTopRightRadius: '8px',
              ...(activeTab === 'project'
                ? {
                    borderTop: '1px solid #e5e7eb',
                    borderLeft: '1px solid #e5e7eb',
                    borderRight: '1px solid #e5e7eb',
                    borderBottom: '2px solid white',
                    marginBottom: '-1px',
                  }
                : {}),
            }}
          >
            <span className="flex items-center gap-2">
              <FaClipboardList size={14} />
              Project Corpuses
            </span>
          </button>
        </div>

        {uploadNotice && (
          <div
            className={`mb-6 rounded-lg border px-4 py-3 flex items-start gap-3 text-sm ${
              uploadNotice.tone === 'success'
                ? 'bg-green-50 border-green-200 text-green-800'
                : uploadNotice.tone === 'warning'
                  ? 'bg-amber-50 border-amber-200 text-amber-800'
                  : uploadNotice.tone === 'error'
                    ? 'bg-red-50 border-red-200 text-red-800'
                    : 'bg-blue-50 border-blue-200 text-blue-800'
            }`}
            role="status"
          >
            {uploadNotice.tone === 'success' ? (
              <FaCheckCircle className="mt-0.5 flex-shrink-0" />
            ) : uploadNotice.tone === 'info' ? (
              <FaInfoCircle className="mt-0.5 flex-shrink-0" />
            ) : (
              <FaExclamationTriangle className="mt-0.5 flex-shrink-0" />
            )}
            <span className="flex-1">{uploadNotice.message}</span>
            <button
              type="button"
              onClick={() => setUploadNotice(null)}
              className="flex-shrink-0 opacity-60 hover:opacity-100"
              aria-label="Dismiss"
            >
              <FaTimes size={14} />
            </button>
          </div>
        )}

        {}
        {activeTab === 'jobs' && (
          <div className="bg-white rounded-lg shadow-md border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold" style={{ color: '#11074A' }}>
                Background Jobs
              </h2>
              <button
                onClick={() => loadJobs(true)}
                disabled={loadingJobs}
                className="px-3 py-2 text-white rounded-lg disabled:opacity-50 flex items-center gap-2 text-sm"
                style={{ backgroundColor: '#11074A' }}
              >
                {loadingJobs ? <FaSpinner className="animate-spin" /> : <FaSyncAlt />}
                Refresh
              </button>
            </div>

            {loadingJobs && jobs.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <FaSpinner className="animate-spin text-2xl text-gray-400" />
              </div>
            ) : jobs.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                No jobs found. Create a corpus to start a background job.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className="text-left py-3 px-4 font-semibold text-gray-700">Status</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-700">Name</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-700">Progress</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-700">Current</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-700">Updated</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-700">Actions</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-700">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map((job) => {
                      const isExpanded = expandedJobId === job.jobId;
                      const statusColors: Record<string, { bg: string; text: string; border: string }> = {
                        pending: { bg: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-200' },
                        processing: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200' },
                        completed: { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200' },
                        failed: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' },
                        completed_with_errors: { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200' },
                        cancelled: { bg: 'bg-gray-50', text: 'text-gray-700', border: 'border-gray-300' },
                      };
                      const colors = statusColors[job.status] || statusColors.pending;
                      const canStop = job.status === 'pending' || job.status === 'processing';
                      const canRestart = ['failed', 'cancelled', 'completed_with_errors'].includes(job.status);
                      
                      return (
                        <React.Fragment key={job.jobId}>
                          <tr className="border-b border-gray-100 hover:bg-gray-50">
                            <td className="py-3 px-4">
                              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${colors.bg} ${colors.text} ${colors.border}`}>
                                {job.status === 'processing' && <FaSpinner className="animate-spin" size={10} />}
                                {job.status === 'completed' && <FaCheck size={10} />}
                                {job.status === 'failed' && <FaTimes size={10} />}
                                {job.status === 'completed_with_errors' && <FaExclamationTriangle size={10} />}
                                {job.status === 'cancelled' && <FaBan size={10} />}
                                {job.status.replace(/_/g, ' ')}
                              </span>
                            </td>
                            <td className="py-3 px-4">
                              <div className="font-medium text-gray-900">{job.displayName}</div>
                              <div className="text-xs text-gray-400 font-mono truncate max-w-xs" title={job.jobId}>
                                {job.jobId}
                              </div>
                            </td>
                            <td className="py-3 px-4">
                              <div className="flex items-center gap-2">
                                <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden max-w-24">
                                  <div
                                    className={`h-full transition-all ${
                                      job.status === 'failed' ? 'bg-red-500' :
                                      job.status === 'completed_with_errors' ? 'bg-orange-500' :
                                      job.status === 'completed' ? 'bg-green-500' : 'bg-blue-500'
                                    }`}
                                    style={{ width: `${job.totalFiles > 0 ? (job.processedFiles / job.totalFiles) * 100 : 0}%` }}
                                  />
                                </div>
                                <span className="text-xs text-gray-500 whitespace-nowrap">
                                  {job.processedFiles}/{job.totalFiles}
                                </span>
                              </div>
                            </td>
                            <td className="py-3 px-4">
                              {job.status === 'processing' && job.currentOperation ? (
                                <div className="text-xs">
                                  <div className="text-blue-600 font-medium truncate max-w-32" title={job.currentOperation}>
                                    {job.currentOperation.replace(/_/g, ' ')}
                                  </div>
                                  {job.currentFile && (
                                    <div className="text-gray-500 truncate max-w-32" title={job.currentFile}>
                                      {job.currentFile}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <span className="text-xs text-gray-400">-</span>
                              )}
                            </td>
                            <td className="py-3 px-4 text-gray-600 whitespace-nowrap">
                              {new Date(job.updatedAt).toLocaleString()}
                            </td>
                            <td className="py-3 px-4">
                              <div className="flex items-center gap-1">
                                {canStop && (
                                  <button
                                    onClick={() => cancelJob(job.jobId)}
                                    className="p-1.5 text-xs text-red-600 hover:bg-red-50 rounded border border-red-200"
                                    title="Stop job"
                                  >
                                    <FaStop size={12} />
                                  </button>
                                )}
                                {canRestart && (
                                  <button
                                    onClick={() => restartJob(job.jobId)}
                                    disabled={isAnyJobProcessing}
                                    className="p-1.5 text-xs text-blue-600 hover:bg-blue-50 rounded border border-blue-200 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                                    title={isAnyJobProcessing ? 'Wait for current job to finish' : 'Restart job'}
                                  >
                                    <FaRedo size={12} />
                                  </button>
                                )}
                                <button
                                  onClick={() => deleteJobFromRegistry(job.jobId)}
                                  className="p-1.5 text-xs text-gray-500 hover:bg-gray-100 rounded border border-gray-200"
                                  title="Delete job record"
                                >
                                  <FaTrash size={12} />
                                </button>
                              </div>
                            </td>
                            <td className="py-3 px-4">
                              <button
                                onClick={() => setExpandedJobId(isExpanded ? null : job.jobId)}
                                className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50 flex items-center gap-1"
                              >
                                {isExpanded ? <FaAngleUp /> : <FaAngleDown />}
                                {isExpanded ? 'Hide' : 'Show'}
                              </button>
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr className="bg-gray-50">
                              <td colSpan={7} className="py-4 px-4">
                                <div className="space-y-4">
                                  {}
                                  <div className="grid grid-cols-2 gap-4 text-sm">
                                    <div>
                                      <div className="font-medium text-gray-700 mb-1">Job ID</div>
                                      <code className="text-xs bg-gray-100 px-2 py-1 rounded text-gray-600 block overflow-x-auto">
                                        {job.jobId}
                                      </code>
                                    </div>
                                    {job.corpusId && (
                                      <div>
                                        <div className="font-medium text-gray-700 mb-1">Corpus ID</div>
                                        <code className="text-xs bg-gray-100 px-2 py-1 rounded text-gray-600 block overflow-x-auto">
                                          {job.corpusId}
                                        </code>
                                      </div>
                                    )}
                                    <div>
                                      <div className="font-medium text-gray-700 mb-1">Folder ID</div>
                                      <code className="text-xs bg-gray-100 px-2 py-1 rounded text-gray-600 block overflow-x-auto">
                                        {job.folderId}
                                      </code>
                                    </div>
                                  </div>

                                  {}
                                  <div>
                                    <div className="font-medium text-gray-700 mb-2">Files</div>
                                    {(() => {
                                      let rows =
                                        job.files && job.files.length > 0
                                          ? job.files
                                          : jobFilesFromRegistry[job.jobId] && jobFilesFromRegistry[job.jobId]!.length > 0
                                            ? jobFilesFromRegistry[job.jobId]!
                                          : (job.selectedFiles || []).map((f) => ({
                                              ...f,
                                              status: 'pending' as const,
                                              error: undefined,
                                            }));

                                      const allPending = rows.length > 0 && rows.every((f) => f.status === 'pending');
                                      if (allPending && job.processedFiles > 0) {
                                        const isFinal = ['completed', 'failed', 'completed_with_errors', 'cancelled'].includes(job.status);
                                        rows = rows.map((f, idx) => {
                                          if (idx < job.processedFiles) {
                                            return { ...f, status: 'indexed' as const };
                                          }
                                          if (!isFinal && idx === job.processedFiles && job.status === 'processing') {
                                            return { ...f, status: 'indexing' as const };
                                          }
                                          if (isFinal && job.status === 'cancelled') {
                                            return { ...f, status: 'skipped' as const, error: 'Job cancelled' };
                                          }
                                          if (isFinal && (job.status === 'failed' || job.status === 'completed_with_errors')) {
                                            if (idx === job.processedFiles) {
                                              return { ...f, status: 'error' as const, error: job.error || 'Failed' };
                                            }
                                            return { ...f, status: 'pending' as const };
                                          }
                                          return { ...f, status: 'pending' as const };
                                        });
                                      }

                                      if (rows.length === 0) {
                                        return <div className="text-sm text-gray-500">No file details available for this job.</div>;
                                      }

                                      const fileStatusColors: Record<string, { bg: string; text: string; border: string }> = {
                                        pending: { bg: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-200' },
                                        indexing: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200' },
                                        indexed: { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200' },
                                        error: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' },
                                        skipped: { bg: 'bg-gray-50', text: 'text-gray-700', border: 'border-gray-300' },
                                      };

                                      return (
                                        <div className="overflow-x-auto">
                                          <table className="w-full text-xs border border-gray-200 rounded">
                                            <thead className="bg-white">
                                              <tr className="border-b border-gray-200">
                                                <th className="text-left py-2 px-3 font-semibold text-gray-700">File</th>
                                                <th className="text-left py-2 px-3 font-semibold text-gray-700">Status</th>
                                                <th className="text-left py-2 px-3 font-semibold text-gray-700">Actions</th>
                                              </tr>
                                            </thead>
                                            <tbody className="bg-white">
                                              {rows.map((f) => {
                                                const colors = fileStatusColors[f.status] || fileStatusColors.pending;
                                                const canStopFile =
                                                  (job.status === 'pending' || job.status === 'processing') &&
                                                  (f.status === 'pending' || f.status === 'indexing');
                                                const canRestartFile = f.status === 'error' || f.status === 'skipped';
                                                const canStartFile = f.status === 'pending';

                                                return (
                                                  <tr key={f.id} className="border-b border-gray-100">
                                                    <td className="py-2 px-3">
                                                      <div className="font-medium text-gray-900 truncate max-w-[420px]" title={f.name}>
                                                        {f.name}
                                                      </div>
                                                      <div className="text-[10px] text-gray-400 font-mono truncate max-w-[420px]" title={f.id}>
                                                        {f.id}
                                                      </div>
                                                      {f.error && (
                                                        <div className="text-[10px] text-red-600 mt-1 truncate max-w-[420px]" title={f.error}>
                                                          {f.error}
                                                        </div>
                                                      )}
                                                    </td>
                                                    <td className="py-2 px-3">
                                                      <span
                                                        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-medium border ${colors.bg} ${colors.text} ${colors.border}`}
                                                      >
                                                        {f.status === 'indexing' && <FaSpinner className="animate-spin" size={10} />}
                                                        {f.status === 'indexed' && <FaCheck size={10} />}
                                                        {f.status === 'error' && <FaTimes size={10} />}
                                                        {f.status === 'skipped' && <FaBan size={10} />}
                                                        {f.status}
                                                      </span>
                                                    </td>
                                                    <td className="py-2 px-3">
                                                      <div className="flex items-center gap-1 flex-wrap">
                                                        {canStopFile && (
                                                          <button
                                                            onClick={() => skipJobFile(job.jobId, f.id)}
                                                            className="px-2 py-1 text-[10px] text-red-600 hover:bg-red-50 rounded border border-red-200"
                                                            title="Stop this file (best-effort). If already uploading/indexing, it may finish; otherwise it will be skipped."
                                                          >
                                                            <span className="inline-flex items-center gap-1">
                                                              <FaStop size={10} /> Stop
                                                            </span>
                                                          </button>
                                                        )}
                                                        {(canRestartFile || canStartFile) && (
                                                          <button
                                                            onClick={() =>
                                                              startSingleFileJob(
                                                                job,
                                                                { id: f.id, name: f.name, mimeType: f.mimeType, size: f.size },
                                                                canRestartFile ? 'restart' : 'start'
                                                              )
                                                            }
                                                            disabled={isAnyJobProcessing}
                                                            className="px-2 py-1 text-[10px] text-blue-600 hover:bg-blue-50 rounded border border-blue-200 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                                                            title={isAnyJobProcessing ? 'Wait for current job to finish' : 'Run this file as its own job (useful for retrying a single PDF).'}
                                                          >
                                                            <span className="inline-flex items-center gap-1">
                                                              <FaRedo size={10} /> {canRestartFile ? 'Restart' : 'Start'}
                                                            </span>
                                                          </button>
                                                        )}
                                                      </div>
                                                    </td>
                                                  </tr>
                                                );
                                              })}
                                            </tbody>
                                          </table>
                                        </div>
                                      );
                                    })()}
                                  </div>

                                  {}
                                  {job.status === 'processing' && job.currentOperation && (
                                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                                      <div className="font-medium text-blue-700 mb-2 flex items-center gap-2">
                                        <FaSpinner className="animate-spin" size={14} />
                                        Current Operation
                                      </div>
                                      <div className="text-sm text-blue-800">
                                        <span className="font-medium">{job.currentOperation.replace(/_/g, ' ')}</span>
                                        {job.currentFile && (
                                          <span className="text-blue-600 ml-2">
                                            - {job.currentFile}
                                            {job.currentFileIndex && job.totalFiles && (
                                              <span className="text-blue-500 ml-1">
                                                ({job.currentFileIndex}/{job.totalFiles})
                                              </span>
                                            )}
                                          </span>
                                        )}
                                      </div>
                                      {(job.totalChunks ?? 0) > 0 && (
                                        <div className="mt-3">
                                          <div className="flex items-center gap-2">
                                            <div className="flex-1 h-2 bg-blue-100 rounded-full overflow-hidden">
                                              <div
                                                className="h-full bg-blue-500 transition-all"
                                                style={{ width: `${((job.processedChunks ?? 0) / (job.totalChunks || 1)) * 100}%` }}
                                              />
                                            </div>
                                            <span className="text-xs text-blue-600 whitespace-nowrap">
                                              {job.processedChunks ?? 0}/{job.totalChunks} sections{job.totalFiles > 1 ? ` · ${job.totalFiles} files` : ''}
                                            </span>
                                          </div>
                                        </div>
                                      )}
                                      {job.startedAt && (
                                        <div className="text-xs text-blue-500 mt-2">
                                          Started: {new Date(job.startedAt).toLocaleString()}
                                        </div>
                                      )}
                                    </div>
                                  )}

                                  {}
                                  {job.logs && job.logs.length > 0 && (
                                    <div>
                                      <div className="font-medium text-gray-700 mb-2 flex items-center gap-2">
                                        <FaClipboardList size={14} />
                                        Activity Log ({job.logs.length} entries)
                                      </div>
                                      <div className="bg-gray-900 rounded-lg p-3 max-h-48 overflow-y-auto font-mono text-xs">
                                        {job.logs.map((log, idx) => {
                                          const levelColors = {
                                            info: 'text-blue-400',
                                            warn: 'text-yellow-400',
                                            error: 'text-red-400',
                                          };
                                          const color = levelColors[log.level] || levelColors.info;
                                          return (
                                            <div key={idx} className="flex gap-2 py-0.5">
                                              <span className="text-gray-500 whitespace-nowrap">
                                                {new Date(log.timestamp).toLocaleTimeString()}
                                              </span>
                                              <span className={`uppercase font-semibold ${color} w-12`}>
                                                {log.level}
                                              </span>
                                              <span className="text-gray-300 flex-1">
                                                {log.message}
                                              </span>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  )}

                                  {}
                                  <div className="grid grid-cols-3 gap-4 text-xs text-gray-500">
                                    <div>
                                      <span className="font-medium">Created:</span> {new Date(job.createdAt).toLocaleString()}
                                    </div>
                                    {job.startedAt && (
                                      <div>
                                        <span className="font-medium">Started:</span> {new Date(job.startedAt).toLocaleString()}
                                      </div>
                                    )}
                                    <div>
                                      <span className="font-medium">Updated:</span> {new Date(job.updatedAt).toLocaleString()}
                                    </div>
                                  </div>

                                  {}
                                  {(job.error != null || job.errorDetails != null) && (
                                    <div>
                                      <div className="font-medium text-red-700 mb-2">Error Information</div>
                                      {job.error != null && (
                                        <div className="text-sm text-red-600 mb-2 bg-red-50 px-3 py-2 rounded border border-red-200">
                                          {job.error}
                                        </div>
                                      )}
                                      {job.errorDetails != null && (
                                        <pre className="text-xs bg-gray-900 text-gray-100 p-3 rounded overflow-x-auto max-h-48 overflow-y-auto">
                                          {JSON.stringify(job.errorDetails, null, 2)}
                                        </pre>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {}
        {activeTab === 'corpora' && (
          <div className="bg-white rounded-lg shadow-md border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold" style={{ color: '#11074A' }}>
                Your Corpora
              </h2>
              <button
                onClick={loadCorpora}
                disabled={loadingCorpora}
                className="px-3 py-2 text-white rounded-lg disabled:opacity-50 flex items-center gap-2 text-sm"
                style={{ backgroundColor: '#11074A' }}
              >
                {loadingCorpora ? <FaSpinner className="animate-spin" /> : <FaSyncAlt />}
                Refresh
              </button>
            </div>

            <div className="space-y-4">
              {corpora.length === 0 && !loadingCorpora && (
                <p className="text-gray-500 text-center py-8">
                  No corpora yet. Create one in the Add tab.
                </p>
              )}

              {corpora.map((corpus) => (
                <div
                  key={corpus.id}
                  className="border border-gray-300 rounded-lg p-4"
                >
                  <div className="flex items-start gap-3">
                    <button
                      type="button"
                      onClick={() => setExpandedCorpusId((prev) => (prev === corpus.id ? null : corpus.id))}
                      className="mt-1 flex-shrink-0 p-1 rounded hover:bg-gray-100 transition-colors"
                      title={expandedCorpusId === corpus.id ? 'Collapse files' : 'Expand to see files'}
                      aria-expanded={expandedCorpusId === corpus.id}
                    >
                      {expandedCorpusId === corpus.id ? (
                        <FaAngleUp className="text-gray-600" size={16} />
                      ) : (
                        <FaAngleDown className="text-gray-600" size={16} />
                      )}
                    </button>
                    <div className="flex-1 min-w-0">
                      {editingCorpusId === corpus.id ? (
                        <div className="mb-2">
                          <input
                            type="text"
                            value={editingName}
                            onChange={(e) => setEditingName(e.target.value)}
                            className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
                            autoFocus
                          />
                          <div className="flex gap-2 mt-2">
                            <button
                              onClick={() => saveRename(corpus.id)}
                              className="px-3 py-1 text-xs text-white rounded"
                              style={{ backgroundColor: '#11074A' }}
                            >
                              Save
                            </button>
                            <button
                              onClick={cancelEditing}
                              className="px-3 py-1 text-xs bg-gray-500 text-white rounded"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <h3 className="font-semibold text-gray-900 truncate">
                          {corpus.displayName}
                        </h3>
                      )}
                      <p className="text-sm text-gray-600">
                        Source: {corpus.source?.folderName ?? 'Unknown'}
                      </p>
                      <p className="text-sm text-gray-500">
                        {corpus.files?.length ?? 0} files • Created {new Date(corpus.createdAt).toLocaleDateString()}
                      </p>
                      <p className="text-xs text-gray-400 mt-1 font-mono truncate">
                        ID: {corpus.id}
                      </p>
                    </div>
                    {editingCorpusId !== corpus.id && (
                      <div className="flex items-center gap-2">
                        {corpus.verification && (
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium border ${
                              corpus.verification.status === 'verified'
                                ? 'bg-green-50 text-green-700 border-green-200'
                                : 'bg-amber-50 text-amber-700 border-amber-200'
                            }`}
                            title={`Checked ${new Date(corpus.verification.checkedAt).toLocaleString()}`}
                          >
                            {corpus.verification.status === 'verified' ? (
                              <>
                                <FaCheck size={9} /> Verified
                              </>
                            ) : (
                              <>
                                <FaExclamationTriangle size={9} /> {corpus.verification.issueCount} issue
                                {corpus.verification.issueCount === 1 ? '' : 's'}
                              </>
                            )}
                          </span>
                        )}
                        <button
                          onClick={() => verifyCorpus(corpus.id)}
                          disabled={verifyingCorpusId === corpus.id || healingCorpusId === corpus.id}
                          className="px-2 py-1 text-xs text-gray-600 hover:text-gray-800 hover:underline disabled:opacity-50 flex items-center gap-1"
                          title="Check that each file's chunks carry a correct pdf_name (used by document-scoped queries)"
                        >
                          {verifyingCorpusId === corpus.id ? (
                            <FaSpinner className="animate-spin" size={10} />
                          ) : (
                            <FaShieldAlt size={10} />
                          )}
                          Verify
                        </button>
                        <button
                          onClick={() => probeCorpus(corpus.id)}
                          disabled={probingCorpusId === corpus.id}
                          className="px-2 py-1 text-xs text-gray-600 hover:text-gray-800 hover:underline disabled:opacity-50 flex items-center gap-1"
                          title="Run a quick test query to check this corpus returns readable, grounded content"
                        >
                          {probingCorpusId === corpus.id ? (
                            <FaSpinner className="animate-spin" size={10} />
                          ) : (
                            <FaClipboardList size={10} />
                          )}
                          Check
                        </button>
                        <button
                          onClick={() => startEditing(corpus)}
                          className="px-2 py-1 text-xs text-gray-600 hover:text-gray-800 hover:underline"
                        >
                          Rename
                        </button>
                        <button
                          onClick={() => deleteCorpus(corpus.id)}
                          disabled={deleting === corpus.id}
                          className="px-2 py-1 text-xs text-red-600 hover:text-red-800 hover:underline disabled:opacity-50"
                        >
                          {deleting === corpus.id ? 'Deleting...' : 'Delete'}
                        </button>
                      </div>
                    )}
                  </div>

                  {probeResult[corpus.id] && (() => {
                    const r = probeResult[corpus.id]!;
                    if ('error' in r) {
                      return <div className="mt-2 text-xs text-red-600">Check failed: {r.error}</div>;
                    }
                    return r.ok ? (
                      <div className="mt-2 text-xs text-green-700">✅ Readable — {r.chunkCount} chunk(s) grounded. Sample: “{r.sample.slice(0, 120)}{r.sample.length > 120 ? '…' : ''}”</div>
                    ) : (
                      <div className="mt-2 text-xs text-amber-700">⚠️ No grounded content returned — this corpus is likely scanned/empty or still indexing. If it&apos;s a scanned PDF, OCR it and re-upload (see the OCR help below).</div>
                    );
                  })()}

                  {}
                  {expandedCorpusId === corpus.id && (corpus.files?.length ?? 0) > 0 && (
                    <div className="mt-4 pt-3 border-t border-gray-200">
                      <div className="font-medium text-gray-700 mb-2">Files in corpus</div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs border border-gray-200 rounded">
                          <thead className="bg-gray-50">
                            <tr className="border-b border-gray-200">
                              <th className="text-left py-2 px-3 font-semibold text-gray-700">File</th>
                              <th className="text-left py-2 px-3 font-semibold text-gray-700">Status</th>
                            </tr>
                          </thead>
                          <tbody className="bg-white">
                            {corpus.files.map((f, idx) => {
                              const status = (f as { status?: string }).status ?? f.status ?? 'unknown';
                              const name = (f as { name?: string }).name ?? (typeof f === 'string' ? f : `File ${idx + 1}`);
                              const fileStatusColors: Record<string, { bg: string; text: string; border: string }> = {
                                pending: { bg: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-200' },
                                indexing: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200' },
                                indexed: { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200' },
                                error: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' },
                                skipped: { bg: 'bg-gray-50', text: 'text-gray-700', border: 'border-gray-300' },
                              };
                              const colors = fileStatusColors[status] ?? fileStatusColors.pending;
                              return (
                                <tr key={idx} className="border-b border-gray-100 last:border-b-0">
                                  <td className="py-2 px-3">
                                    <div className="font-medium text-gray-900 truncate max-w-[420px]" title={name}>
                                      {name}
                                    </div>
                                    {(f as { error?: string }).error && (
                                      <div className="text-[10px] text-red-600 mt-0.5 max-w-[460px]" title={(f as { error?: string }).error}>
                                        {(f as { error?: string }).error}
                                      </div>
                                    )}
                                  </td>
                                  <td className="py-2 px-3">
                                    <span
                                      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-medium border ${colors.bg} ${colors.text} ${colors.border}`}
                                    >
                                      {status === 'indexing' && <FaSpinner className="animate-spin" size={10} />}
                                      {status === 'indexed' && <FaCheck size={10} />}
                                      {status === 'error' && <FaTimes size={10} />}
                                      {status === 'skipped' && <FaBan size={10} />}
                                      {status}
                                    </span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      {corpus.files.some((f) => { const e = (f as { error?: string }).error; return typeof e === 'string' && /scan|ocr/i.test(e); }) && (
                        <details className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                          <summary className="cursor-pointer font-medium">How to make a scanned PDF searchable (OCR)</summary>
                          <div className="mt-2 space-y-1">
                            <p>A scanned PDF is a picture of the text, so search can&apos;t read it. Rebuild it as a searchable PDF, then re-upload.</p>
                            <p className="font-medium mt-1">Adobe Acrobat (recommended):</p>
                            <ol className="list-decimal ml-5 space-y-0.5">
                              <li>Open the PDF in Acrobat.</li>
                              <li>Go to <strong>Tools → Scan &amp; OCR</strong>.</li>
                              <li>Choose <strong>Recognize Text → In This File</strong>.</li>
                              <li>Pick the document language, then <strong>Recognize Text</strong>.</li>
                              <li><strong>Save</strong> the file and re-upload it here.</li>
                            </ol>
                            <p className="mt-1">No Acrobat? Free options: upload the PDF to Google Drive → <em>Open with Google Docs</em> (it OCRs the text), or use a reputable online OCR service, then export/save a text-based PDF and re-upload.</p>
                          </div>
                        </details>
                      )}
                    </div>
                  )}

                  {expandedCorpusId === corpus.id && (!corpus.files || corpus.files.length === 0) && (
                    <div className="mt-4 pt-3 border-t border-gray-200 text-sm text-gray-500">
                      No file details available for this corpus.
                    </div>
                  )}

                  {expandedCorpusId === corpus.id && (
                    <div className="mt-4 pt-3 border-t border-gray-200">
                      <div className="flex items-center justify-between mb-2">
                        <div className="font-medium text-gray-700">Metadata verification</div>
                        {corpus.verification && corpus.verification.status === 'needs_repair' && (
                          <button
                            onClick={() => healCorpus(corpus.id)}
                            disabled={healingCorpusId === corpus.id}
                            className="px-3 py-1 text-xs text-white rounded flex items-center gap-1 disabled:opacity-50"
                            style={{ backgroundColor: '#11074A' }}
                            title="Re-import every flagged file from Drive with a correct pdf_name"
                          >
                            {healingCorpusId === corpus.id ? (
                              <FaSpinner className="animate-spin" size={10} />
                            ) : (
                              <FaWrench size={10} />
                            )}
                            Self-heal all
                          </button>
                        )}
                      </div>

                      {verifyError[corpus.id] && (
                        <div className="text-xs text-red-600 mb-2">{verifyError[corpus.id]}</div>
                      )}

                      {!corpus.verification ? (
                        <div className="text-xs text-gray-500">
                          Not verified yet. Click <b>Verify</b> to check that each file&apos;s chunks
                          carry a correct <code className="font-mono">pdf_name</code> (used by
                          document-scoped queries).
                        </div>
                      ) : corpus.verification.issueCount === 0 ? (
                        <div className="text-xs text-green-700 flex items-center gap-1">
                          <FaCheck size={10} /> All {corpus.verification.okCount} file(s) have correct
                          metadata.
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <div className="text-xs text-gray-600">
                            {corpus.verification.issueCount} file(s) have a metadata problem that makes
                            document-scoped queries silently return nothing. Fixing re-imports the file
                            from Drive with the correct <code className="font-mono">pdf_name</code>.
                          </div>
                          {corpus.verification.files
                            .filter((f) => f.issue !== 'ok')
                            .map((f) => {
                              const key = `${corpus.id}:${f.fileId}`;
                              const issueLabel =
                                f.issue === 'missing_pdf_name'
                                  ? 'Chunks are missing a pdf_name'
                                  : f.issue === 'pdf_name_mismatch'
                                    ? `Stored as ${f.foundPdfNames.map((n) => `"${n}"`).join(', ') || '(none)'} — expected "${f.name}"`
                                    : f.issue === 'no_chunks'
                                      ? 'No chunks found in the store'
                                      : `${f.failedChunks} chunk(s) failed to index`;
                              const isEditing = editingFileKey === key;
                              const busy = healingCorpusId === corpus.id;
                              return (
                                <div
                                  key={f.fileId}
                                  className="border border-amber-200 bg-amber-50 rounded p-2"
                                >
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                      <div
                                        className="font-medium text-gray-900 truncate max-w-[360px]"
                                        title={f.name}
                                      >
                                        {f.name}
                                      </div>
                                      <div className="text-[11px] text-amber-700">{issueLabel}</div>
                                    </div>
                                    <div className="flex-shrink-0 flex items-center gap-1">
                                      {!f.healable ? (
                                        <span className="text-[11px] text-gray-500">
                                          Not auto-healable — re-upload manually
                                        </span>
                                      ) : isEditing ? (
                                        <>
                                          <input
                                            type="text"
                                            value={editingPdfName}
                                            onChange={(e) => setEditingPdfName(e.target.value)}
                                            className="px-2 py-1 border border-gray-300 rounded text-xs w-52"
                                            placeholder="Correct pdf_name"
                                            autoFocus
                                          />
                                          <button
                                            onClick={() =>
                                              healCorpus(corpus.id, [f.fileId], {
                                                [f.fileId]: editingPdfName.trim(),
                                              })
                                            }
                                            disabled={busy || !editingPdfName.trim()}
                                            className="px-2 py-1 text-[11px] text-white rounded disabled:opacity-50"
                                            style={{ backgroundColor: '#11074A' }}
                                          >
                                            {busy ? 'Re-importing…' : 'Save & re-import'}
                                          </button>
                                          <button
                                            onClick={() => {
                                              setEditingFileKey(null);
                                              setEditingPdfName('');
                                            }}
                                            className="px-2 py-1 text-[11px] bg-gray-500 text-white rounded"
                                          >
                                            Cancel
                                          </button>
                                        </>
                                      ) : (
                                        <>
                                          <button
                                            onClick={() => healCorpus(corpus.id, [f.fileId])}
                                            disabled={busy}
                                            className="px-2 py-1 text-[11px] text-white rounded flex items-center gap-1 disabled:opacity-50"
                                            style={{ backgroundColor: '#11074A' }}
                                            title="Re-import with pdf_name = filename"
                                          >
                                            {busy ? (
                                              <FaSpinner className="animate-spin" size={9} />
                                            ) : (
                                              <FaWrench size={9} />
                                            )}
                                            Fix
                                          </button>
                                          <button
                                            onClick={() => {
                                              setEditingFileKey(key);
                                              setEditingPdfName(f.name);
                                            }}
                                            disabled={busy}
                                            className="px-2 py-1 text-[11px] text-gray-600 hover:text-gray-800 disabled:opacity-50"
                                            title="Edit pdf_name before re-importing"
                                          >
                                            <FaEdit size={11} />
                                          </button>
                                        </>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {}
        {activeTab === 'project' && (
          <div className="max-w-3xl">
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">Project</label>
              <select
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
              >
                <option value="">{projectsLoading ? 'Loading projects…' : 'Select a project…'}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.displayName || p.name}</option>
                ))}
              </select>
            </div>

            {!selectedProjectId ? (
              <p className="text-sm text-gray-500 italic">
                Select a project to see the corpuses linked to it.
              </p>
            ) : (
              <>
                {projectLinksError && (
                  <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {projectLinksError}
                  </div>
                )}

                <div className="mb-4 flex items-end gap-2">
                  <div className="flex-1">
                    <label className="block text-sm font-medium text-gray-700 mb-1">Link a corpus to this project</label>
                    <select
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                      value={linkCorpusId}
                      onChange={(e) => setLinkCorpusId(e.target.value)}
                    >
                      <option value="">Select a corpus…</option>
                      {corpora
                        .filter((c) => !projectLinks.some((l) => l.corpusId === c.id || l.corpusId === c.corpusId))
                        .map((c) => (
                          <option key={c.id} value={c.id}>{c.displayName}</option>
                        ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    onClick={handleAddProjectLink}
                    disabled={!linkCorpusId}
                    className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                  >
                    <span className="flex items-center gap-2"><FaPlus size={12} /> Add</span>
                  </button>
                </div>

                {projectLinksLoading ? (
                  <p className="text-sm text-gray-500">Loading project corpuses…</p>
                ) : projectLinks.length === 0 ? (
                  <p className="text-sm text-gray-500 italic">No corpuses linked to this project yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {projectLinks.map((link) => {
                      const hasOwner = Boolean((link.ownerEmail || '').trim());
                      const ownerEmailLc = (link.ownerEmail || '').toLowerCase();
                      const meLc = currentUserEmail.toLowerCase();
                      // Best-effort name: my registry → name stamped on the step → (unresolved).
                      const registryMatch = corpora.find((c) => c.id === link.corpusId || c.corpusId === link.corpusId);
                      const storedName = link.displayName && link.displayName !== link.corpusId ? link.displayName : '';
                      const resolvedName = registryMatch?.displayName || storedName;
                      const isUnresolved = !resolvedName;
                      const shortId = link.corpusId.length > 26
                        ? `${link.corpusId.slice(0, 16)}…${link.corpusId.slice(-6)}`
                        : link.corpusId;
                      const label = resolvedName || shortId;
                      // Attribution: explicit owner wins; empty owner that resolves from *my*
                      // registry is mine; otherwise it's another user's (name not reachable).
                      const isMine = hasOwner ? ownerEmailLc === meLc : !isUnresolved;
                      const ownerLabel = isMine
                        ? 'You'
                        : hasOwner
                          ? getDisplayNameFromEmail(link.ownerEmail || 'unknown')
                          : 'Another user';
                      // Empty-owner links are removable by anyone (backend); named owners are owner-only.
                      const canRemove = !hasOwner || ownerEmailLc === meLc;
                      const color = isMine ? OWN_USER_COLOR : colorForUser(link.ownerEmail || link.corpusId);
                      return (
                        <li
                          key={link.corpusId}
                          className="flex items-center justify-between rounded-lg px-3 py-2"
                          style={{
                            background: color.bg,
                            border: `2px solid ${PROJECT_LINK_BORDER}`,
                            color: color.text,
                          }}
                        >
                          <div className="min-w-0">
                            <div className="font-medium truncate" title={link.corpusId}>{label}</div>
                            <div className="text-xs opacity-75">
                              {ownerLabel}
                              {isUnresolved ? ' · name unavailable (its owner must open this tab)' : ''}
                            </div>
                          </div>
                          {canRemove ? (
                            <button
                              type="button"
                              onClick={() => handleRemoveProjectLink(link.corpusId, label)}
                              className="ml-3 flex-shrink-0 rounded-md border border-red-300 bg-white px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                              title="Remove this corpus from the project (detaches it from all steps)"
                            >
                              <span className="flex items-center gap-1"><FaTrash size={11} /> Remove</span>
                            </button>
                          ) : (
                            <span className="ml-3 flex-shrink-0 text-xs opacity-60" title="Only the corpus owner can remove it">
                              owner only
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </div>
        )}

        {}
        {activeTab === 'add' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch lg:h-[calc(100vh-220px)]">
          {}
          <div className="space-y-6 lg:min-h-0 lg:flex lg:flex-col">
            <div className="bg-white rounded-lg shadow-md border border-gray-200 p-6 lg:flex-1 lg:min-h-0 lg:flex lg:flex-col">
              <div className="flex items-center gap-2 mb-4">
                <h2 className="text-xl font-semibold" style={{ color: '#11074A' }}>
                  1. Search Drive Folder / File
                </h2>
                <button
                  onClick={() => setShowInstructions(true)}
                  className="p-2 rounded-lg border border-gray-300 hover:bg-gray-50"
                  title="Instructions"
                >
                  <FaInfoCircle />
                </button>
              </div>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && searchFolders()}
                    placeholder={
                      searchMode === 'type' && selectedSearchType && !isDirectIdLookup
                        ? `Type search: ${selectedSearchType === 'almaRoot' ? 'ALMA project folders' : selectedSearchType === 'folder' ? 'Folders (needs name)' : `.${selectedSearchType}`}`
                        : 'Folder name or Drive ID...'
                    }
                    className="w-full px-4 py-2 pr-11 border border-gray-300 rounded-lg"
                  />
                  <button
                    type="button"
                    onClick={() => setShowTypePicker((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7 grid place-items-center rounded-md hover:bg-gray-100"
                    style={{ backgroundColor: selectedSearchType ? '#f8f7ff' : 'transparent' }}
                    title="Search by type"
                  >
                    <FaSearch size={12} style={{ color: selectedSearchType ? '#11074A' : '#6b7280' }} />
                  </button>

                  {showTypePicker && (
                    <div className="absolute z-50 mt-2 w-full max-w-sm rounded-lg border border-gray-200 bg-white shadow-lg p-3">
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <div className="text-xs font-semibold" style={{ color: '#11074A' }}>
                          Search by type
                        </div>
                        <button
                          type="button"
                          onClick={() => setShowTypePicker(false)}
                          className="text-gray-500 hover:text-gray-700"
                          title="Close"
                        >
                          <FaTimes size={14} />
                        </button>
                      </div>

                      <input
                        type="text"
                        value={typePickerFilter}
                        onChange={(e) => setTypePickerFilter(e.target.value)}
                        placeholder="Filter types…"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm mb-2"
                      />

                      <div className="max-h-56 overflow-y-auto space-y-1 pr-1">
                        {typePickerOptions.map((opt) => {
                          const active =
                            (opt.id === 'any' && searchMode === 'name' && !selectedSearchType) ||
                            (selectedSearchType === opt.id && searchMode === 'type');
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              onClick={() => {
                                if (opt.id === 'any') {
                                  setSearchMode('name');
                                  setSelectedSearchType('');
                                } else {
                                  setSearchMode('type');
                                  setSelectedSearchType(opt.id);
                                }
                                setShowTypePicker(false);
                              }}
                              className="w-full text-left px-3 py-2 rounded-md border text-sm flex items-center justify-between gap-2 hover:bg-gray-50"
                              style={{
                                borderColor: active ? 'rgba(17, 7, 74, 0.45)' : '#e5e7eb',
                                backgroundColor: active ? '#f8f7ff' : 'white',
                              }}
                              title="Select type"
                            >
                              <span className="truncate">{opt.label}</span>
                              {active && (
                                <span className="text-[11px] font-semibold" style={{ color: '#11074A' }}>
                                  Active
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>

                      <div className="mt-2 flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setSearchMode('name');
                            setSelectedSearchType('');
                            setShowTypePicker(false);
                          }}
                          className="text-xs text-gray-600 hover:text-gray-900 hover:underline"
                          title="Back to normal name search"
                        >
                          Clear filter
                        </button>
                        <div className="text-[11px] text-gray-500">
                          Direct IDs always work
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <button
                  onClick={searchFolders}
                  disabled={searching}
                  className="px-4 py-2 text-white rounded-lg disabled:opacity-50 flex items-center gap-2"
                  style={{ backgroundColor: '#11074A' }}
                >
                  {searching ? <FaSpinner className="animate-spin" /> : <FaSearch />}
                  Search
                </button>
              </div>

              {searchResults.length > 0 && (
                <>
                  {}
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500">Type</span>
                      <select
                        value={searchResultsTypeFilter}
                        onChange={(e) => setSearchResultsTypeFilter(e.target.value)}
                        className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm bg-white"
                        title="Filter by type"
                      >
                        <option value="all">All ({searchResults.length})</option>
                        {searchResultsTypeOptions.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500">Folders</span>
                      <select
                        value={searchFilter}
                        onChange={(e) => setSearchFilter(e.target.value as typeof searchFilter)}
                        className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm bg-white"
                        title="Filter folders"
                      >
                        <option value="all">All</option>
                        <option value="alma">ALMA only</option>
                        <option value="regular">Regular only</option>
                      </select>
                    </div>

                    <label className="flex items-center gap-2 text-xs text-gray-600 select-none cursor-pointer">
                      <input
                        type="checkbox"
                        checked={showHiddenInternalFolders}
                        onChange={(e) => setShowHiddenInternalFolders(e.target.checked)}
                        className="w-4 h-4 rounded"
                      />
                      Show hidden
                      <span
                        className="text-gray-400 hover:text-gray-600 cursor-help"
                        title="Hidden folders include:&#10;• Folders starting with '.' (e.g., .alma_rag)&#10;• Internal ALMA folders: _corpus, _summaries, _reports, _agents, _templates, _config, report_creation_corpus"
                      >
                        <FaInfoCircle size={12} />
                      </span>
                    </label>

                    <span className="text-xs text-gray-400 ml-auto">
                      {filteredSearchResults.length} result{filteredSearchResults.length !== 1 ? 's' : ''}
                    </span>
                  </div>

                  <div className="mt-3 space-y-2 overflow-y-auto lg:flex-1 lg:min-h-0 pr-1">
                    {filteredSearchResults.map((result) => (
                      <div
                        key={result.kind === 'folder' ? result.folder.id : result.file.id}
                        onClick={() => {
                          if (result.kind === 'folder') loadFolder(result.folder);
                          else loadFileResult(result.file);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            if (result.kind === 'folder') loadFolder(result.folder);
                            else loadFileResult(result.file);
                          }
                        }}
                        role="button"
                        tabIndex={0}
                        className="w-full text-left px-4 py-3 rounded-lg border-2 transition-colors bg-white"
                        style={{
                          borderColor:
                            result.kind === 'folder' && selectedFolder?.id === result.folder.id ? '#11074A' : '#d1d5db',
                          backgroundColor:
                            result.kind === 'folder' && selectedFolder?.id === result.folder.id ? '#f3f4f6' : 'white',
                        }}
                      >
                        <div className="flex items-center gap-2">
                          {result.kind === 'folder' ? (
                            <div className="flex items-center gap-2">
                              <FaFolder className="text-yellow-600 flex-shrink-0" />
                              {isAlmaFolderName(result.folder.name) && (
                                <span
                                  className="px-2 py-0.5 rounded-full text-[11px] font-semibold border flex items-center gap-1 flex-shrink-0"
                                  style={{
                                    backgroundColor: '#f8f7ff',
                                    borderColor: 'rgba(17, 7, 74, 0.25)',
                                    color: '#11074A',
                                  }}
                                  title="ALMA project folder"
                                >
                                  <FaBrain size={10} />
                                  ALMA
                                </span>
                              )}
                            </div>
                          ) : (
                            <FaFileAlt className="text-gray-600 flex-shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="font-medium truncate" style={{ color: '#11074A' }}>
                              {result.kind === 'folder' ? result.folder.name : result.file.name}
                            </div>
                            {result.kind === 'folder' && result.folder.owners?.[0] && (
                              <div className="text-sm text-gray-500 truncate">
                                {result.folder.owners[0].displayName || result.folder.owners[0].emailAddress}
                              </div>
                            )}
                            {result.kind === 'file' && (
                              <div className="text-sm text-gray-500 font-mono truncate">
                                {result.file.mimeType}
                              </div>
                            )}
                          <div className="text-xs text-gray-400 mt-1 font-mono flex items-center gap-2">
                            <span className="truncate">
                              ID: {result.kind === 'folder' ? result.folder.id : result.file.id}
                            </span>
                            {result.kind === 'file' && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  copyText(result.file.id);
                                }}
                                className="text-gray-400 hover:text-gray-600"
                                title="Copy file ID"
                              >
                                <FaCopy size={12} />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {}
          <div className="space-y-6 lg:min-h-0 lg:flex lg:flex-col">
            {}
            <div className="flex gap-2">
              {([
                { key: 'drive' as const, label: 'Google Drive', icon: <FaFolder size={12} /> },
                { key: 'upload' as const, label: 'Upload from computer', icon: <FaUpload size={12} /> },
              ]).map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setFileSource(opt.key)}
                  className="flex-1 px-4 py-2 rounded-lg text-sm font-medium border transition-colors flex items-center justify-center gap-2"
                  style={
                    fileSource === opt.key
                      ? { backgroundColor: '#11074A', color: 'white', borderColor: '#11074A' }
                      : { backgroundColor: 'white', color: '#4A4453', borderColor: '#d1d5db' }
                  }
                >
                  {opt.icon}
                  {opt.label}
                </button>
              ))}
            </div>

            {fileSource === 'drive' && (!selectedFolder ? (
              <div className="bg-white rounded-lg shadow-md border border-gray-200 p-6 lg:flex-1 lg:min-h-0">
                <div className="flex items-center gap-2 mb-2">
                  <h2 className="text-xl font-semibold" style={{ color: '#11074A' }}>
                    2. Select Files
                  </h2>
                  <button
                    onClick={() => setShowSupportedTypes(true)}
                    className="p-2 rounded-lg border border-gray-300 hover:bg-gray-50"
                    title="Supported file types"
                  >
                    <FaInfoCircle />
                  </button>
                </div>
                <p className="text-sm text-gray-500">
                  Search and select a Drive folder to browse files and subfolders.
                </p>
              </div>
            ) : (
              <div className="bg-white rounded-lg shadow-md border border-gray-200 p-6 lg:flex-1 lg:min-h-0 lg:flex lg:flex-col">
                <div className="flex items-start justify-between gap-4 mb-4">
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-semibold" style={{ color: '#11074A' }}>
                      2. Select Files
                    </h2>
                    <button
                      onClick={() => setShowSupportedTypes(true)}
                      className="p-2 rounded-lg border border-gray-300 hover:bg-gray-50"
                      title="Supported file types"
                    >
                      <FaInfoCircle />
                    </button>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    {}
                    {(() => {
                      const supportedFiles = folderItems.filter(item => !isFolderMime(item.mimeType) && ragSupport(item).supported);
                      const selectedInFolder = supportedFiles.filter(f => selectedFileIds.has(f.id)).length;
                      const allSelected = supportedFiles.length > 0 && selectedInFolder === supportedFiles.length;
                      const someSelected = selectedInFolder > 0 && selectedInFolder < supportedFiles.length;
                      const hasSelectableFiles = supportedFiles.length > 0;
                      
                      return hasSelectableFiles && (
                        <button
                          onClick={() => {
                            if (allSelected) {
                              setSelectedFileIds(prev => {
                                const next = new Set(prev);
                                supportedFiles.forEach(f => next.delete(f.id));
                                return next;
                              });
                              setSelectedFilesMeta(prev => {
                                const next = { ...prev };
                                supportedFiles.forEach(f => delete next[f.id]);
                                return next;
                              });
                            } else {
                              setSelectedFileIds(prev => {
                                const next = new Set(prev);
                                supportedFiles.forEach(f => next.add(f.id));
                                return next;
                              });
                              setSelectedFilesMeta(prev => {
                                const next = { ...prev };
                                supportedFiles.forEach(f => { next[f.id] = f; });
                                return next;
                              });
                            }
                          }}
                          className={`px-3 py-2 rounded-lg border flex items-center gap-2 text-sm ${
                            allSelected 
                              ? 'border-green-300 bg-green-50 text-green-700 hover:bg-green-100' 
                              : someSelected
                                ? 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100'
                                : 'border-gray-300 hover:bg-gray-50'
                          }`}
                          title={allSelected ? 'Deselect all files in this folder' : 'Select all supported files in this folder'}
                        >
                          {allSelected ? (
                            <FaCheckSquare className="text-green-600" />
                          ) : someSelected ? (
                            <FaMinusSquare className="text-blue-500" />
                          ) : (
                            <FaRegSquare className="text-gray-400" />
                          )}
                          {allSelected 
                            ? `Deselect All (${supportedFiles.length})` 
                            : someSelected 
                              ? `Select All (${selectedInFolder}/${supportedFiles.length})`
                              : `Select All (${supportedFiles.length})`
                          }
                        </button>
                      );
                    })()}
                    <button
                      onClick={openInDrive}
                      disabled={!currentFolderId}
                      className="px-3 py-2 text-white rounded-lg disabled:opacity-50 flex items-center gap-2 text-sm"
                      style={{ backgroundColor: '#11074A' }}
                      title="Open current folder in Google Drive"
                    >
                      <FaExternalLinkAlt />
                      Open in Drive
                    </button>
                    <button
                      onClick={() => copyText(selectedFolder.id)}
                      className="px-3 py-2 rounded-lg border border-gray-300 hover:bg-gray-50 flex items-center gap-2 text-sm"
                      title="Copy root folder ID"
                    >
                      <FaCopy />
                      {copied ? 'Copied' : 'Copy ID'}
                    </button>
                  </div>
                </div>

                {}
                {breadcrumbs.length > 0 && (
                  <div className="flex items-center flex-wrap gap-2 mb-4 text-sm">
                    {breadcrumbs.map((crumb, idx) => (
                      <div key={crumb.id} className="flex items-center gap-2">
                        <button
                          onClick={() => navigateToBreadcrumb(idx)}
                          className={`px-2 py-1 rounded border border-gray-200 hover:bg-gray-50 ${idx === breadcrumbs.length - 1 ? 'font-semibold' : ''}`}
                          title={crumb.id}
                        >
                          {crumb.name}
                        </button>
                        {idx < breadcrumbs.length - 1 && <FaChevronRight className="text-gray-400" />}
                      </div>
                    ))}
                  </div>
                )}

                {}
                {folderItems.length > 0 && (
                  <div className="flex flex-wrap items-center gap-3 mb-4">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500">Type</span>
                      <select
                        value={fileTypeFilter}
                        onChange={(e) => setFileTypeFilter(e.target.value)}
                        className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm bg-white"
                        title="Filter by file type"
                      >
                        <option value="all">All types ({folderItems.length})</option>
                        {fileTypeOptions.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500">Sort</span>
                      <select
                        value={sortMode}
                        onChange={(e) => setSortMode(e.target.value as typeof sortMode)}
                        className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm bg-white"
                        title="Sort files"
                      >
                        <option value="name">Name</option>
                        <option value="size">Size</option>
                        <option value="created">Created</option>
                        <option value="updated">Modified</option>
                      </select>
                    </div>

                    <span className="text-xs text-gray-400 ml-auto">
                      {sortedFolderItems.length} item{sortedFolderItems.length !== 1 ? 's' : ''}
                      {fileTypeFilter !== 'all' && ` (filtered from ${folderItems.length})`}
                    </span>
                  </div>
                )}

                {loadingFiles ? (
                  <div className="flex items-center justify-center py-8">
                    <FaSpinner className="animate-spin text-2xl text-gray-400" />
                  </div>
                ) : (
                  <div className="space-y-2 overflow-y-auto lg:flex-1 lg:min-h-0 pr-1">
                    {folderItems.length === 0 && (
                      <div className="text-sm text-gray-500 py-6 text-center">
                        No items found in this folder.
                      </div>
                    )}

                    {sortedFolderItems.length === 0 && folderItems.length > 0 && (
                      <div className="text-sm text-gray-500 py-6 text-center">
                        No items match the current filter.
                      </div>
                    )}

                    {sortedFolderItems.map((item) => {
                      const isFolder = isFolderMime(item.mimeType);
                      const support = ragSupport(item);
                      const typeLabel = formatMimeLabel(item.mimeType, item.name);

                      if (isFolder) {
                        return (
                          <button
                            key={item.id}
                            onClick={() => navigateToFolder(item.id, item.name)}
                            className="w-full text-left flex items-center gap-3 px-4 py-3 rounded-lg border border-gray-300 hover:bg-gray-50"
                            title="Open folder"
                          >
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <FaFolder className="text-yellow-600" />
                              {isAlmaFolderName(item.name) && (
                                <span
                                  className="px-2 py-0.5 rounded-full text-[11px] font-semibold border flex items-center gap-1"
                                  style={{
                                    backgroundColor: '#f8f7ff',
                                    borderColor: 'rgba(17, 7, 74, 0.25)',
                                    color: '#11074A',
                                  }}
                                  title="ALMA project folder"
                                >
                                  <FaBrain size={10} />
                                  ALMA
                                </span>
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="font-medium text-gray-900 truncate">{item.name}</div>
                              <div className="text-xs text-gray-500 font-mono truncate">ID: {item.id}</div>
                            </div>
                            <FaChevronRight className="text-gray-400" />
                          </button>
                        );
                      }

                      return (
                        <label
                          key={item.id}
                          className="flex items-center gap-3 px-4 py-3 rounded-lg border border-gray-300 hover:bg-gray-50 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={selectedFileIds.has(item.id)}
                            onChange={() => toggleFile(item)}
                            className="w-4 h-4"
                            disabled={!support.supported}
                            title={!support.supported ? (support.reason || 'Not supported') : 'Select file'}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-gray-900 truncate">{item.name}</div>
                            <div className="text-sm text-gray-500 flex flex-wrap items-center gap-2">
                              <span>{item.size ? `${(item.size / 1024 / 1024).toFixed(2)} MB` : 'Unknown size'}</span>
                              <span className="text-gray-300">•</span>
                              <span className="font-mono text-xs">{typeLabel}</span>
                              <span className="text-gray-300">•</span>
                              <span
                                className={`text-xs px-2 py-0.5 rounded-full border ${
                                  support.supported
                                    ? 'bg-green-50 text-green-700 border-green-200'
                                    : 'bg-red-50 text-red-700 border-red-200'
                                }`}
                                title={support.reason || (support.supported ? 'Supported for ingestion' : 'Not supported')}
                              >
                                {support.supported ? 'Supported' : 'Not supported'}
                              </span>
                              {support.supported && support.reason && (
                                <span className="text-xs text-gray-400">{support.reason}</span>
                              )}
                            </div>
                            <div className="text-xs text-gray-400 font-mono truncate">{item.mimeType}</div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}

            {fileSource === 'upload' && (
              <div className="bg-white rounded-lg shadow-md border border-gray-200 p-6 lg:flex-1 lg:min-h-0 lg:flex lg:flex-col">
                <div className="flex items-center gap-2 mb-2">
                  <h2 className="text-xl font-semibold" style={{ color: '#11074A' }}>
                    2. Select Files
                  </h2>
                  <button
                    onClick={() => setShowSupportedTypes(true)}
                    className="p-2 rounded-lg border border-gray-300 hover:bg-gray-50"
                    title="Supported file types"
                  >
                    <FaInfoCircle />
                  </button>
                </div>
                <p className="text-sm text-gray-500 mb-4">
                  Drag &amp; drop files from your computer, or click to browse. Up to 30MB each.
                </p>

                {}
                <div
                  className={`relative border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
                    creating ? 'opacity-50' : 'hover:bg-gray-50 cursor-pointer'
                  }`}
                  style={{
                    borderColor: localDragActive ? '#11074A' : '#d1d5db',
                    backgroundColor: localDragActive ? '#f8f7ff' : 'white',
                  }}
                  onDragEnter={handleLocalDrag}
                  onDragLeave={handleLocalDrag}
                  onDragOver={handleLocalDrag}
                  onDrop={handleLocalDrop}
                >
                  {/* The transparent input fills the dropzone and captures clicks itself,
                      so no parent onClick is needed — a parent handler that re-invokes
                      input.click() would open the file picker a second time. */}
                  <input
                    ref={localInputRef}
                    type="file"
                    multiple
                    accept={LOCAL_UPLOAD_ACCEPT}
                    onChange={(e) => addLocalFiles(e.target.files)}
                    disabled={creating}
                    className="absolute inset-0 w-full h-full cursor-pointer disabled:cursor-not-allowed"
                    style={{ opacity: 0.01 }}
                  />
                  {creating && fileSource === 'upload' && (
                    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-xl bg-white/85">
                      <FaSpinner className="animate-spin" size={30} style={{ color: '#11074A' }} />
                      <span className="text-sm font-medium" style={{ color: '#11074A' }}>
                        {uploadProgress === null || uploadProgress >= 100
                          ? 'Processing upload…'
                          : `Uploading… ${uploadProgress}%`}
                      </span>
                    </div>
                  )}
                  <FaCloudUploadAlt className="mx-auto mb-2" size={28} style={{ color: '#11074A' }} />
                  <p className="text-sm font-medium" style={{ color: '#11074A' }}>
                    Drop files here or click to browse
                  </p>
                  <p className="text-xs text-gray-500 mt-1">PDF, DOCX, TXT, CSV, JSON, and more</p>
                </div>

                {localUploadError && (
                  <div className="mt-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-start gap-2 whitespace-pre-line">
                    <FaExclamationTriangle size={12} className="mt-0.5 flex-shrink-0" />
                    <span>{localUploadError}</span>
                  </div>
                )}

                {localChecking && (
                  <div className="mt-3 text-sm text-gray-600 flex items-center gap-2">
                    <FaSpinner className="animate-spin" size={12} style={{ color: '#11074A' }} />
                    <span>Checking documents for a searchable text layer…</span>
                  </div>
                )}

                {localBlockedScans.length > 0 && (
                  <div className="mt-3 text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg px-3 py-3">
                    <div className="flex items-start gap-2">
                      <FaExclamationTriangle size={12} className="mt-0.5 flex-shrink-0" />
                      <div className="min-w-0">
                        <p className="font-medium">
                          Blocked {localBlockedScans.length} scanned PDF{localBlockedScans.length === 1 ? '' : 's'}:
                        </p>
                        <ul className="list-disc ml-5 mt-1 space-y-0.5">
                          {localBlockedScans.map((name) => (
                            <li key={name} className="truncate">{name}</li>
                          ))}
                        </ul>
                        <p className="mt-2">
                          These are scanned documents — each page is a full-page image. Even when a scan carries an OCR text layer, the text is often incomplete or garbled, so search results are unreliable. Provide a born-digital PDF, or re-run high-quality OCR, then add it again.
                        </p>
                        <p className="font-medium mt-2">Fix in Adobe Acrobat (recommended):</p>
                        <ol className="list-decimal ml-5 space-y-0.5">
                          <li>Open the PDF in Acrobat.</li>
                          <li>Go to <strong>Tools → Scan &amp; OCR</strong>.</li>
                          <li>Choose <strong>Recognize Text → In This File</strong>.</li>
                          <li>Pick the document language, then <strong>Recognize Text</strong>.</li>
                          <li><strong>Save</strong> the file and add it here again.</li>
                        </ol>
                        <p className="mt-2">
                          No Acrobat? Upload the PDF to Google Drive → <em>Open with Google Docs</em> (it OCRs the text), or use a reputable online OCR service, then export a text-based PDF and add it again.
                        </p>
                        <button
                          type="button"
                          onClick={() => setLocalBlockedScans([])}
                          className="mt-2 text-xs text-red-700 hover:underline"
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {}
                <div className="mt-4 space-y-2 overflow-y-auto lg:flex-1 lg:min-h-0 pr-1">
                  {localFiles.length === 0 ? (
                    <div className="text-sm text-gray-500 py-6 text-center">No files added yet.</div>
                  ) : (
                    localFiles.map((file, index) => (
                      <div
                        key={`${file.name}-${file.size}-${index}`}
                        className="flex items-center gap-3 px-4 py-3 rounded-lg border border-gray-300"
                      >
                        <FaFileAlt className="text-gray-600 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-gray-900 truncate">{file.name}</div>
                          <div className="text-xs text-gray-500">{formatFileSize(file.size)}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeLocalFile(index)}
                          disabled={creating}
                          className="text-red-600 text-sm hover:underline flex-shrink-0 disabled:opacity-50"
                        >
                          Remove
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {}
          <div className="space-y-6 lg:min-h-0 lg:flex lg:flex-col">
            <div className="bg-white rounded-lg shadow-md border border-gray-200 p-6">
              <h2 className="text-xl font-semibold mb-4" style={{ color: '#11074A' }}>
                3. Create or Add to Corpus
              </h2>

              {}
              <div className="mb-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
                <div className="text-sm font-semibold mb-3" style={{ color: '#11074A' }}>
                  Corpus Mode
                </div>
                <div className="flex flex-col gap-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      checked={corpusMode === 'new'}
                      onChange={() => {
                        setCorpusMode('new');
                        setSelectedExistingCorpusId(null);
                      }}
                      className="w-4 h-4"
                    />
                    <span className="text-sm font-medium">Create New Corpus</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      checked={corpusMode === 'existing'}
                      onChange={() => {
                        setCorpusMode('existing');
                        if (corpora.length === 0) loadCorpora();
                      }}
                      className="w-4 h-4"
                    />
                    <span className="text-sm font-medium">Add to Existing Corpus</span>
                  </label>
                </div>

                {corpusMode === 'existing' && (
                  <div className="mt-3">
                    {loadingCorpora ? (
                      <div className="flex items-center gap-2 text-sm text-gray-600">
                        <FaSpinner className="animate-spin" />
                        Loading corpora...
                      </div>
                    ) : corpora.length === 0 ? (
                      <div className="text-sm text-gray-500">
                        No existing corpora found. Create your first one in &quot;Create New Corpus&quot; mode.
                      </div>
                    ) : (
                      <>
                        <label className="block text-sm font-medium mb-2 text-gray-700">
                          Select Corpus
                        </label>
                        <select
                          value={selectedExistingCorpusId ?? ''}
                          onChange={(e) => setSelectedExistingCorpusId(e.target.value || null)}
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                        >
                          <option value="">-- Select a corpus --</option>
                          {corpora.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.displayName} ({(c.files ?? []).length} files)
                            </option>
                          ))}
                        </select>
                      </>
                    )}
                  </div>
                )}
              </div>

              {}
              <div className="mb-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-semibold" style={{ color: '#11074A' }}>
                    Selected files ({effectiveSelectedCount})
                  </div>
                  {effectiveSelectedCount > 0 && (
                    <button
                      onClick={() => {
                        if (fileSource === 'upload') {
                          setLocalFiles([]);
                          setLocalUploadError(null);
                          setLocalBlockedScans([]);
                        } else {
                          setSelectedFileIds(new Set());
                          setSelectedFilesMeta({});
                        }
                      }}
                      className="text-xs text-gray-600 hover:text-gray-900 hover:underline"
                      title="Clear all selected files"
                    >
                      Clear all
                    </button>
                  )}
                </div>

                {effectiveSelectedCount === 0 ? (
                  <div className="text-sm text-gray-500">No files selected yet.</div>
                ) : fileSource === 'upload' ? (
                  <div className="max-h-56 overflow-y-auto space-y-2 pr-1">
                    {localFiles.map((file, index) => (
                      <div
                        key={`${file.name}-${file.size}-${index}`}
                        className="flex items-center gap-3 px-3 py-2 rounded-lg border border-gray-200 hover:bg-gray-50"
                      >
                        <FaFileAlt className="text-gray-600 flex-shrink-0" size={12} />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-gray-900 truncate">{file.name}</div>
                          <div className="text-xs text-gray-500">{formatFileSize(file.size)}</div>
                        </div>
                        <button
                          onClick={() => removeLocalFile(index)}
                          className="text-red-600 text-xs hover:underline flex-shrink-0"
                          title="Remove file"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="max-h-56 overflow-y-auto space-y-2 pr-1">
                    {selectedFilesList.map((file) => {
                      const isPdf = file.mimeType === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
                      const pageRange = pdfPageRanges[file.id];
                      
                      return (
                        <div
                          key={file.id}
                          className={`flex items-start gap-3 px-3 py-2 rounded-lg border hover:bg-gray-50 ${
                            pageRange ? 'border-blue-300 bg-blue-50' : 'border-gray-200'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={selectedFileIds.has(file.id)}
                            onChange={() => deselectById(file.id)}
                            className="w-4 h-4 mt-1 cursor-pointer"
                            title="Deselect file"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-gray-900 truncate flex items-center gap-2">
                              {isPdf && <FaFilePdf className="text-red-500 flex-shrink-0" size={12} />}
                              <span className="truncate">{file.name}</span>
                            </div>
                            <div className="text-xs text-gray-500 flex flex-wrap items-center gap-2">
                              <span className="font-mono">{formatMimeLabel(file.mimeType, file.name)}</span>
                              {pageRange && (
                                <>
                                  <span className="text-gray-300">•</span>
                                  <span className="text-blue-600 font-medium">
                                    Pages {pageRange.startPage}-{pageRange.endPage === 999999 ? 'end' : pageRange.endPage}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                          {isPdf && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setPageRangeModalFile(file);
                                if (pageRange) {
                                  setTempStartPage(String(pageRange.startPage));
                                  setTempEndPage(pageRange.endPage === 999999 ? '' : String(pageRange.endPage));
                                } else {
                                  setTempStartPage('');
                                  setTempEndPage('');
                                }
                              }}
                              className={`p-1.5 rounded transition-colors flex-shrink-0 ${
                                pageRange 
                                  ? 'text-blue-600 hover:bg-blue-100' 
                                  : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
                              }`}
                              title={pageRange ? `Edit page range (${pageRange.startPage}-${pageRange.endPage === 999999 ? 'end' : pageRange.endPage})` : 'Set page range'}
                            >
                              <FaEdit size={14} />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {corpusMode === 'new' && (
                <>
                  <input
                    type="text"
                    value={corpusName}
                    onChange={(e) => setCorpusName(e.target.value)}
                    placeholder="Corpus name (e.g., Legal Docs Q4)"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg mb-4"
                    disabled={effectiveSelectedCount === 0}
                  />
                  <label className="block text-sm font-medium text-gray-700 mb-1">Project (required)</label>
                  <select
                    value={createProjectId}
                    onChange={(e) => setCreateProjectId(e.target.value)}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg mb-1"
                  >
                    <option value="">{projectsLoading ? 'Loading projects…' : 'Select a project…'}</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.displayName || p.name}</option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500 mb-4">
                    The corpus is added to this project so collaborators can see and use it.
                  </p>
                </>
              )}
              <label className="flex items-start gap-3 mb-4 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={allowPartialSuccess}
                  onChange={(e) => setAllowPartialSuccess(e.target.checked)}
                  className="mt-1"
                  disabled={creating || effectiveSelectedCount === 0 || isAnyJobProcessing}
                />
                <div>
                  <div className="font-medium">Allow partial ingestion (recommended)</div>
                  <div className="text-xs text-gray-500">
                    If some chunks/pages fail, we will still save the corpus with the chunks that succeeded and mark the job as{' '}
                    <span className="font-medium">completed with errors</span>. The Jobs log will list the failed page ranges.
                  </div>
                </div>
              </label>
              <button
                onClick={createCorpus}
                disabled={
                  creating ||
                  effectiveSelectedCount === 0 ||
                  isAnyJobProcessing ||
                  (corpusMode === 'existing' && !selectedExistingCorpusId) ||
                  (corpusMode === 'new' && !createProjectId)
                }
                className="w-full px-4 py-3 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                style={{ backgroundColor: '#11074A' }}
                title={isAnyJobProcessing ? 'Wait for current job to finish' : undefined}
              >
                {creating ? (
                  <>
                    <FaSpinner className="animate-spin" />
                    {fileSource === 'upload'
                      ? uploadProgress === null || uploadProgress >= 100
                        ? 'Processing upload...'
                        : `Uploading files... ${uploadProgress}%`
                      : 'Starting job...'}
                  </>
                ) : (
                  <>
                    <FaPlus />
                    {corpusMode === 'existing'
                      ? `Add to Corpus (${effectiveSelectedCount} files)`
                      : `Create Corpus (${effectiveSelectedCount} files)`}
                  </>
                )}
              </button>
              {uploadProgress !== null && (
                <div className="mt-3">
                  <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
                    <span>{uploadProgress >= 100 ? 'Processing upload…' : 'Uploading to server…'}</span>
                    <span className="font-medium">{uploadProgress}%</span>
                  </div>
                  <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-200"
                      style={{ width: `${uploadProgress}%`, backgroundColor: '#11074A' }}
                    />
                  </div>
                </div>
              )}
              {effectiveSelectedCount === 0 && !isAnyJobProcessing && (
                <p className="text-sm text-gray-500 mt-3">
                  {fileSource === 'upload'
                    ? 'Add at least one file to enable corpus creation.'
                    : 'Select at least one supported file to enable corpus creation.'}
                </p>
              )}
              {isAnyJobProcessing && (
                <p className="text-sm text-amber-600 mt-3 flex items-center gap-2">
                  <FaSpinner className="animate-spin" size={12} />
                  A job is currently running. Wait for it to finish before starting a new one.
                </p>
              )}
            </div>
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
