"use client";
 
 import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useModels } from '../../hooks/useModels';
 import { createPortal } from 'react-dom';
 import { useSession } from 'next-auth/react';
import {
  FaBrain,
  FaCheck,
  FaCheckCircle,
  FaChevronRight,
  FaCopy,
  FaDownload,
  FaExternalLinkAlt,
  FaFileAlt,
  FaFlask,
  FaFolder,
  FaGraduationCap,
  FaHistory,
  FaPlus,
  FaSave,
  FaSpinner,
  FaSync,
  FaTimes } from 'react-icons/fa';
import { useRouter } from 'next/navigation';
import { useLanguage } from '@/app/contexts/LanguageContext';
import { matchMetaFileToStep, type Sect1MetaStepRow } from '@/app/lib/sect1MetaSteps';
import {
  getReportCreationGenericTutorial,
  type ReportCreationGenericTutorialKey } from './reportCreationGenericTutorial';
import {
  getCorpusLayoutTutorialSlide,
  getMetaConfirmTutorialSlide } from './reportCreationLayoutTutorials';
import { getReportCreationHeaderLabel } from './reportCreationHeaderLabel';
import { CorpusFileBrowserPanel } from './CorpusFileBrowserPanel';
import { useReportCreationSession } from '@/app/lib/hooks/useReportCreationSession';
import type { SessionListEntry } from '@/app/lib/reportCreation/sessionTypes';
import { sec1SelectionRequiresBiomaterialCorpus } from '@/app/lib/reportCreationLayerRefs';
import { sanitizeReportCreationLayers } from '@/app/lib/reportCreation/synthesisCorpus';
import type { Canvas272Layer } from '@/app/canvas-272/lib/types';
 
 interface DriveFolder {
   id: string;
   name: string;
   owners?: Array<{ displayName?: string; emailAddress?: string }>;
   shared?: boolean;
  parents?: string[];
  parentNames?: string[];
 }
 
 interface DriveFile {
   id: string;
   name: string;
   mimeType: string;
   size?: number;
   parents?: string[];
  createdTime?: string;
  modifiedTime?: string;
 }
 
interface JobStatus {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'completed_with_errors';
  displayName: string;
  folderId: string;
  totalFiles: number;
  processedFiles: number;
  createdAt: string;
  updatedAt: string;
  corpusId?: string;
  error?: string;
  errorDetails?: unknown;
  logs?: Array<{ timestamp: string; level: 'info' | 'warn' | 'error'; message: string; file?: string }>;
}

interface ExistingCorpus {
  id: string;
  displayName: string;
  corpusId: string;
  files: Array<{ id: string; name: string; mimeType: string }>;
}

interface DriveFileWithPageRange extends DriveFile {
  size: number;
  pageRange?: { startPage: number; endPage: number };
}

interface CorpusRequestBody {
  mode: 'new' | 'existing';
  selectedFileIds: string[];
  allowPartialSuccess: boolean;
  files: DriveFileWithPageRange[];
  existingCorpusId?: string | null;
  displayName?: string;
  folderId?: string;
}

interface SummaryRecord {
  pdf_name: string;
  protocol_number: string;
  title: string;
  summary: string;
  keywords: string[];
}

function extractCorpusIdFromSummaryJsonFilename(name: string): string {
  const base = name.replace(/\.json$/i, '');
  const clinicalIdx = base.indexOf('_clinical_');
  if (clinicalIdx !== -1) return base.slice(clinicalIdx + '_clinical_'.length);
  const biomaterialIdx = base.indexOf('_biomaterial_');
  if (biomaterialIdx !== -1) return base.slice(biomaterialIdx + '_biomaterial_'.length);
  return base;
}

function isBiomaterialSummaryJsonFilename(name: string): boolean {
  return /_biomaterial_/i.test(name || '');
}

function isBrowserNetworkFetchError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg === 'Failed to fetch' ||
    msg === 'Load failed' ||
    /NetworkError|network request failed|fetch.*failed/i.test(msg)
  );
}

const REPORT_CREATION_MODAL_WIDTH_PX = 1500;
const REPORT_CREATION_MODAL_HEIGHT_PX = 900;

async function throwIfHttpNotOk(
  response: Response,
  fallback: string,
  notSignedInMsg: string,
): Promise<void> {
  if (response.ok) return;
  const text = await response.text().catch(() => '');
  let detail = fallback;
  try {
    const j = JSON.parse(text) as { error?: string };
    if (typeof j?.error === 'string' && j.error.trim()) {
      detail = j.error.trim();
    }
  } catch {
    if (text.trim()) detail = text.slice(0, 400);
  }
  if (response.status === 401) {
    throw new Error(notSignedInMsg);
  }
  throw new Error(detail ? `${detail} (HTTP ${response.status})` : `${fallback} (HTTP ${response.status})`);
}

interface TemplateData {
  id: string;
  name: string;
  description: string;
  molecule_type: string;
  study_types: string[];
  user_instruction: string;
  user_input: string;
}

interface MatchedStudy {
  id: string;
  pdfName: string;
  protocolNumber: string;
  title: string;
  summary: string;
  keywords: string[];
  matchedTemplateId: string;
  matchedTemplateName: string;
  studyType: string;
  matchScore: number;
  selected: boolean;
  userInput: string;
}

interface BibliographyItem {
  name: string;
  path: string;
  type?: 'file' | 'url' | 'reference';
  description?: string;
}

interface AgentLayer {
  id: string;
  name: string;
  type?: string;
  selectedModel: string;
  userInstruction: string;
  userInput?: string;
  bibliography?: BibliographyItem[];
  referencedSteps?: string[];
  [key: string]: unknown;
}

interface GeneratedAgent {
  version?: string;
  name: string;
  layers: AgentLayer[];
  metadata?: {
    created?: string;
    modified?: string;
    description?: string;
    notes?: Array<{ username: string; text: string; timestamp: string }>;
    generatedBy?: string;
    studyTypes?: string[];
    displayTitle?: string;
    biomaterialSkipped?: boolean;
  };
}

interface Sec3Step {
  id: string;
  name: string;
  instruction: string;
  keywords: string[];
  selected: boolean;
  userInput: string;
}

interface Sec1Step {
  id: string;
  name: string;
  instruction: string;
  keywords: string[];
  selected: boolean;
  userInput: string;
}

interface MetaTemplateStep {
  id: string;
  name: string;
  instruction: string;
  keywords: string[];
  selected: boolean;
  userInput: string;
}

interface MetaFileRow {
  id: string;
  name: string;
  metaStepId: string;
  userInput: string;
  keywords: string[];
  selected: boolean;
}

 export interface ReportCreationModalProps {
   isOpen: boolean;
   onClose: () => void;
   projectId: string;
   onSaved?: () => void;
 }
 
 export default function ReportCreationModal({
   isOpen,
   onClose,
  projectId,
   onSaved }: ReportCreationModalProps) {
    const models = useModels();
  const TEMPLATES_SHEET_ID = '1_gcNSf9MoSjDFc0uMmFepJ6c4uNSB_cM6Llqx-RyWeI';

  const makeRandomSuffix = useCallback((): string => {
    return Math.random().toString(36).slice(2, 6).toUpperCase();
  }, []);

  const sanitizeNamePart = useCallback((input: string): string => {
    return (input || '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase();
  }, []);

  const isoToMinute = useCallback((): string => {
    return new Date().toISOString().slice(0, 16).replace(':', '-');
  }, []);

  const extractReportNumber = useCallback((text: string): string => {
    const combined = (text || '').trim();
    if (!combined) return '';

    const patterns: RegExp[] = [
      /Protocol\s+([A-Z0-9-]+)/i,
      /Study\s+([A-Z0-9-]+)/i,
      /([A-Z]{2 }\d+[A-Z]?)/,
      /(\d{6 })/,
    ];

    for (const p of patterns) {
      const m = combined.match(p);
      if (m?.[1]) return m[1];
    }
    return '';
  }, []);

  const buildReportAgentName = useCallback(
    (opts: { corpusLabel: string; studies: Array<{ protocolNumber?: string; title?: string; pdfName?: string }> }) => {
      const corpusPart = sanitizeNamePart(opts.corpusLabel || 'corpus') || 'corpus';

      const reportNums = opts.studies
        .map((s) => (s.protocolNumber || '').trim() || extractReportNumber(`${s.title || ''} ${s.pdfName || ''}`))
        .map((s) => s.trim())
        .filter(Boolean);

      const uniqueNums = Array.from(new Set(reportNums)).sort();
      const reportsPart = uniqueNums.length ? uniqueNums.map(sanitizeNamePart).filter(Boolean).join('-') : 'no-reports';

      return `Report-agent-${corpusPart}-${reportsPart}-${isoToMinute()}`;
    },
    [extractReportNumber, isoToMinute, sanitizeNamePart]
  );

   const { data: session, status: sessionStatus } = useSession();
   const { t } = useLanguage();
   const notSignedInMsg = t('reportCreationModal.notSignedIn');
   const networkFetchHint = t('reportCreationModal.networkFetchHint');
   const sessionNameHeaderLabel = t('reportCreationModal.header.sessionName');

   const wizardTableCol = useMemo(
     () => ({
       item: t('reportCreationModal.columns.item'),
       instruction: t('reportCreationModal.columns.instruction'),
       keywords: t('reportCreationModal.columns.keywords'),
       yourInput: t('reportCreationModal.columns.yourInput') }),
     [t],
   );

   const genericTutorial = useMemo(() => getReportCreationGenericTutorial(t), [t]);

   const formatResumeStage = useCallback(
     (stage: string) => {
       const key = `reportCreationModal.resumeStages.${stage}`;
       const label = t(key);
       return label !== key ? label : stage.replace(/_/g, ' ');
     },
     [t],
   );
  const rcSession = useReportCreationSession();
  const [driveSessionList, setDriveSessionList] = useState<SessionListEntry[]>([]);
  const [showResumePrompt, setShowResumePrompt] = useState(false);
  const [loadingDriveSessions, setLoadingDriveSessions] = useState(false);
  const [resumingSessionId, setResumingSessionId] = useState<string | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [deletingAllSessions, setDeletingAllSessions] = useState(false);
  const [clearAllSessionsError, setClearAllSessionsError] = useState<string | null>(null);
   const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
   const modalRef = useRef<HTMLDivElement>(null);
  const corpusTutorialPdfColumnRef = useRef<HTMLDivElement>(null);
  const corpusTutorialCreateCorpusRef = useRef<HTMLDivElement>(null);
  const corpusTutorialExistingJsonRef = useRef<HTMLDivElement>(null);
  const metaCorpusTutorialPdfColumnRef = useRef<HTMLDivElement>(null);
  const metaCorpusTutorialCreateCorpusRef = useRef<HTMLDivElement>(null);
  const metaCorpusTutorialExistingJsonRef = useRef<HTMLDivElement>(null);
  const metaConfirmTutorialTableRef = useRef<HTMLDivElement>(null);
  const metaConfirmTutorialThCheckboxRef = useRef<HTMLTableCellElement>(null);
  const metaConfirmTutorialThNumRef = useRef<HTMLTableCellElement>(null);
  const metaConfirmTutorialThItemRef = useRef<HTMLTableCellElement>(null);
  const metaConfirmTutorialThInstructionRef = useRef<HTMLTableCellElement>(null);
  const metaConfirmTutorialThKeywordsRef = useRef<HTMLTableCellElement>(null);
  const metaConfirmTutorialThYourInputRef = useRef<HTMLTableCellElement>(null);

   const [searchQuery, setSearchQuery] = useState('');
   const [searchResults, setSearchResults] = useState<Array<{ kind: 'folder'; folder: DriveFolder } | { kind: 'file'; file: DriveFile }>>([]);
   const [_searching, setSearching] = useState(false);
  const [_searchFilter, _setSearchFilter] = useState<'all' | 'alma' | 'regular'>('all');
  const [_showHiddenInternalFolders, _setShowHiddenInternalFolders] = useState(false);
  const [searchMode, setSearchMode] = useState<'name' | 'type'>('name');
  const [selectedSearchType, setSelectedSearchType] = useState<string>('');
  const [_showTypePicker, setShowTypePicker] = useState(false);
  const [typePickerFilter, setTypePickerFilter] = useState('');
 
   const [selectedFolder, setSelectedFolder] = useState<DriveFolder | null>(null);
   const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
   const [breadcrumbs, setBreadcrumbs] = useState<Array<{ id: string; name: string }>>([]);
   const [folderItems, setFolderItems] = useState<DriveFile[]>([]);
   const [loadingFiles, setLoadingFiles] = useState(false);
  const [fileTypeFilter, setFileTypeFilter] = useState<string>('all');
  const [sortMode, setSortMode] = useState<'name' | 'size' | 'created' | 'updated'>('name');
 
   const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
   const [selectedFilesMeta, setSelectedFilesMeta] = useState<Record<string, DriveFile>>({});
   const [filePageRanges, setFilePageRanges] = useState<Record<string, { startPage: number; endPage: number }>>({});
  const [corpusName, setCorpusName] = useState('');
  const sanitizedCorpusNamePrefix = useMemo(
    () => sanitizeNamePart(corpusName),
    [corpusName, sanitizeNamePart]
  );
  const [creating, setCreating] = useState(false);
  const [allowPartialSuccess, setAllowPartialSuccess] = useState(true);
  const [corpusSelectionMode, setCorpusSelectionMode] = useState<'new' | 'existing'>('new');
  const [selectedExistingCorpusId, setSelectedExistingCorpusId] = useState<string | null>(null);
  const [existingCorpora, setExistingCorpora] = useState<ExistingCorpus[]>([]);
  const [loadingExistingCorpora, setLoadingExistingCorpora] = useState(false);
  const [activeView, setActiveView] = useState<
    'corpus' | 'processing' | 'done' | 'matching' | 'metacorpus' | 'metaprocessing' | 'metaconfirm' | 'sec3confirm' | 'sec1confirm' | 'generating'
  >('corpus');
  const [reportCreationSessionName, setReportCreationSessionName] = useState('');
  const sanitizedReportCreationPrefix = useMemo(
    () => sanitizeNamePart(reportCreationSessionName),
    [reportCreationSessionName, sanitizeNamePart]
  );
  const sessionPrefixReady = Boolean(sanitizedReportCreationPrefix);
  const [sessionIntroCompleted, setSessionIntroCompleted] = useState(false);
  const [isSavingOnClose, setIsSavingOnClose] = useState(false);
  const [corpusLayoutTutorialStep, setCorpusLayoutTutorialStep] = useState<0 | 1 | 2 | 3 | 4>(0);
  const [metaCorpusLayoutTutorialStep, setMetaCorpusLayoutTutorialStep] = useState<0 | 1 | 2 | 3 | 4>(0);
  const [metaConfirmTutorialStep, setMetaConfirmTutorialStep] = useState<0 | 1 | 2 | 3 | 4 | 5 | 6 | 7>(0);
  const [genericWizardTutorialStep, setGenericWizardTutorialStep] = useState(0);
  const [clinicalPipelineCompleteForBiomaterial, setClinicalPipelineCompleteForBiomaterial] = useState(false);
  const [biomaterialSkipped, setBiomaterialSkipped] = useState(false);
  const withClinicalAgentPrefix = useCallback(
    (baseAgentName: string) => {
      if (!sanitizedReportCreationPrefix) return baseAgentName;
      return `${sanitizedReportCreationPrefix}_clinical_${baseAgentName}`;
    },
    [sanitizedReportCreationPrefix]
  );
  const [_activeCorpusTarget, setActiveCorpusTarget] = useState<'clinical' | 'biomaterial' | null>(null);
  const [sec3Steps, setSec3Steps] = useState<Sec3Step[]>([]);
  const [loadingSec3, setLoadingSec3] = useState(false);
  const [metaTemplateSteps, setMetaTemplateSteps] = useState<MetaTemplateStep[]>([]);
  const [metaTemplateStepsTouched, setMetaTemplateStepsTouched] = useState(false);
  const [sharedMetaInstruction, setSharedMetaInstruction] = useState('');
  const [sec1Steps, setSec1Steps] = useState<Sec1Step[]>([]);
  const [loadingSec1, setLoadingSec1] = useState(false);
  const [metaCorpusName, setMetaCorpusName] = useState('');
  const sanitizedMetaCorpusNamePrefix = useMemo(
    () => sanitizeNamePart(metaCorpusName),
    [metaCorpusName, sanitizeNamePart]
  );
  const buildSummaryJsonFileName = useCallback(
    (
      kind: 'clinical' | 'biomaterial',
      corpusId: string,
      opts?: { prefixOverride?: string }
    ) => {
      if (!corpusId) return `${corpusId}.json`;
      const override = opts?.prefixOverride ? sanitizeNamePart(opts.prefixOverride) : '';
      const fromKind =
        kind === 'clinical'
          ? sanitizedCorpusNamePrefix || sanitizedReportCreationPrefix
          : sanitizedMetaCorpusNamePrefix || sanitizedReportCreationPrefix;
      const prefix = override || fromKind;
      if (prefix) {
        return `${prefix}_${kind}_${corpusId}.json`;
      }
      return `${corpusId}.json`;
    },
    [
      sanitizeNamePart,
      sanitizedCorpusNamePrefix,
      sanitizedMetaCorpusNamePrefix,
      sanitizedReportCreationPrefix,
    ]
  );
  const [metaSelectedFileIds, setMetaSelectedFileIds] = useState<Set<string>>(new Set());
  const [metaSelectedFilesMeta, setMetaSelectedFilesMeta] = useState<Record<string, DriveFile>>({});
  const [metaFilePageRanges, setMetaFilePageRanges] = useState<
    Record<string, { startPage: number; endPage: number }>
  >({});
  const [metaCreating, setMetaCreating] = useState(false);
  const [metaCorpusJobStatus, setMetaCorpusJobStatus] = useState<JobStatus | null>(null);
  const [completedMetaCorpusId, setCompletedMetaCorpusId] = useState<string | null>(null);
  const [metaFiles, setMetaFiles] = useState<MetaFileRow[]>([]);
  const [metaConfirmSteps, setMetaConfirmSteps] = useState<Sect1MetaStepRow[]>([]);
  const metaFilesRef = useRef(metaFiles);
  useEffect(() => {
    metaFilesRef.current = metaFiles;
  }, [metaFiles]);
  const [metaSummaryJobStatus, setMetaSummaryJobStatus] = useState<JobStatus | null>(null);
  const metaPollRef = useRef<NodeJS.Timeout | null>(null);
  const metaSummaryPollRef = useRef<NodeJS.Timeout | null>(null);
  const autoNavFolderRef = useRef<string | null>(null);
  const selectedFolderRef = useRef<DriveFolder | null>(null);
  const [corpusJobStatus, setCorpusJobStatus] = useState<JobStatus | null>(null);
  const [readyForSummaries, setReadyForSummaries] = useState(false);
  const [completedCorpusId, setCompletedCorpusId] = useState<string | null>(null);
  const [summaryJobStatus, setSummaryJobStatus] = useState<JobStatus | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryFiles, setSummaryFiles] = useState<DriveFile[]>([]);
  const [summaryFolderId, setSummaryFolderId] = useState<string | null>(null);

  const completedCorpusIdRef = useRef<string | null>(null);
  useEffect(() => {
    completedCorpusIdRef.current = completedCorpusId;
  }, [completedCorpusId]);

  useEffect(() => {
    if (!rcSession.session) return;
    setBiomaterialSkipped(Boolean(rcSession.session.biomaterialSkipped));
  }, [rcSession.session?.sessionId, rcSession.session?.biomaterialSkipped]);

  const sec3BackTargetRef = useRef<'matching' | 'metacorpus' | 'metaconfirm'>('metaconfirm');
  const metaConfirmBackTargetRef = useRef<'matching' | 'metacorpus'>('metacorpus');
  const pendingSec3OverridesRef = useRef<import('@/app/lib/reportCreation/sessionTypes').SectionStepOverride[] | null>(null);
  const pendingSec1OverridesRef = useRef<import('@/app/lib/reportCreation/sessionTypes').SectionStepOverride[] | null>(null);
  const loadTemplatesFromSheetRef = useRef<(() => Promise<Record<string, TemplateData>>) | null>(null);
  const matchKeywordsToTemplateRef = useRef<((keywords: string[], templatesMap: Record<string, TemplateData>) => { template: TemplateData | null; score: number; studyType: string }) | null>(null);
 
   const [errorDetails, setErrorDetails] = useState<unknown>(null);
   const [showErrorModal, setShowErrorModal] = useState(false);
   const [copied, setCopied] = useState(false);
  const [reportCreationCorpusFolderId, setReportCreationCorpusFolderId] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderCreated, setFolderCreated] = useState(false);
  const [existingJsonFiles, setExistingJsonFiles] = useState<DriveFile[]>([]);
  const [loadingExistingJson, setLoadingExistingJson] = useState(false);
  const [autoSelectedJsonFile, setAutoSelectedJsonFile] = useState<DriveFile | null>(null);
  const [autoSelectedBiomaterialJsonFile, setAutoSelectedBiomaterialJsonFile] =
    useState<DriveFile | null>(null);

  const clinicalExistingJsonFiles = useMemo(
    () => existingJsonFiles.filter((f) => !isBiomaterialSummaryJsonFilename(f.name || '')),
    [existingJsonFiles]
  );
  const biomaterialExistingJsonFiles = useMemo(
    () => existingJsonFiles.filter((f) => isBiomaterialSummaryJsonFilename(f.name || '')),
    [existingJsonFiles]
  );

  const corpusInitiated = folderCreated && Boolean(reportCreationCorpusFolderId);

  const [summaryRecords, setSummaryRecords] = useState<SummaryRecord[]>([]);
  void summaryRecords;
  const [templates, setTemplates] = useState<Record<string, TemplateData>>({});
  const [matchedStudies, setMatchedStudies] = useState<MatchedStudy[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [loadingClinicalJsonReuse, setLoadingClinicalJsonReuse] = useState(false);
  const [loadingBiomaterialJsonReuse, setLoadingBiomaterialJsonReuse] = useState(false);
  const [generatingAgent, setGeneratingAgent] = useState(false);
  const [agentName, setAgentName] = useState('');
  const [generatedAgent, setGeneratedAgent] = useState<GeneratedAgent | null>(null);
  const [bibInputs, setBibInputs] = useState<Record<string, string>>({});
  const [savedFileId, setSavedFileId] = useState<string | null>(null);
  void savedFileId;
  const router = useRouter();
 
   const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const summaryPollRef = useRef<NodeJS.Timeout | null>(null);
   const selectedCount = selectedFileIds.size;
 
   const isFolderMime = useCallback((mimeType: string) => mimeType === 'application/vnd.google-apps.folder', []);

  const isAlmaFolderName = useCallback((name: string): boolean => {
    const n = (name || '').trim().toLowerCase();
    return n.startsWith('alma_') || n.startsWith('alma-');
  }, []);

  const isAlmaRootFolderNameStrict = useCallback((name: string): boolean => {
    const n = (name || '').trim();
    return /^alma_.+_\d{13}$/.test(n);
  }, []);

  const INTERNAL_ALMA_FOLDER_NAMES = useMemo(() => {
    return new Set(
      [
        'Config','Workflows','Chats','Images','Created-images','PDFs','Audio','Video','Code','Docs','AF','report_creation_corpus',
        'Extracts','LatexFullDocs','Collections','Analysis','Analysis-output','Scripts','Scripts-output','Reports-output',
        'Incseqdiag-output','Incgraph-output','Agents','Agents-output','Prompts','RAG-Knowledge','Others','Logs','Orders',
        'stl','json3dprojects',
      ].map((s) => s.toLowerCase())
    );
  }, []);

  const SUPPORTED_EXTENSION_TOKENS = useMemo(() => {
    return new Set([
      'pdf',
      'json',
      'doc',
      'docx',
      'txt',
      'md',
      'csv',
      'xls',
      'xlsx',
      'ppt',
      'pptx',
      'xml',
      'sql',
      'ts',
      'js',
      'py',
      'r',
      'yaml',
      'yml',
    ]);
  }, []);

  const _typePickerOptions = useMemo(() => {
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

  const getEffectiveSearchQuery = useCallback(
    (raw: string): string => {
      const trimmed = (raw || '').trim();
      const isDirectIdLookup = /^[a-zA-Z0-9_-]{20 }$/.test(trimmed);
      if (isDirectIdLookup) return trimmed;

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

  const isDirectIdLookup = useMemo(() => {
    return /^[a-zA-Z0-9_-]{20 }$/.test((searchQuery || '').trim());
  }, [searchQuery]);

  const isExtensionOnlyNameQuery = useMemo(() => {
    const q = (searchQuery || '').trim().toLowerCase();
    if (!q) return false;
    if (q.includes('.') || /\s/.test(q)) return false;
    return SUPPORTED_EXTENSION_TOKENS.has(q);
  }, [SUPPORTED_EXTENSION_TOKENS, searchQuery]);

  const shouldHideSearchFolderByDefault = useCallback(
    (folder: DriveFolder): boolean => {
      const name = (folder.name || '').trim();
      if (!name) return false;

      if (name.startsWith('.')) return true;

      const isInternal = INTERNAL_ALMA_FOLDER_NAMES.has(name.toLowerCase());
      if (!isInternal) return false;

      const parentNames = folder.parentNames || [];
      const isUnderAlmaRoot = parentNames.some((p) => isAlmaRootFolderNameStrict(p));
      return isUnderAlmaRoot;
    },
    [INTERNAL_ALMA_FOLDER_NAMES, isAlmaRootFolderNameStrict]
  );

  const _filteredSearchResults = useMemo(() => {
    let base = searchResults;

    if (!_showHiddenInternalFolders && !isDirectIdLookup) {
      base = base.filter((r) => {
        if (r.kind !== 'folder') return true;
        return !shouldHideSearchFolderByDefault(r.folder);
      });
    }

    if (searchMode === 'name' && isExtensionOnlyNameQuery && !isDirectIdLookup) {
      const ext = (searchQuery || '').trim().toLowerCase();
      base = base.filter((r) => {
        if (r.kind !== 'file') return true;
        const n = (r.file.name || '').toLowerCase();
        return !n.endsWith(`.${ext}`);
      });
    }

    if (searchMode === 'type' && selectedSearchType && !isDirectIdLookup) {
      if (selectedSearchType === 'almaRoot') {
        base = base.filter((r) => r.kind === 'folder' && isAlmaRootFolderNameStrict(r.folder.name));
      } else if (selectedSearchType === 'folder') {
        base = base.filter((r) => r.kind === 'folder');
      } else {
        const ext = selectedSearchType.toLowerCase();
        base = base.filter((r) => r.kind === 'file' && (r.file.name || '').toLowerCase().endsWith(`.${ext}`));
      }
    }

    if (_searchFilter === 'all') return base;
    return base.filter((r) => {
      if (r.kind !== 'folder') return false;
      const alma = isAlmaFolderName(r.folder.name);
      return _searchFilter === 'alma' ? alma : !alma;
    });
  }, [
    isAlmaFolderName,
    isAlmaRootFolderNameStrict,
    isDirectIdLookup,
    isExtensionOnlyNameQuery,
    _searchFilter,
    searchMode,
    searchQuery,
    searchResults,
    selectedSearchType,
    _showHiddenInternalFolders,
    shouldHideSearchFolderByDefault,
  ]);
 
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
     if (mimeType === 'application/json') return 'Corpus';
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

  const formatFileSize = useCallback((bytes?: number): string => {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'Unknown size';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
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
   const selectedFileNames = useMemo(() => selectedFilesList.map((file) => file.name), [selectedFilesList]);

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

  const getTimeMs = useCallback((iso?: string): number => {
    if (!iso) return 0;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : 0;
  }, []);

  const sortedFolderItems = useMemo(() => {
    const items = [...filteredFolderItems];
    items.sort((a, b) => {
      const aIsFolder = isFolderMime(a.mimeType);
      const bIsFolder = isFolderMime(b.mimeType);
      if (fileTypeFilter === 'all' || fileTypeFilter === 'Folder') {
        if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
      }

      if (sortMode === 'name') {
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      }
      if (sortMode === 'size') {
        const aSize = a.size ?? -1;
        const bSize = b.size ?? -1;
        return bSize - aSize;
      }
      if (sortMode === 'created') {
        return getTimeMs(b.createdTime) - getTimeMs(a.createdTime);
      }
      return getTimeMs(b.modifiedTime) - getTimeMs(a.modifiedTime);
    });
    return items;
  }, [filteredFolderItems, fileTypeFilter, getTimeMs, isFolderMime, sortMode]);

  const visibleSupportedIds = useMemo(() => {
    const ids: string[] = [];
    for (const item of sortedFolderItems) {
      if (isFolderMime(item.mimeType)) continue;
      if (!ragSupport(item).supported) continue;
      ids.push(item.id);
    }
    return ids;
  }, [sortedFolderItems, isFolderMime, ragSupport]);

  const selectAllVisibleSupported = useCallback(() => {
    if (!corpusInitiated) return;
    const nextIds = new Set(selectedFileIds);
    const nextMeta: Record<string, DriveFile> = { ...selectedFilesMeta };

    for (const item of sortedFolderItems) {
      if (isFolderMime(item.mimeType)) continue;
      const support = ragSupport(item);
      if (!support.supported) continue;

      nextIds.add(item.id);
      nextMeta[item.id] = {
        ...item,
        parents: item.parents ?? (currentFolderId ? [currentFolderId] : undefined) };
    }

    setSelectedFileIds(nextIds);
    setSelectedFilesMeta(nextMeta);
  }, [corpusInitiated, currentFolderId, isFolderMime, ragSupport, selectedFileIds, selectedFilesMeta, sortedFolderItems]);

  const selectAllVisibleMetaSupported = useCallback(() => {
    if (!corpusInitiated) return;
    const nextIds = new Set(metaSelectedFileIds);
    const nextMeta: Record<string, DriveFile> = { ...metaSelectedFilesMeta };

    for (const item of sortedFolderItems) {
      if (isFolderMime(item.mimeType)) continue;
      const support = ragSupport(item);
      if (!support.supported) continue;

      nextIds.add(item.id);
      nextMeta[item.id] = {
        ...item,
        parents: item.parents ?? (currentFolderId ? [currentFolderId] : undefined) };
    }

    setMetaSelectedFileIds(nextIds);
    setMetaSelectedFilesMeta(nextMeta);
  }, [
    corpusInitiated,
    currentFolderId,
    isFolderMime,
    metaSelectedFileIds,
    metaSelectedFilesMeta,
    ragSupport,
    sortedFolderItems,
  ]);

  const toggleSelectAllVisibleSupported = useCallback(() => {
    if (!corpusInitiated || visibleSupportedIds.length === 0) return;
    const allSelected = visibleSupportedIds.every((id) => selectedFileIds.has(id));
    if (allSelected) {
      setSelectedFileIds((prev) => {
        const next = new Set(prev);
        for (const id of visibleSupportedIds) next.delete(id);
        return next;
      });
      setSelectedFilesMeta((prev) => {
        const next = { ...prev };
        for (const id of visibleSupportedIds) delete next[id];
        return next;
      });
      setFilePageRanges((prev) => {
        const next = { ...prev };
        for (const id of visibleSupportedIds) delete next[id];
        return next;
      });
    } else {
      selectAllVisibleSupported();
    }
  }, [
    corpusInitiated,
    visibleSupportedIds,
    selectedFileIds,
    selectAllVisibleSupported,
  ]);

  const toggleSelectAllVisibleMetaSupported = useCallback(() => {
    if (!corpusInitiated || visibleSupportedIds.length === 0) return;
    const allSelected = visibleSupportedIds.every((id) => metaSelectedFileIds.has(id));
    if (allSelected) {
      setMetaSelectedFileIds((prev) => {
        const next = new Set(prev);
        for (const id of visibleSupportedIds) next.delete(id);
        return next;
      });
      setMetaSelectedFilesMeta((prev) => {
        const next = { ...prev };
        for (const id of visibleSupportedIds) delete next[id];
        return next;
      });
      setMetaFilePageRanges((prev) => {
        const next = { ...prev };
        for (const id of visibleSupportedIds) delete next[id];
        return next;
      });
    } else {
      selectAllVisibleMetaSupported();
    }
  }, [
    corpusInitiated,
    visibleSupportedIds,
    metaSelectedFileIds,
    selectAllVisibleMetaSupported,
  ]);

   useEffect(() => {
     if (typeof window !== 'undefined') setPortalContainer(document.body);
   }, []);
 
   useEffect(() => {
     if (!isOpen) return;
     const prev = document.body.style.overflow;
     document.body.style.overflow = 'hidden';
     return () => { document.body.style.overflow = prev; };
   }, [isOpen]);
 
   useEffect(() => {
     return () => {
       if (pollIntervalRef.current) {
         clearInterval(pollIntervalRef.current);
       }
      if (summaryPollRef.current) {
        clearInterval(summaryPollRef.current);
      }
      if (metaPollRef.current) {
        clearInterval(metaPollRef.current);
      }
      if (metaSummaryPollRef.current) {
        clearInterval(metaSummaryPollRef.current);
      }
     };
   }, []);
 
  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setSearchResults([]);
      setSearching(false);
     setSearchMode('name');
     setSelectedSearchType('');
     setShowTypePicker(false);
     setTypePickerFilter('');
      setSelectedFolder(null);
      setCurrentFolderId(null);
      setBreadcrumbs([]);
      setFolderItems([]);
      setLoadingFiles(false);
     setFileTypeFilter('all');
      setSelectedFileIds(new Set());
      setSelectedFilesMeta({});
      setCorpusName('');
      setCreating(false);
     setActiveView('corpus');
     setActiveCorpusTarget(null);
     setReportCreationSessionName('');
     setSessionIntroCompleted(false);
     setClinicalPipelineCompleteForBiomaterial(false);
     setCorpusJobStatus(null);
     setReadyForSummaries(false);
     setCompletedCorpusId(null);
     setSummaryJobStatus(null);
     setSummaryError(null);
     setSummaryFiles([]);
     setSummaryFolderId(null);
      setErrorDetails(null);
      setShowErrorModal(false);
      setCopied(false);
     setReportCreationCorpusFolderId(null);
     setCreatingFolder(false);
     setFolderCreated(false);
     setSummaryRecords([]);
     setTemplates({});
     setMatchedStudies([]);
     setLoadingTemplates(false);
     setLoadingClinicalJsonReuse(false);
     setLoadingBiomaterialJsonReuse(false);
     setGeneratingAgent(false);
     setAgentName('');
     setGeneratedAgent(null);
     setSavedFileId(null);
    setSec3Steps([]);
    setLoadingSec3(false);
    setMetaTemplateSteps([]);
    setMetaTemplateStepsTouched(false);
    setSharedMetaInstruction('');
    setMetaConfirmSteps([]);
    setMetaConfirmTutorialStep(0);
    setSec1Steps([]);
    setLoadingSec1(false);
    setMetaCorpusName('');
    setMetaSelectedFileIds(new Set());
    setMetaSelectedFilesMeta({});
    setMetaFilePageRanges({});
    setMetaCreating(false);
    setMetaCorpusJobStatus(null);
    setCompletedMetaCorpusId(null);
    setMetaFiles([]);
    setMetaSummaryJobStatus(null);
    if (metaPollRef.current) clearInterval(metaPollRef.current);
    if (metaSummaryPollRef.current) clearInterval(metaSummaryPollRef.current);
     setCorpusSelectionMode('new');
     setSelectedExistingCorpusId(null);
     setExistingCorpora([]);
     setLoadingExistingCorpora(false);
    setExistingJsonFiles([]);
    setLoadingExistingJson(false);
    setAutoSelectedJsonFile(null);
    setAutoSelectedBiomaterialJsonFile(null);
    autoNavFolderRef.current = null;
    setCorpusLayoutTutorialStep(0);
    setMetaCorpusLayoutTutorialStep(0);
    setDriveSessionList([]);
    setShowResumePrompt(false);
    setResumingSessionId(null);
    setDeletingSessionId(null);
    setDeletingAllSessions(false);
    setClearAllSessionsError(null);
    rcSession.clearSession();
   }
}, [isOpen, rcSession]);

  useEffect(() => {
    if (activeView !== 'corpus' || !sessionIntroCompleted) {
      setCorpusLayoutTutorialStep(0);
    }
  }, [activeView, sessionIntroCompleted]);

  useEffect(() => {
    if (!isOpen || sessionStatus !== 'authenticated' || !projectId) return;
    let cancelled = false;
    setLoadingDriveSessions(true);
    rcSession.listSessions(projectId).then(async (sessions) => {
      if (cancelled) return;
      const incomplete = sessions.filter((s) => s.status === 'active');
      const availability = await Promise.all(
        incomplete.map(async (entry) => ({
          entry,
          ok: await rcSession.probeSession(projectId, entry.sessionId) }))
      );
      if (cancelled) return;
      const loadable = availability.filter((r) => r.ok).map((r) => r.entry);
      setDriveSessionList(loadable);
      setShowResumePrompt(loadable.length > 0);
      setLoadingDriveSessions(false);
    }).catch(() => {
      if (!cancelled) setLoadingDriveSessions(false);
    });
    return () => { cancelled = true; };

  }, [isOpen, sessionStatus, projectId]);

  useEffect(() => {
    if (activeView !== 'metacorpus' || !sessionIntroCompleted) {
      setMetaCorpusLayoutTutorialStep(0);
    }
  }, [activeView, sessionIntroCompleted]);

  useEffect(() => {
    if (corpusLayoutTutorialStep === 0 || corpusLayoutTutorialStep === 1) return;
    const map: Record<2 | 3 | 4, React.RefObject<HTMLDivElement | null>> = {
      2: corpusTutorialPdfColumnRef,
      3: corpusTutorialCreateCorpusRef,
      4: corpusTutorialExistingJsonRef };
    const r = map[corpusLayoutTutorialStep as 2 | 3 | 4];
    const id = window.requestAnimationFrame(() => {
      r?.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return () => window.cancelAnimationFrame(id);
  }, [corpusLayoutTutorialStep]);

  useEffect(() => {
    if (metaCorpusLayoutTutorialStep === 0 || metaCorpusLayoutTutorialStep === 1) return;
    const map: Record<2 | 3 | 4, React.RefObject<HTMLDivElement | null>> = {
      2: metaCorpusTutorialPdfColumnRef,
      3: metaCorpusTutorialCreateCorpusRef,
      4: metaCorpusTutorialExistingJsonRef };
    const r = map[metaCorpusLayoutTutorialStep as 2 | 3 | 4];
    const id = window.requestAnimationFrame(() => {
      r?.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return () => window.cancelAnimationFrame(id);
  }, [metaCorpusLayoutTutorialStep]);

  useEffect(() => {
    if (activeView !== 'metaconfirm' || metaConfirmTutorialStep === 0) return;
    const map: Record<
      1 | 2 | 3 | 4 | 5 | 6 | 7,
      React.RefObject<HTMLDivElement | HTMLTableCellElement | null>
    > = {
      1: metaConfirmTutorialTableRef,
      2: metaConfirmTutorialThCheckboxRef,
      3: metaConfirmTutorialThNumRef,
      4: metaConfirmTutorialThItemRef,
      5: metaConfirmTutorialThInstructionRef,
      6: metaConfirmTutorialThKeywordsRef,
      7: metaConfirmTutorialThYourInputRef };
    const r = map[metaConfirmTutorialStep as 1 | 2 | 3 | 4 | 5 | 6 | 7];
    const id = window.requestAnimationFrame(() => {
      r?.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    return () => window.cancelAnimationFrame(id);
  }, [metaConfirmTutorialStep, activeView]);

  useEffect(() => {
    if (activeView !== 'metaconfirm') setMetaConfirmTutorialStep(0);
  }, [activeView]);

  const dismissCorpusLayoutTutorial = useCallback(() => {
    setCorpusLayoutTutorialStep(0);
  }, []);

  const goNextCorpusTutorial = useCallback(() => {
    setCorpusLayoutTutorialStep((s) => {
      if (s === 4) return 0;
      if (s === 0) return 1;
      return (s + 1) as 1 | 2 | 3 | 4;
    });
  }, []);

  const goPrevCorpusTutorial = useCallback(() => {
    setCorpusLayoutTutorialStep((s) => (s > 1 ? ((s - 1) as 1 | 2 | 3 | 4) : 1));
  }, []);

  const startCorpusLayoutTutorial = useCallback(() => {
    setGenericWizardTutorialStep(0);
    setCorpusLayoutTutorialStep(1);
  }, []);

  const dismissMetaCorpusLayoutTutorial = useCallback(() => {
    setMetaCorpusLayoutTutorialStep(0);
  }, []);

  const goNextMetaCorpusTutorial = useCallback(() => {
    setMetaCorpusLayoutTutorialStep((s) => {
      if (s === 4) return 0;
      if (s === 0) return 1;
      return (s + 1) as 1 | 2 | 3 | 4;
    });
  }, []);

  const goPrevMetaCorpusTutorial = useCallback(() => {
    setMetaCorpusLayoutTutorialStep((s) => (s > 1 ? ((s - 1) as 1 | 2 | 3 | 4) : 1));
  }, []);

  const startMetaCorpusLayoutTutorial = useCallback(() => {
    setGenericWizardTutorialStep(0);
    setMetaCorpusLayoutTutorialStep(1);
  }, []);

  const dismissMetaConfirmTutorial = useCallback(() => {
    setMetaConfirmTutorialStep(0);
  }, []);

  const goNextMetaConfirmTutorial = useCallback(() => {
    setMetaConfirmTutorialStep((s) => {
      if (s === 7) return 0;
      if (s === 0) return 1;
      return (s + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
    });
  }, []);

  const goPrevMetaConfirmTutorial = useCallback(() => {
    setMetaConfirmTutorialStep((s) => (s > 1 ? ((s - 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7) : 1));
  }, []);

  const startMetaConfirmTutorial = useCallback(() => {
    setGenericWizardTutorialStep(0);
    setMetaConfirmTutorialStep(1);
  }, []);

  useEffect(() => {
    selectedFolderRef.current = selectedFolder;
  }, [selectedFolder]);
 
   const _searchFolders = useCallback(async () => {
    const effectiveQuery = getEffectiveSearchQuery(searchQuery);
    if (!effectiveQuery) {
      if (searchMode === 'type' && selectedSearchType === 'folder') {
        alert('Folder type search needs a name term (we avoid global folder search).');
      }
      return;
    }
 
     setSearching(true);
     try {
      const response = await fetch(`/api/rag/drive/search?q=${encodeURIComponent(effectiveQuery)}`);
       if (response.ok) {
         const data = await response.json();
         const folders: DriveFolder[] = data.folders || [];
         const files: DriveFile[] = data.files || [];
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
  }, [getEffectiveSearchQuery, searchMode, searchQuery, selectedSearchType]);
 
  const loadExistingCorpora = useCallback(async () => {
    setLoadingExistingCorpora(true);
    try {
      const response = await fetch('/api/rag/corpora');
      if (response.ok) {
        const data = await response.json();
        setExistingCorpora(data.corpora || []);
        console.log(`Loaded ${data.corpora?.length || 0} existing corpora`);
      } else {
        console.error('Failed to load existing corpora');
      }
    } catch (error) {
      console.error('Error loading existing corpora:', error);
    } finally {
      setLoadingExistingCorpora(false);
    }
  }, []);

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
 
   const _loadFolder = useCallback(async (folder: DriveFolder) => {
     setSelectedFolder(folder);
     setCurrentFolderId(folder.id);
     setBreadcrumbs([{ id: folder.id, name: folder.name }]);
     setFolderItems([]);
    setFileTypeFilter('all');
     setSelectedFileIds(new Set());
     setSelectedFilesMeta({});
     await loadFolderContents(folder.id);
   }, [loadFolderContents]);
 
   const _loadFileResult = useCallback(async (file: DriveFile) => {
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
      setFileTypeFilter('all');
 
       setSelectedFileIds((prev) => new Set(prev).add(file.id));
       setSelectedFilesMeta((prev) => ({ ...prev, [file.id]: file }));
     } catch (e) {
       console.error('Failed to load parent folder for file result', e);
     }
   }, []);
 
   const navigateToFolder = useCallback(async (folderId: string, folderName: string) => {
     setCurrentFolderId(folderId);
     setBreadcrumbs((prev) => [...prev, { id: folderId, name: folderName }]);
    setFileTypeFilter('all');
     await loadFolderContents(folderId);
   }, [loadFolderContents]);
 
   const navigateToBreadcrumb = useCallback(async (index: number) => {
     const newCrumbs = breadcrumbs.slice(0, index + 1);
     const target = newCrumbs[newCrumbs.length - 1];
     if (!target) return;
     setBreadcrumbs(newCrumbs);
     setCurrentFolderId(target.id);
    setFileTypeFilter('all');
     await loadFolderContents(target.id);
   }, [breadcrumbs, loadFolderContents]);

  const refreshCurrentFolder = useCallback(async () => {
    if (!currentFolderId) return;
    await loadFolderContents(currentFolderId);
  }, [currentFolderId, loadFolderContents]);

  const isJsonFile = useCallback((file: DriveFile): boolean => {
    return file.mimeType === 'application/json' || file.name.toLowerCase().endsWith('.json');
  }, []);

  const toggleFile = useCallback((file: DriveFile) => {
    const nextIds = new Set(selectedFileIds);
    const nextMeta: Record<string, DriveFile> = { ...selectedFilesMeta };

    const wasSelected = nextIds.has(file.id);
    if (wasSelected) {
      nextIds.delete(file.id);
      delete nextMeta[file.id];
      setFilePageRanges((prev) => {
        if (!prev[file.id]) return prev;
        const next = { ...prev };
        delete next[file.id];
        return next;
      });
    } else {
      nextIds.add(file.id);
      nextMeta[file.id] = {
        ...file,
        parents: file.parents ?? (currentFolderId ? [currentFolderId] : undefined) };
    }

    setSelectedFileIds(nextIds);
    setSelectedFilesMeta(nextMeta);
  }, [currentFolderId, isJsonFile, selectedFileIds, selectedFilesMeta]);
 
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
     setFilePageRanges((prev) => {
       if (!prev[fileId]) return prev;
       const next = { ...prev };
       delete next[fileId];
       return next;
     });
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
 
  const checkReportCreationCorpusFolder = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/folders/report_creation_corpus/files`);
      if (res.ok) {
        const data = (await res.json()) as { folder_id?: string };
        const folderId = data.folder_id || null;
        setReportCreationCorpusFolderId(folderId);
        setFolderCreated(Boolean(folderId));
        return;
      }
      setReportCreationCorpusFolderId(null);
      setFolderCreated(false);
    } catch {
      setReportCreationCorpusFolderId(null);
      setFolderCreated(false);
    }
  }, [projectId]);

  const removeUnavailableResumeSession = useCallback((sessionId: string) => {
    setDriveSessionList((prev) => {
      const next = prev.filter((s) => s.sessionId !== sessionId);
      if (next.length === 0) setShowResumePrompt(false);
      return next;
    });
  }, []);

  const handleResumeSession = useCallback(
    async (entry: SessionListEntry) => {
      if (resumingSessionId) return;
      setResumingSessionId(entry.sessionId);
      try {
        const manifest = await rcSession.loadSession(projectId, entry.sessionId, { reconcile: true });
        if (!manifest) {
          removeUnavailableResumeSession(entry.sessionId);
          return;
        }

        console.log(`[ReportCreation] Resuming session="${entry.sessionId}" — manifest.currentStage="${manifest.currentStage}"`);
        console.log(`[ReportCreation] manifest.clinical=`, {
          corpusId: manifest.clinical.corpusId,
          summaryJsonFile: manifest.clinical.summaryJsonFile?.name });
        console.log(`[ReportCreation] manifest.biomaterial=`, {
          corpusId: manifest.biomaterial.corpusId,
          summaryJsonFile: manifest.biomaterial.summaryJsonFile?.name,
          hasMetaFileOverrides: (manifest.matching?.metaFileOverrides?.length ?? 0) > 0 });

        setReportCreationSessionName(manifest.sessionName);
        setSessionIntroCompleted(true);
        setShowResumePrompt(false);
        setBiomaterialSkipped(Boolean(manifest.biomaterialSkipped));

        if (manifest.clinical.corpusName) setCorpusName(manifest.clinical.corpusName);
        if (manifest.clinical.corpusMode) setCorpusSelectionMode(manifest.clinical.corpusMode);

        const matchingStages: import('@/app/lib/reportCreation/sessionTypes').ReportCreationStage[] = [
          'matching_ready', 'matching_in_progress', 'meta_confirm', 'sec3_confirm',
          'sec1_confirm', 'agent_generated',
        ];
        if (matchingStages.includes(manifest.currentStage)) {
          if (manifest.matching?.agentName) {
            setAgentName(manifest.matching.agentName);
          }

          if (manifest.clinical.summaryJsonFile?.id) {
            try {
              const clinicalRes = await fetch(
                `/api/rag/drive/download/${manifest.clinical.summaryJsonFile.id}`,
                { credentials: 'include' }
              );
              if (clinicalRes.ok) {
                const summaries: SummaryRecord[] = await clinicalRes.json();
                const loadedTemplates = await loadTemplatesFromSheetRef.current!();
                setTemplates(loadedTemplates);

                const matched: MatchedStudy[] = summaries.map((record, index) => {
                  const { template, score, studyType } = matchKeywordsToTemplateRef.current!(
                    record.keywords || [],
                    loadedTemplates
                  );
                  const studyId = `study-${index}`;
                  const override = manifest.matching?.studyOverrides?.find(
                    (o) => o.studyId === studyId
                  );
                  return {
                    id: studyId,
                    pdfName: record.pdf_name || '',
                    protocolNumber: record.protocol_number || '',
                    title: record.title || '',
                    summary: record.summary || '',
                    keywords: Array.isArray(record.keywords) ? record.keywords : [],
                    matchedTemplateId: override?.matchedTemplateId ?? template?.id ?? '',
                    matchedTemplateName: template?.name ?? studyType,
                    studyType,
                    matchScore: score,
                    selected: override?.selected ?? true,
                    userInput: override?.userInput ?? '' };
                });
                setMatchedStudies(matched);
                setClinicalPipelineCompleteForBiomaterial(true);
                const clinicalCorpusId =
                  manifest.clinical.corpusId ||
                  extractCorpusIdFromSummaryJsonFilename(manifest.clinical.summaryJsonFile?.name ?? '');
                if (clinicalCorpusId) setCompletedCorpusId(clinicalCorpusId);
              }
            } catch (e) {
              console.warn('Resume: failed to re-hydrate clinical summaries', e);
            }
          }

          if (!manifest.biomaterialSkipped && manifest.biomaterial.summaryJsonFile?.id) {
            try {
              const bioRes = await fetch(
                `/api/rag/drive/download/${manifest.biomaterial.summaryJsonFile.id}`,
                { credentials: 'include' }
              );
              if (bioRes.ok) {
                const summaries: SummaryRecord[] = await bioRes.json();
                const metaFileOverrides = manifest.matching?.metaFileOverrides ?? [];
                const rebuilt: MetaFileRow[] = summaries.map((record, index) => {
                  const fileId = `meta-json-${index}-${(record.pdf_name || `doc-${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
                  const override = metaFileOverrides.find((o) => o.fileId === fileId);
                  return {
                    id: fileId,
                    name: record.pdf_name || `Document ${index + 1}`,
                    metaStepId: override?.metaStepId ?? '',
                    userInput: override?.userInput ?? '',
                    keywords: Array.isArray(record.keywords) ? record.keywords : [],
                    selected: override?.selected ?? true };
                });
                setMetaFiles(rebuilt);
                if (manifest.biomaterial.corpusId) {
                const bioCorpusId =
                  manifest.biomaterial.corpusId ||
                  extractCorpusIdFromSummaryJsonFilename(manifest.biomaterial.summaryJsonFile?.name ?? '');
                if (bioCorpusId) setCompletedMetaCorpusId(bioCorpusId);
                }
              }
            } catch (e) {
              console.warn('Resume: failed to re-hydrate biomaterial summaries', e);
            }
          }

          if (manifest.matching?.sec3Overrides?.length) {
            pendingSec3OverridesRef.current = manifest.matching.sec3Overrides;
          }
          if (manifest.matching?.sec1Overrides?.length) {
            pendingSec1OverridesRef.current = manifest.matching.sec1Overrides;
          }

          const [sec3Res, sec1Res, metaRes] = await Promise.allSettled([
            fetch('/api/templates/sec3-steps', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sheetId: TEMPLATES_SHEET_ID }) }),
            fetch('/api/templates/sec1-steps', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sheetId: TEMPLATES_SHEET_ID }) }),
            fetch('/api/templates/sect1-meta-steps', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ sheetId: TEMPLATES_SHEET_ID }) }),
          ]);

          if (sec3Res.status === 'fulfilled' && sec3Res.value.ok) {
            try {
              const data = await sec3Res.value.json();
              const loaded: Sec3Step[] = (data.steps || []).map(
                (s: { id: string; name: string; instruction: string; keywords?: string[] }) => ({
                  ...s,
                  keywords: Array.isArray(s.keywords) ? s.keywords : [],
                  selected: true,
                  userInput: '' })
              );
              setSec3Steps(loaded);
            } catch (e) {
              console.warn('Resume: failed to parse sec3 steps', e);
            }
          } else if (sec3Res.status === 'rejected') {
            console.warn('Resume: failed to load sec3 steps', sec3Res.reason);
          }

          if (sec1Res.status === 'fulfilled' && sec1Res.value.ok) {
            try {
              const data = await sec1Res.value.json();
              const loaded: Sec1Step[] = (data.steps || []).map(
                (s: { id: string; name: string; instruction: string; keywords?: string[] }) => ({
                  ...s,
                  keywords: Array.isArray(s.keywords) ? s.keywords : [],
                  selected: true,
                  userInput: '' })
              );
              setSec1Steps(loaded);
            } catch (e) {
              console.warn('Resume: failed to parse sec1 steps', e);
            }
          } else if (sec1Res.status === 'rejected') {
            console.warn('Resume: failed to load sec1 steps', sec1Res.reason);
          }

          if (metaRes.status === 'fulfilled' && metaRes.value.ok) {
            try {
              const data = (await metaRes.value.json()) as {
                steps?: unknown;
                sharedInstruction?: string;
              };
              const shared =
                typeof data.sharedInstruction === 'string' ? data.sharedInstruction.trim() : '';
              const steps: Sect1MetaStepRow[] = Array.isArray(data.steps)
                ? (data.steps as Sect1MetaStepRow[])
                : [];
              setSharedMetaInstruction(shared);
              setMetaConfirmSteps(steps);
              if (steps.length > 0) {
                setMetaFiles((prev) =>
                  prev.map((f) => {
                    const preserved =
                      f.metaStepId && steps.some((s) => s.id === f.metaStepId)
                        ? f.metaStepId
                        : null;
                    if (preserved) return f;
                    const match = matchMetaFileToStep(f.name, steps);
                    const fallbackId = match?.id ?? steps[0]?.id ?? '';
                    return { ...f, metaStepId: fallbackId };
                  })
                );
              }
            } catch (e) {
              console.warn('Resume: failed to parse biomaterial template steps', e);
            }
          } else if (metaRes.status === 'rejected') {
            console.warn('Resume: failed to load biomaterial template steps', metaRes.reason);
          }
        }

        console.log(`[ReportCreation] Switch on stage="${manifest.currentStage}" — navigating to view...`);
        console.log(`[ReportCreation] matchedStudies=${matchedStudies.length} metaFiles=${metaFiles.length}`);
        switch (manifest.currentStage) {
          case 'clinical_corpus_select':
          case 'clinical_corpus_running':
            setActiveView('corpus');
            setActiveCorpusTarget('clinical');
            break;
          case 'clinical_summary_running':
            setActiveView('processing');
            setActiveCorpusTarget('clinical');
            break;
          case 'biomaterial_corpus_select':
          case 'biomaterial_corpus_running':
            setClinicalPipelineCompleteForBiomaterial(true);
            setActiveView('metacorpus');
            setActiveCorpusTarget('biomaterial');
            break;
          case 'biomaterial_summary_running':
            setClinicalPipelineCompleteForBiomaterial(true);
            setActiveView('metaprocessing');
            break;
          case 'matching_ready':
            setClinicalPipelineCompleteForBiomaterial(true);
            setActiveView('done');
            break;
          case 'matching_in_progress':
            setClinicalPipelineCompleteForBiomaterial(true);
            setActiveView('matching');
            break;
          case 'meta_confirm':
            setClinicalPipelineCompleteForBiomaterial(true);
            setActiveView('metaconfirm');
            break;
          case 'sec3_confirm':
            setClinicalPipelineCompleteForBiomaterial(true);
            setActiveView('sec3confirm');
            break;
          case 'sec1_confirm':
            setClinicalPipelineCompleteForBiomaterial(true);
            setActiveView('sec1confirm');
            break;
          case 'agent_generated':
            setClinicalPipelineCompleteForBiomaterial(true);
            setActiveView('matching');
            break;
          case 'needs_attention':
            setActiveView('corpus');
            setActiveCorpusTarget('clinical');
            break;
          default:
            setActiveView('corpus');
            setActiveCorpusTarget('clinical');
        }
      } catch (err) {
        console.warn('[ReportCreation] Resume session failed, removing from list:', err);
        removeUnavailableResumeSession(entry.sessionId);
      } finally {
        setResumingSessionId(null);
      }
    },
    [projectId, rcSession, resumingSessionId, removeUnavailableResumeSession]
  );

  const handleDismissResumeSession = useCallback(
    async (entry: SessionListEntry) => {
      if (!projectId || deletingSessionId || deletingAllSessions || resumingSessionId) return;
      setDeletingSessionId(entry.sessionId);
      try {
        await rcSession.deleteSession(projectId, entry.sessionId);
        setDriveSessionList((prev) => {
          const next = prev.filter((s) => s.sessionId !== entry.sessionId);
          if (next.length === 0) setShowResumePrompt(false);
          return next;
        });
      } catch (err) {
        console.error('[ReportCreation] Failed to remove saved session:', err);
      } finally {
        setDeletingSessionId(null);
      }
    },
    [projectId, rcSession, deletingSessionId, deletingAllSessions, resumingSessionId]
  );

  const handleDismissAllResumeSessions = useCallback(async () => {
    if (!projectId || deletingSessionId || deletingAllSessions || resumingSessionId) return;
    const toDelete = driveSessionList;
    if (toDelete.length === 0) return;
    setDeletingAllSessions(true);
    setClearAllSessionsError(null);
    try {
      const succeededIds = new Set<string>();
      const failed: { sessionId: string; error: string }[] = [];
      for (const entry of toDelete) {
        try {
          await rcSession.deleteSession(projectId, entry.sessionId);
          succeededIds.add(entry.sessionId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failed.push({ sessionId: entry.sessionId, error: message });
        }
      }
      if (failed.length > 0) {
        console.error(
          '[ReportCreation] Failed to remove some saved sessions:',
          failed.map((f) => `${f.sessionId}: ${f.error}`).join('; ')
        );
        setClearAllSessionsError(
          t('reportCreationModal.session.clearAllPartialFailure', {
            failed: String(failed.length),
            total: String(toDelete.length) })
        );
      }
      setDriveSessionList((prev) => {
        const next = prev.filter((s) => !succeededIds.has(s.sessionId));
        if (next.length === 0) setShowResumePrompt(false);
        return next;
      });
    } finally {
      setDeletingAllSessions(false);
    }
  }, [
    projectId,
    rcSession,
    driveSessionList,
    deletingSessionId,
    deletingAllSessions,
    resumingSessionId,
    t,
  ]);

  const resolveReportCreationCorpusFolderId = useCallback(async (): Promise<string | null> => {
    try {
      const res = await fetch(`/api/projects/${projectId}/folders/report_creation_corpus/files`);
      if (!res.ok) return null;
      const data = (await res.json()) as { folder_id?: string };
      const id = data.folder_id || null;
      if (id) {
        setReportCreationCorpusFolderId(id);
        setFolderCreated(true);
      }
      return id;
    } catch {
      return null;
    }
  }, [projectId]);

  const ensureReportCreationCorpusFolder = useCallback(async (): Promise<string> => {
    const targetParentId = projectId;
    
    const response = await fetch('/api/create-subfolder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: targetParentId,
        parentFolderId: targetParentId,
        subfolderName: 'report_creation_corpus' }) });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Failed to ensure report_creation_corpus folder (${response.status})`);
    }

    const data = (await response.json()) as { subfolder_id?: string };
    if (!data.subfolder_id) {
      throw new Error('Failed to ensure report_creation_corpus folder (missing subfolder_id)');
    }
    return data.subfolder_id;
  }, [projectId]);

  const handleCreateFolderManually = useCallback(async () => {
    if (creatingFolder) return;
    if (folderCreated) return;
    if (!sanitizedReportCreationPrefix) {
      alert(
        'Enter a session name first (above). Set it before initiating the corpus folder or uploading documents.'
      );
      return;
    }
    setCreatingFolder(true);
    setFolderCreated(false);
    try {
      const folderId = await ensureReportCreationCorpusFolder();
      setReportCreationCorpusFolderId(folderId);
      setFolderCreated(true);
      const folderToRefresh = selectedFolder?.id || currentFolderId;
      if (folderToRefresh) {
        if (selectedFolder?.id && currentFolderId !== selectedFolder.id) {
          setCurrentFolderId(selectedFolder.id);
          setBreadcrumbs([{ id: selectedFolder.id, name: selectedFolder.name }]);
        }
        const folderIdToLoad = selectedFolder?.id || currentFolderId;
        if (folderIdToLoad) {
          await loadFolderContents(folderIdToLoad);
        }
      }
      alert(`Folder "report_creation_corpus" is ready.\nFolder ID: ${folderId}`);
    } catch (e) {
      setErrorDetails({
        message: e instanceof Error ? e.message : 'Failed to create report_creation_corpus folder',
        timestamp: new Date().toISOString() });
      setShowErrorModal(true);
    } finally {
      setCreatingFolder(false);
    }
  }, [
    creatingFolder,
    folderCreated,
    sanitizedReportCreationPrefix,
    ensureReportCreationCorpusFolder,
    currentFolderId,
    loadFolderContents,
    selectedFolder,
  ]);

  const createCorpus = useCallback(async () => {
    if (!sanitizedReportCreationPrefix) {
      alert(
        'Enter a session name first (above). It is required before ingesting documents into a corpus.'
      );
      return;
    }
    if (!corpusInitiated) {
      alert('Please click "Initiate Corpus" first to create the required output folder.');
      return;
    }

    if (corpusSelectionMode === 'existing') {
      if (!selectedExistingCorpusId) {
        alert('Please select an existing corpus');
        return;
      }
      if (selectedFileIds.size === 0) {
        alert('Please select files to add');
        return;
      }
    } else {
      if (!corpusName.trim() || selectedFileIds.size === 0 || !selectedFolder) {
        alert('Please provide a corpus name and select at least one file');
        return;
      }
    }

   const corpusDisplayName = corpusSelectionMode === 'new' 
     ? corpusName.trim()
     : '';
   const nowIso = new Date().toISOString();

    setSummaryFiles(selectedFilesForRequest);
    setSummaryFolderId(corpusSelectionMode === 'existing' ? null : selectedFolder?.id || null);
    setReadyForSummaries(false);
    setCompletedCorpusId(null);
    setSummaryJobStatus(null);
    setSummaryError(null);

    setCreating(true);
    try {
      const requestBody: CorpusRequestBody = {
        mode: corpusSelectionMode,
        selectedFileIds: Array.from(selectedFileIds),
        allowPartialSuccess,
        files: selectedFilesForRequest.map((f) => {
          const fileData: DriveFileWithPageRange = { ...f, size: f.size ?? 0 };
          if (filePageRanges[f.id]) {
            fileData.pageRange = filePageRanges[f.id];
          }
          return fileData;
        }) };

      if (corpusSelectionMode === 'existing') {
        requestBody.existingCorpusId = selectedExistingCorpusId;
      } else {
        requestBody.displayName = corpusDisplayName;
        requestBody.folderId = selectedFolder!.id;
      }

      const response = await fetch('/api/rag/corpora', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody) });
 
       if (response.ok) {
         const { jobId } = await response.json();
         void rcSession.saveClinicalFiles(
           projectId,
           selectedFilesForRequest.map((f) => ({
             id: f.id, name: f.name, mimeType: f.mimeType ?? '',
             size: f.size, pageRange: filePageRanges[f.id] })),
           corpusSelectionMode,
           corpusName.trim()
         ).catch(() => {});
         void rcSession.bindJob(projectId, { stage: 'clinical_corpus', jobId }).catch(() => {});
 
       setActiveView('processing');
       setCorpusJobStatus({
         jobId,
         status: 'pending',
         displayName: corpusSelectionMode === 'existing' 
           ? `Adding to ${existingCorpora.find(c => c.id === selectedExistingCorpusId)?.displayName || 'corpus'}`
           : corpusDisplayName,
         folderId: corpusSelectionMode === 'existing' 
           ? selectedExistingCorpusId!
           : selectedFolder!.id,
         totalFiles: selectedFileNames.length,
         processedFiles: 0,
         createdAt: nowIso,
         updatedAt: nowIso });
 
        setCorpusName('');
        setSelectedFileIds(new Set());
        setSelectedFilesMeta({});
        setFilePageRanges({});
        setCreating(false);
        setCorpusSelectionMode('new');
        setSelectedExistingCorpusId(null);
        onSaved?.();
 
         if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
 
         pollIntervalRef.current = setInterval(async () => {
           try {
             const statusRes = await fetch(`/api/rag/jobs/${jobId}`);
             if (statusRes.ok) {
               const job = await statusRes.json();
               setCorpusJobStatus(job);
 
              if (job.status === 'completed' || job.status === 'completed_with_errors') {
                if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
                setReadyForSummaries(true);
                setCompletedCorpusId(job.corpusId || null);
               } else if (job.status === 'failed') {
                 if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
                 setErrorDetails(job.errorDetails || { message: job.error });
                 setShowErrorModal(true);
                setActiveView('corpus');
               }
             }
          } catch (e) {
            console.error('Polling failed', e);
          }
        }, 2000);
       } else {
         setCreating(false);
         const data = await response.json();
         setErrorDetails(data.details || data);
         setShowErrorModal(true);
      setActiveView('corpus');
       }
     } catch (error) {
       console.error('Create corpus error:', error);
       setCreating(false);
       setErrorDetails({
         message: error instanceof Error ? error.message : 'Unknown error occurred',
         stack: error instanceof Error ? error.stack : undefined,
         timestamp: new Date().toISOString() });
       setShowErrorModal(true);
     setActiveView('corpus');
    }
 }, [corpusName, selectedFileIds, selectedFolder, selectedFilesForRequest, selectedFileNames, onSaved, ensureReportCreationCorpusFolder, allowPartialSuccess, filePageRanges, corpusInitiated, corpusSelectionMode, selectedExistingCorpusId, existingCorpora, sanitizedReportCreationPrefix, rcSession, projectId]);
 
  const startSummaryJob = useCallback(async () => {
    const resolvedCorpusId = completedCorpusId || corpusJobStatus?.corpusId || null;
    if (!resolvedCorpusId || !summaryFolderId || summaryFiles.length === 0) {
      alert('Missing corpus or files to summarize.');
      return;
    }

    setActiveView('processing');
    setSummaryError(null);
    setSummaryJobStatus(null);

    try {
      const outputFolderId = await ensureReportCreationCorpusFolder();
      const response = await fetch('/api/rag/corpora/summaries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          corpusId: resolvedCorpusId,
          folderId: outputFolderId,
          outputFileName: buildSummaryJsonFileName('clinical', resolvedCorpusId),
          files: summaryFiles.map((file) => ({
            id: file.id,
            name: file.name })) }) });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to start summary job (${response.status})`);
      }

      const data = await response.json();
      const jobId = data.jobId as string;
      void rcSession.bindJob(projectId, { stage: 'clinical_summary', jobId }).catch(() => {});

      if (summaryPollRef.current) clearInterval(summaryPollRef.current);
      summaryPollRef.current = setInterval(async () => {
        try {
          const statusRes = await fetch(`/api/rag/jobs/${jobId}`);
          if (statusRes.ok) {
            const job = await statusRes.json();
            setSummaryJobStatus(job);
            if (job.status === 'completed' || job.status === 'completed_with_errors') {
              if (summaryPollRef.current) clearInterval(summaryPollRef.current);
              setClinicalPipelineCompleteForBiomaterial(true);
              setActiveView('metacorpus');
            } else if (job.status === 'failed') {
              if (summaryPollRef.current) clearInterval(summaryPollRef.current);
              setSummaryError(job.error || 'Summary job failed');
            }
          }
        } catch (error) {
          console.error('Summary job polling failed', error);
        }
      }, 2000);
    } catch (error) {
      setSummaryError(error instanceof Error ? error.message : 'Failed to start summary job');
    }
  }, [completedCorpusId, corpusJobStatus, summaryFolderId, summaryFiles, ensureReportCreationCorpusFolder, buildSummaryJsonFileName, rcSession, projectId]);

  const generateFromExistingCorpus = useCallback(async () => {
    const corpus = existingCorpora.find(c => c.id === selectedExistingCorpusId);
    if (!corpus) {
      alert('Please select an existing corpus first.');
      return;
    }
    if (corpus.files.length === 0) {
      alert('The selected corpus has no files to summarize.');
      return;
    }

    const corpusFiles: DriveFile[] = corpus.files.map(f => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType }));

    setCompletedCorpusId(corpus.id);
    setSummaryFiles(corpusFiles);
    setActiveView('processing');
    setSummaryError(null);
    setSummaryJobStatus(null);

    try {
      const outputFolderId = await ensureReportCreationCorpusFolder();
      const response = await fetch('/api/rag/corpora/summaries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          corpusId: corpus.id,
          folderId: outputFolderId,
          outputFileName: buildSummaryJsonFileName('clinical', corpus.id, {
            prefixOverride: corpus.displayName }),
          files: corpusFiles.map(f => ({ id: f.id, name: f.name })) }) });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to start summary job (${response.status})`);
      }

      const data = await response.json();
      const jobId = data.jobId as string;
      void rcSession.bindJob(projectId, { stage: 'clinical_summary', jobId, corpusId: corpus.id }).catch(() => {});

      if (summaryPollRef.current) clearInterval(summaryPollRef.current);
      summaryPollRef.current = setInterval(async () => {
        try {
          const statusRes = await fetch(`/api/rag/jobs/${jobId}`);
          if (statusRes.ok) {
            const job = await statusRes.json();
            setSummaryJobStatus(job);
            if (job.status === 'completed' || job.status === 'completed_with_errors') {
              if (summaryPollRef.current) clearInterval(summaryPollRef.current);
              setClinicalPipelineCompleteForBiomaterial(true);
              setActiveView('metacorpus');
            } else if (job.status === 'failed') {
              if (summaryPollRef.current) clearInterval(summaryPollRef.current);
              setSummaryError(job.error || 'Summary job failed');
            }
          }
        } catch (err) {
          console.error('Summary job polling failed', err);
        }
      }, 2000);
    } catch (error) {
      setSummaryError(error instanceof Error ? error.message : 'Failed to start summary job');
      setActiveView('corpus');
    }
  }, [existingCorpora, selectedExistingCorpusId, ensureReportCreationCorpusFolder, buildSummaryJsonFileName, rcSession, projectId]);

  const canAccessBiomaterialStep = useMemo(
    () => clinicalPipelineCompleteForBiomaterial || matchedStudies.length > 0,
    [clinicalPipelineCompleteForBiomaterial, matchedStudies.length]
  );

  // Biomaterial counterpart of generateFromExistingCorpus: reuse an already-ingested
  // corpus and summarize it directly, skipping file upload. Drives the biomaterial
  // (metaprocessing) view/poll instead of the clinical one.
  const generateFromExistingMetaCorpus = useCallback(async () => {
    if (!canAccessBiomaterialStep) {
      alert(
        'Finish Clinical Study Reports first: create the corpus, wait for summaries (or load clinical summary Corpus), then continue to Biomaterial.'
      );
      return;
    }
    const corpus = existingCorpora.find(c => c.id === selectedExistingCorpusId);
    if (!corpus) {
      alert('Please select an existing corpus first.');
      return;
    }
    if (corpus.files.length === 0) {
      alert('The selected corpus has no files to summarize.');
      return;
    }

    const corpusFiles = corpus.files.map(f => ({ id: f.id, name: f.name }));

    setCompletedMetaCorpusId(corpus.id);
    setMetaFiles(
      corpus.files.map(f => ({
        id: f.id,
        name: f.name,
        metaStepId: '',
        userInput: '',
        keywords: [],
        selected: true }))
    );
    setMetaCorpusJobStatus(null);
    setActiveView('metaprocessing');

    const summaryPendingIso = new Date().toISOString();
    setMetaSummaryJobStatus({
      jobId: 'pending',
      status: 'pending',
      displayName: 'Corpus summary',
      folderId: '',
      totalFiles: corpusFiles.length,
      processedFiles: 0,
      createdAt: summaryPendingIso,
      updatedAt: summaryPendingIso });

    try {
      const outputFolderId = await ensureReportCreationCorpusFolder();
      const response = await fetch('/api/rag/corpora/summaries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          corpusId: corpus.id,
          folderId: outputFolderId,
          outputFileName: buildSummaryJsonFileName('biomaterial', corpus.id, {
            prefixOverride: corpus.displayName }),
          files: corpusFiles }) });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to start summary job (${response.status})`);
      }

      const data = await response.json();
      const jobId = data.jobId as string;
      void rcSession.bindJob(projectId, { stage: 'biomaterial_summary', jobId, corpusId: corpus.id }).catch(() => {});

      if (metaSummaryPollRef.current) clearInterval(metaSummaryPollRef.current);
      metaSummaryPollRef.current = setInterval(async () => {
        try {
          const statusRes = await fetch(`/api/rag/jobs/${jobId}`);
          if (statusRes.ok) {
            const job = await statusRes.json();
            setMetaSummaryJobStatus(job);
            if (job.status === 'completed' || job.status === 'completed_with_errors') {
              if (metaSummaryPollRef.current) clearInterval(metaSummaryPollRef.current);
              setMetaSummaryJobStatus(null);
              setActiveView(completedCorpusIdRef.current ? 'done' : 'corpus');
            } else if (job.status === 'failed') {
              if (metaSummaryPollRef.current) clearInterval(metaSummaryPollRef.current);
              setMetaSummaryJobStatus(null);
              setErrorDetails(job.errorDetails || { message: job.error });
              setShowErrorModal(true);
              setActiveView('metacorpus');
            }
          }
        } catch (err) {
          console.error('Biomaterial summary polling failed', err);
        }
      }, 2000);
    } catch (error) {
      setMetaSummaryJobStatus(null);
      setErrorDetails({
        message: error instanceof Error ? error.message : 'Failed to summarize biomaterial corpus',
        timestamp: new Date().toISOString() });
      setShowErrorModal(true);
      setActiveView('metacorpus');
    }
  }, [canAccessBiomaterialStep, existingCorpora, selectedExistingCorpusId, ensureReportCreationCorpusFolder, buildSummaryJsonFileName, rcSession, projectId]);

  const selectedJsonFile = useMemo(() => {
    if (autoSelectedJsonFile) return autoSelectedJsonFile;
    const files = Object.values(selectedFilesMeta);
    if (files.length !== 1) return null;
    const file = files[0];
    if (!isJsonFile(file)) return null;
    if (isBiomaterialSummaryJsonFilename(file.name || '')) return null;
    return file;
  }, [autoSelectedJsonFile, isJsonFile, selectedFilesMeta]);

  const isValidExistingSummaryJson = useMemo(() => {
    if (!selectedJsonFile) return false;
    const isRightFormat = /\.json$/i.test(selectedJsonFile.name || '');
    if (!isRightFormat) return false;
    if (autoSelectedJsonFile) return true;
    const inReportCreationCorpus = breadcrumbs.some((b) => b.name?.toLowerCase() === 'report_creation_corpus');
    return inReportCreationCorpus;
  }, [autoSelectedJsonFile, breadcrumbs, selectedJsonFile]);

  const isValidExistingBiomaterialSummaryJson = useMemo(() => {
    if (!autoSelectedBiomaterialJsonFile) return false;
    const n = autoSelectedBiomaterialJsonFile.name || '';
    if (!/\.json$/i.test(n)) return false;
    return isBiomaterialSummaryJsonFilename(n);
  }, [autoSelectedBiomaterialJsonFile]);

  useEffect(() => {
    if (!isOpen || !sessionIntroCompleted) return;
    if (activeView !== 'metacorpus') return;
    if (canAccessBiomaterialStep) return;
    setActiveCorpusTarget('clinical');
    setActiveView('corpus');
    alert(
      t('reportCreationModal.confirm.finishClinicalFirst')
    );
  }, [isOpen, sessionIntroCompleted, activeView, canAccessBiomaterialStep]);

  const handleSkipBiomaterial = useCallback(async () => {
    if (!projectId || !sessionIntroCompleted) return;
    const confirmed = window.confirm(t('reportCreationModal.confirm.skipBiomaterial'));
    if (!confirmed) return;

    if (metaPollRef.current) {
      clearInterval(metaPollRef.current);
      metaPollRef.current = null;
    }
    if (metaSummaryPollRef.current) {
      clearInterval(metaSummaryPollRef.current);
      metaSummaryPollRef.current = null;
    }
    setMetaCreating(false);
    setMetaCorpusJobStatus(null);
    setMetaSummaryJobStatus(null);
    setCompletedMetaCorpusId(null);
    setMetaFiles([]);
    setMetaSelectedFileIds(new Set());
    setMetaSelectedFilesMeta({});
    setMetaFilePageRanges({});
    setAutoSelectedBiomaterialJsonFile(null);
    setBiomaterialSkipped(true);
    setClinicalPipelineCompleteForBiomaterial(true);

    await rcSession.patchSession(projectId, {
      biomaterialSkipped: true,
      currentStage: 'matching_ready',
      biomaterial: {
        selectedFiles: [],
        corpusMode: 'new',
        corpusName: '',
        corpusFolderId: undefined,
        corpusJobId: undefined,
        summaryJobId: undefined,
        corpusId: undefined,
        summaryJsonFile: undefined } });

    if (completedCorpusIdRef.current) {
      setActiveView('done');
    } else {
      setActiveCorpusTarget('clinical');
      setActiveView('corpus');
      alert(
        t('reportCreationModal.confirm.clinicalRequired')
      );
    }
  }, [projectId, sessionIntroCompleted, rcSession]);

  const loadTemplatesFromSheet = useCallback(async (): Promise<Record<string, TemplateData>> => {
    const response = await fetch('/api/templates/drafting-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ sheetId: TEMPLATES_SHEET_ID }) });
    await throwIfHttpNotOk(response, 'Failed to load drafting templates', notSignedInMsg);
    
    const data = await response.json();
    console.log('Templates API response:', { source: data.source, count: data.templates?.length });
    
    const templatesArray = data.templates || [];
    const templatesRecord: Record<string, TemplateData> = {};
    
    for (const tmpl of templatesArray) {
      if (tmpl && tmpl.id) {
        templatesRecord[tmpl.id] = tmpl;
      }
    }
    
    console.log('Loaded templates:', Object.keys(templatesRecord).length, 'from', data.source);
    return templatesRecord;
  }, []);

  const matchKeywordsToTemplate = useCallback((
    keywords: string[],
    templatesMap: Record<string, TemplateData>
  ): { template: TemplateData | null; score: number; studyType: string } => {
    const normalizedKeywords = keywords.map(k => k.toLowerCase().trim());
    let bestMatch: { template: TemplateData | null; score: number } = { template: null, score: 0 };

    for (const templateData of Object.values(templatesMap)) {
      const templateKeywords = (templateData.study_types || []).map(k => k.toLowerCase().trim());
      
      let matchCount = 0;
      for (const summaryKw of normalizedKeywords) {
        for (const templateKw of templateKeywords) {
          if (summaryKw.includes(templateKw) || templateKw.includes(summaryKw)) {
            matchCount++;
            break;
          }
        }
      }

      if (matchCount > bestMatch.score) {
        bestMatch = { template: templateData, score: matchCount };
      }
    }

    const studyType = bestMatch.template?.name || 'Unknown';

    return { ...bestMatch, studyType };
  }, []);

  loadTemplatesFromSheetRef.current = loadTemplatesFromSheet;
  matchKeywordsToTemplateRef.current = matchKeywordsToTemplate;

  const loadExistingSummaries = useCallback(
    async (opts?: { skipNavigate?: boolean }): Promise<boolean> => {
      const skipNavigate = opts?.skipNavigate ?? false;
      if (!isValidExistingSummaryJson || !selectedJsonFile) {
        alert('Please select exactly one Corpus file named "filesearch-*.json" inside the "report_creation_corpus" folder.');
        return false;
      }

      setLoadingClinicalJsonReuse(true);
      try {
      const downloadResponse = await fetch(`/api/rag/drive/download/${selectedJsonFile.id}`, {
        credentials: 'include' });
      await throwIfHttpNotOk(downloadResponse, 'Failed to download summary Corpus from Google Drive', notSignedInMsg);

      const summaries: SummaryRecord[] = await downloadResponse.json();
      
      if (!Array.isArray(summaries) || summaries.length === 0) {
        throw new Error('Invalid JSON format - expected array of summaries');
      }

      const firstItem = summaries[0];
      if (!firstItem.pdf_name && !firstItem.keywords) {
        throw new Error('Invalid JSON format - missing required fields (pdf_name, keywords)');
      }

      setSummaryRecords(summaries);

      const loadedTemplates = await loadTemplatesFromSheet();
      console.log('Loaded templates:', Object.keys(loadedTemplates).length);
      
      if (Object.keys(loadedTemplates).length === 0) {
        throw new Error('No templates available');
      }
      
      setTemplates(loadedTemplates);

      const matched: MatchedStudy[] = summaries.map((record, index) => {
        const { template, score, studyType } = matchKeywordsToTemplate(record.keywords || [], loadedTemplates);
        return {
          id: `study-${index}`,
          pdfName: record.pdf_name || `Document ${index + 1}`,
          protocolNumber: record.protocol_number || '',
          title: record.title || '',
          summary: record.summary || '',
          keywords: record.keywords || [],
          matchedTemplateId: template?.id || '',
          matchedTemplateName: template?.name || 'No match',
          studyType,
          matchScore: score,
          selected: true,
          userInput: '' };
      });

      setMatchedStudies(matched);

      const extractedCorpusId = selectedJsonFile?.name
        ? extractCorpusIdFromSummaryJsonFilename(selectedJsonFile.name)
        : null;
      const corpusIdForState = extractedCorpusId?.trim() ? extractedCorpusId : null;
      setCompletedCorpusId(corpusIdForState);
      let displayCorpusName = corpusName.trim();

      if (corpusIdForState) {
        try {
          const corporaRes = await fetch('/api/rag/corpora');
          if (corporaRes.ok) {
            const corporaData = await corporaRes.json();
            const corpus = corporaData.corpora?.find((c: { id: string; displayName?: string }) => c.id === corpusIdForState);
            if (corpus?.displayName) {
              setCorpusName(corpus.displayName);
              displayCorpusName = corpus.displayName;
            }
          }
        } catch (e) {
          console.warn('Failed to fetch corpus name:', e);
        }
      }

      const corpusLabel = displayCorpusName || corpusIdForState || 'corpus';
      const computedAgentNameJson = withClinicalAgentPrefix(
        buildReportAgentName({
          corpusLabel,
          studies: matched.map((m) => ({ protocolNumber: m.protocolNumber, title: m.title, pdfName: m.pdfName })) })
      );
      setAgentName(computedAgentNameJson);
      setClinicalPipelineCompleteForBiomaterial(true);
      void rcSession.patchSession(projectId, {
        clinical: {
          summaryJsonFile: { id: selectedJsonFile.id, name: selectedJsonFile.name },
          corpusId: corpusIdForState ?? undefined },
        matching: {
          agentName: computedAgentNameJson,
          studyOverrides: matched.map((s) => ({
            studyId: s.id,
            matchedTemplateId: s.matchedTemplateId ?? '',
            selected: s.selected ?? true,
            userInput: s.userInput ?? '' })) },
        currentStage: 'biomaterial_corpus_select' }).catch(() => {});
      if (!skipNavigate) {
        setActiveView('metacorpus');
      }
      return true;
    } catch (error) {
      console.error('Failed to load existing summaries:', error);
      const net = isBrowserNetworkFetchError(error);
      setErrorDetails({
        message: net
          ? 'Network error while loading summary Corpus or templates.'
          : error instanceof Error
            ? error.message
            : 'Failed to load summaries from Corpus',
        ...(net ? { hint: networkFetchHint } : {}),
        timestamp: new Date().toISOString() });
      setShowErrorModal(true);
      return false;
    } finally {
      setLoadingClinicalJsonReuse(false);
    }
  },
    [isValidExistingSummaryJson, selectedJsonFile, loadTemplatesFromSheet, matchKeywordsToTemplate, withClinicalAgentPrefix, buildReportAgentName, corpusName, rcSession, projectId]
  );

  const loadExistingBiomaterialSummaries = useCallback(
    async (opts?: { skipNavigate?: boolean }): Promise<boolean> => {
      const skipNavigate = opts?.skipNavigate ?? false;
      if (!isValidExistingBiomaterialSummaryJson || !autoSelectedBiomaterialJsonFile) {
        alert(
          'Select one biomaterial summary Corpus (filename must contain _biomaterial_) from report_creation_corpus.'
        );
        return false;
      }

      setLoadingBiomaterialJsonReuse(true);
      try {
      const downloadResponse = await fetch(
        `/api/rag/drive/download/${autoSelectedBiomaterialJsonFile.id}`,
        { credentials: 'include' }
      );
      await throwIfHttpNotOk(downloadResponse, 'Failed to download biomaterial summary Corpus from Google Drive', notSignedInMsg);

      const summaries: SummaryRecord[] = await downloadResponse.json();

      if (!Array.isArray(summaries) || summaries.length === 0) {
        throw new Error('Invalid JSON format - expected array of summaries');
      }

      const firstItem = summaries[0];
      if (!firstItem.pdf_name && !firstItem.keywords) {
        throw new Error('Invalid JSON format - missing required fields (pdf_name, keywords)');
      }

      const extractedCorpusId = extractCorpusIdFromSummaryJsonFilename(
        autoSelectedBiomaterialJsonFile.name || ''
      );
      if (!extractedCorpusId) {
        throw new Error('Could not parse corpus id from filename');
      }

      setCompletedMetaCorpusId(extractedCorpusId);
      setMetaFiles(
        summaries.map((record, index) => ({
          id: `meta-json-${index}-${(record.pdf_name || `doc-${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '_')}`,
          name: record.pdf_name || `Document ${index + 1}`,
          metaStepId: '',
          userInput: '',
          keywords: Array.isArray(record.keywords) ? record.keywords : [],
          selected: true }))
      );

      try {
        const corporaRes = await fetch('/api/rag/corpora');
        if (corporaRes.ok) {
          const corporaData = await corporaRes.json();
          const corpus = corporaData.corpora?.find(
            (c: { id: string; displayName?: string }) => c.id === extractedCorpusId
          );
          if (corpus?.displayName) {
            setMetaCorpusName(corpus.displayName);
          } else {
            setMetaCorpusName(extractedCorpusId);
          }
        } else {
          setMetaCorpusName(extractedCorpusId);
        }
      } catch (e) {
        console.warn('Failed to fetch biomaterial corpus name:', e);
        setMetaCorpusName(extractedCorpusId);
      }

      if (!skipNavigate) {
        setActiveView(completedCorpusIdRef.current ? 'done' : 'corpus');
      }
      setBiomaterialSkipped(false);
      void rcSession.patchSession(projectId, {
        biomaterialSkipped: false,
        biomaterial: {
          summaryJsonFile: {
            id: autoSelectedBiomaterialJsonFile.id,
            name: autoSelectedBiomaterialJsonFile.name },
          corpusId: extractedCorpusId } }).catch(() => {});
      return true;
      } catch (error) {
        console.error('Failed to load biomaterial summaries from JSON:', error);
        const net = isBrowserNetworkFetchError(error);
        setErrorDetails({
          message: net
            ? 'Network error while loading biomaterial summary Corpus.'
            : error instanceof Error
              ? error.message
              : 'Failed to load biomaterial summaries',
          ...(net ? { hint: networkFetchHint } : {}),
          timestamp: new Date().toISOString() });
        setShowErrorModal(true);
        return false;
      } finally {
        setLoadingBiomaterialJsonReuse(false);
      }
    },
    [isValidExistingBiomaterialSummaryJson, autoSelectedBiomaterialJsonFile, rcSession, projectId]
  );

  const startMatchingProcess = useCallback(async () => {
    const corpusId = completedCorpusId || corpusJobStatus?.corpusId;
    if (!corpusId) {
      alert('Missing corpus ID');
      return;
    }

    setLoadingTemplates(true);
    try {
      let outputFolderId = reportCreationCorpusFolderId;
      if (!outputFolderId) {
        outputFolderId = await resolveReportCreationCorpusFolderId();
      }
      if (!outputFolderId) {
        throw new Error(
          'Could not find the report_creation_corpus folder in this project. Create it from the corpus step or ensure it exists under the project root.'
        );
      }

      const jsonFileName = buildSummaryJsonFileName('clinical', corpusId);
      const listResponse = await fetch(`/api/rag/drive/folder/${outputFolderId}`);
      if (!listResponse.ok) throw new Error('Failed to list output folder');
      
      const listData = await listResponse.json();
      const filesInFolder: DriveFile[] = listData.files || [];
      let jsonFile = filesInFolder.find((f: DriveFile) => f.name === jsonFileName);
      if (!jsonFile) {
        jsonFile = filesInFolder.find(
          (f: DriveFile) =>
            typeof f.name === 'string' && f.name.endsWith(`_clinical_${corpusId}.json`)
        );
      }
      if (!jsonFile) {
        jsonFile = filesInFolder.find((f: DriveFile) => f.name === `${corpusId}.json`);
      }
      
      if (!jsonFile) {
        throw new Error(
          `Summary Corpus file not found: ${jsonFileName}, any *_clinical_${corpusId}.json, or legacy ${corpusId}.json`
        );
      }

      const downloadResponse = await fetch(`/api/rag/drive/download/${jsonFile.id}`);
      if (!downloadResponse.ok) throw new Error('Failed to download summary Corpus');
      
      const summaries: SummaryRecord[] = await downloadResponse.json();
      setSummaryRecords(summaries);

      const loadedTemplates = await loadTemplatesFromSheet();
      console.log('Loaded templates:', Object.keys(loadedTemplates).length, Object.keys(loadedTemplates));
      
      if (Object.keys(loadedTemplates).length === 0) {
        console.error('No templates loaded!');
        throw new Error('No templates available. Please check your template configuration.');
      }
      
      setTemplates(loadedTemplates);

      const matched: MatchedStudy[] = summaries.map((record, index) => {
        const { template, score, studyType } = matchKeywordsToTemplate(
          record.keywords ?? [],
          loadedTemplates
        );
        return {
          id: `study-${index}`,
          pdfName: record.pdf_name,
          protocolNumber: record.protocol_number,
          title: record.title,
          summary: record.summary,
          keywords: record.keywords,
          matchedTemplateId: template?.id || '',
          matchedTemplateName: template?.name || 'No match',
          studyType,
          matchScore: score,
          selected: true,
          userInput: '' };
      });

      setMatchedStudies(matched);
      const corpusLabel = corpusName.trim() || corpusId || 'corpus';
      const computedAgentName = withClinicalAgentPrefix(
        buildReportAgentName({
          corpusLabel,
          studies: matched.map((m) => ({ protocolNumber: m.protocolNumber, title: m.title, pdfName: m.pdfName })) })
      );
      setAgentName(computedAgentName);
      setClinicalPipelineCompleteForBiomaterial(true);

      if (projectId) {
        void rcSession.patchSession(projectId, {
          clinical: {
            summaryJsonFile: { id: jsonFile!.id!, name: jsonFile!.name! },
            corpusId: corpusId ?? undefined },
          matching: {
            agentName: computedAgentName,
            studyOverrides: matched.map((s) => ({
              studyId: s.id,
              matchedTemplateId: s.matchedTemplateId ?? '',
              selected: s.selected ?? true,
              userInput: s.userInput ?? '' })) },
          currentStage: 'matching_in_progress' }).catch(() => {});
      }

      setActiveView('matching');
    } catch (error) {
      console.error('Matching process failed:', error);
      setErrorDetails({
        message: error instanceof Error ? error.message : 'Failed to start matching process',
        timestamp: new Date().toISOString() });
      setShowErrorModal(true);
      setActiveView('corpus');
    } finally {
      setLoadingTemplates(false);
    }
  }, [
    completedCorpusId,
    corpusJobStatus?.corpusId,
    reportCreationCorpusFolderId,
    resolveReportCreationCorpusFolderId,
    loadTemplatesFromSheet,
    matchKeywordsToTemplate,
    buildSummaryJsonFileName,
    withClinicalAgentPrefix,
    corpusName,
    rcSession,
    projectId,
  ]);

  const updateStudyType = useCallback((studyId: string, newTemplateId: string) => {
    setMatchedStudies(prev => prev.map(study => {
      if (study.id !== studyId) return study;
      const template = Object.values(templates).find(t => t.id === newTemplateId);
      const studyType = template?.name || 'Unknown';
      return {
        ...study,
        matchedTemplateId: newTemplateId,
        matchedTemplateName: template?.name || 'Unknown',
        studyType };
    }));
  }, [templates]);

  const saveGeneratedAgentToProjectAndNavigate = useCallback(
    async (agentToSave: GeneratedAgent): Promise<'saved' | 'validation_failed' | 'save_failed'> => {
      if (!projectId) {
        setErrorDetails({
          message: 'Missing project — cannot save agent.',
          timestamp: new Date().toISOString() });
        setShowErrorModal(true);
        return 'save_failed';
      }

      const stepsMissingUserInstruction = agentToSave.layers
        .map((layer, idx) => ({
          order: idx + 1,
          id: layer.id,
          name: layer.name,
          userInstruction: layer.userInstruction }))
        .filter((s) => !s.userInstruction || !s.userInstruction.trim());

      if (stepsMissingUserInstruction.length > 0) {
        setErrorDetails({
          title: 'Cannot Save Agent',
          message:
            'One or more steps have an empty "User Instruction". Please select a template/match or fill the missing instructions before saving.',
          missingSteps: stepsMissingUserInstruction.map(({ order, id, name }) => ({ order, id, name })),
          timestamp: new Date().toISOString() });
        setShowErrorModal(true);
        return 'validation_failed';
      }

      try {
        const { saveAgentWithVersioning, checkAgentNameExists } = await import('@/app/lib/versionUtils');
        const targetProjectId = projectId;

        let uniqueName = agentToSave.name?.trim() || agentName.trim() || 'Report-agent';
        for (let i = 0; i < 5; i++) {
          const check = await checkAgentNameExists(targetProjectId, uniqueName);
          if (!check.exists) break;
          uniqueName = `${uniqueName} - ${makeRandomSuffix()}`;
        }

        if (uniqueName !== agentToSave.name) {
          setAgentName(uniqueName);
          setGeneratedAgent({ ...agentToSave, name: uniqueName });
        }

        const namedAgent =
          uniqueName !== agentToSave.name ? { ...agentToSave, name: uniqueName } : agentToSave;
        const finalAgent = {
          ...namedAgent,
          layers: sanitizeReportCreationLayers(
            namedAgent.layers as unknown as Canvas272Layer[],
          ) as unknown as AgentLayer[] };
        const result = await saveAgentWithVersioning(targetProjectId, finalAgent.name, finalAgent);

        if (result.success && result.fileId) {
          setSavedFileId(result.fileId);
          onSaved?.();
          onClose();
          router.push(`/ai-agents/edit/${encodeURIComponent(result.fileId)}`);
          return 'saved';
        }
        throw new Error(result.error || 'Failed to save agent (missing fileId)');
      } catch (err) {
        console.error('Save error:', err);
        setErrorDetails({
          message: err instanceof Error ? err.message : 'Failed to save agent',
          timestamp: new Date().toISOString() });
        setShowErrorModal(true);
        return 'save_failed';
      }
    },
    [projectId, agentName, onSaved, onClose, router, makeRandomSuffix]
  );

  const generateAgent = useCallback(async () => {
    const selectedStudies = matchedStudies.filter((s) => s.selected);
    let resolvedCorpusId = completedCorpusId || corpusJobStatus?.corpusId;
    
    if (!resolvedCorpusId && selectedJsonFile?.name) {
      resolvedCorpusId = extractCorpusIdFromSummaryJsonFilename(selectedJsonFile.name);
    }

    const corpusLabel =
      corpusName.trim() ||
      resolvedCorpusId ||
      'corpus';
    const computedName = withClinicalAgentPrefix(
      buildReportAgentName({
        corpusLabel,
        studies: selectedStudies.map((s) => ({ protocolNumber: s.protocolNumber, title: s.title, pdfName: s.pdfName })) })
    );
    setAgentName(computedName);

    const metaFilesSelectedForAgent = metaFiles.filter((f) => f.selected);
    if (metaFiles.length > 0 && metaFilesSelectedForAgent.length === 0) {
      alert('Select at least one biomaterial PDF to include in the agent, or use the header checkbox to select all.');
      return;
    }

    if (
      !biomaterialSkipped &&
      metaFilesSelectedForAgent.length === 0 &&
      sec1SelectionRequiresBiomaterialCorpus(sec1Steps.filter((s) => s.selected))
    ) {
      alert(
        'Your template includes HB_Table but there are no biomaterial documents. Add a biomaterial corpus, or use “Skip biomaterial” on the Biomaterial Corpus step when HB does not apply.'
      );
      return;
    }

    setGeneratingAgent(true);

    try {
      const resolvedCorpusName = corpusName.trim() || resolvedCorpusId || 'corpus';

      let sharedInstruction = sharedMetaInstruction.trim();
      if (metaFilesSelectedForAgent.length > 0 && !sharedInstruction) {
        try {
          const res = await fetch('/api/templates/sect1-meta-steps', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ sheetId: TEMPLATES_SHEET_ID }) });
          if (res.ok) {
            const data = (await res.json()) as { sharedInstruction?: string };
            sharedInstruction = typeof data.sharedInstruction === 'string' ? data.sharedInstruction.trim() : '';
            if (sharedInstruction) setSharedMetaInstruction(sharedInstruction);
          }
        } catch {
        }
      }
      const response = await fetch('/api/ai-agents/report-creation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentName: computedName,
          studies: selectedStudies.map(study => ({
            id: study.id,
            fileName: study.pdfName,
            docTitle: study.title,
            summary: study.summary,
            keywords: study.keywords.join(', '),
            studyType: study.studyType,
            templateId: study.matchedTemplateId,
            selected: true,
            protocolNumber: (study.protocolNumber || '').trim(),
            userInput: study.userInput })),
          sec3Steps: sec3Steps
            .filter(s => s.selected)
            .map(s => ({ id: s.id, name: s.name, instruction: s.instruction, userInput: s.userInput })),
          sec1Steps: sec1Steps
            .filter(s => s.selected)
            .map(s => ({ id: s.id, name: s.name, instruction: s.instruction, userInput: s.userInput })),
          ...(metaFilesSelectedForAgent.length > 0
            ? { sharedMetaInstruction: sharedInstruction }
            : metaTemplateStepsTouched
              ? {
                  sect1MetaSteps: metaTemplateSteps
                    .filter((s) => s.selected)
                    .map((s) => ({
                      id: s.id,
                      typeName: s.name,
                      instruction: s.instruction,
                      keywords: s.keywords,
                      userInput: s.userInput })) }
              : {}),
          metaFiles: metaFilesSelectedForAgent.map((f) => ({
            id: f.id,
            name: f.name,
            metaStepId: f.metaStepId.trim(),
            userInput: f.userInput })),
          biomaterialSkipped,
          ...(!biomaterialSkipped && metaFilesSelectedForAgent.length > 0
            ? {
                metaCorpusId: completedMetaCorpusId ?? undefined,
                metaCorpusName: metaCorpusName.trim() || completedMetaCorpusId || 'meta-corpus' }
            : {}),
          templatesSheetId: TEMPLATES_SHEET_ID,
          templatesSource: 'gsheet',
          corpusId: resolvedCorpusId,
          corpusName: resolvedCorpusName,
          reportCreationDisplayName: reportCreationSessionName.trim() }) });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to generate agent');
      }

      const agent = (await response.json()) as GeneratedAgent;
      setGeneratedAgent(agent);
      const saveOutcome = await saveGeneratedAgentToProjectAndNavigate(agent);
      if (saveOutcome !== 'saved') {
        setActiveView('matching');
      } else {
        if (projectId && rcSession.session?.sessionId) {
          void rcSession.deleteSession(projectId, rcSession.session.sessionId).catch(() => {});
        }
      }
    } catch (error) {
      console.error('Agent generation failed:', error);
      setErrorDetails({
        message: error instanceof Error ? error.message : 'Failed to generate agent',
        timestamp: new Date().toISOString() });
      setShowErrorModal(true);
      setActiveView('matching');
    } finally {
      setGeneratingAgent(false);
    }
  }, [
    matchedStudies,
    sec3Steps,
    sec1Steps,
    metaFiles,
    completedMetaCorpusId,
    metaCorpusName,
    buildReportAgentName,
    completedCorpusId,
    corpusJobStatus?.corpusId,
    corpusName,
    selectedJsonFile,
    withClinicalAgentPrefix,
    metaTemplateSteps,
    metaTemplateStepsTouched,
    sharedMetaInstruction,
    saveGeneratedAgentToProjectAndNavigate,
    rcSession,
    projectId,
    reportCreationSessionName,
    biomaterialSkipped,
  ]);

  const openMetaConfirm = useCallback(
    async (opts?: { backTarget?: 'matching' | 'metacorpus' }) => {
      metaConfirmBackTargetRef.current = opts?.backTarget ?? 'metacorpus';

      try {
        const response = await fetch('/api/templates/sect1-meta-steps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ sheetId: TEMPLATES_SHEET_ID }) });
        await throwIfHttpNotOk(response, 'Failed to load biomaterial template steps', notSignedInMsg);
        const data = (await response.json()) as { steps?: unknown; sharedInstruction?: string };
        const shared = typeof data.sharedInstruction === 'string' ? data.sharedInstruction.trim() : '';
        const steps: Sect1MetaStepRow[] = Array.isArray(data.steps) ? (data.steps as Sect1MetaStepRow[]) : [];
        setSharedMetaInstruction(shared);
        setMetaConfirmSteps(steps);
        setMetaTemplateSteps([]);
        setMetaTemplateStepsTouched(false);
        setMetaFiles((prev) =>
          prev.map((f) => {
            const match = matchMetaFileToStep(f.name, steps);
            const fallbackId = match?.id ?? steps[0]?.id ?? '';
            const preserved =
              f.metaStepId && steps.some((s) => s.id === f.metaStepId) ? f.metaStepId : null;
            return {
              ...f,
              metaStepId: preserved ?? fallbackId,
              userInput: f.userInput,
              keywords: f.keywords,
              selected: f.selected ?? true };
          })
        );
        setActiveView('metaconfirm');
      } catch (error) {
        console.error('Failed to load biomaterial meta templates:', error);
        const net = isBrowserNetworkFetchError(error);
        setErrorDetails({
          message: net
            ? 'Network error while loading biomaterial template steps.'
            : error instanceof Error
              ? error.message
              : 'Failed to load biomaterial template steps',
          ...(net ? { hint: networkFetchHint } : {}),
          timestamp: new Date().toISOString() });
        setShowErrorModal(true);
      }
    },
    [matchedStudies, TEMPLATES_SHEET_ID, metaFiles]
  );

  const openSec3Confirm = useCallback(async (opts?: { backTarget?: 'matching' | 'metacorpus' | 'metaconfirm' }) => {
    sec3BackTargetRef.current = opts?.backTarget ?? 'metaconfirm';

    setLoadingSec3(true);
    try {
      const response = await fetch('/api/templates/sec3-steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetId: TEMPLATES_SHEET_ID }) });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(errText || `Failed to load Section 3 steps (${response.status})`);
      }
      const data = await response.json();
      const loaded: Sec3Step[] = (data.steps || []).map(
        (s: { id: string; name: string; instruction: string; keywords?: string[] }) => ({
          ...s,
          keywords: Array.isArray(s.keywords) ? s.keywords : [],
          selected: true,
          userInput: '' })
      );
      setSec3Steps(loaded);
      setActiveView('sec3confirm');
    } catch (error) {
      console.error('Failed to load Sec3 steps:', error);
      setErrorDetails({
        message: error instanceof Error ? error.message : 'Failed to load Section 3 steps',
        timestamp: new Date().toISOString() });
      setShowErrorModal(true);
    } finally {
      setLoadingSec3(false);
    }
  }, [matchedStudies, agentName, TEMPLATES_SHEET_ID]);

  const continueFromSection2ToBiomaterialStep = useCallback(() => {
    void openMetaConfirm({ backTarget: 'matching' });
  }, [openMetaConfirm]);

  const createMetaCorpus = useCallback(async () => {
    if (!sanitizedReportCreationPrefix) {
      alert(
        'Enter a session name first (above). It is required before ingesting biomaterial documents.'
      );
      return;
    }
    if (!canAccessBiomaterialStep) {
      alert(
        'Finish Clinical Study Reports first: create the corpus, wait for summaries (or load clinical summary Corpus), then continue to Biomaterial.'
      );
      return;
    }
    if (biomaterialSkipped) {
      setBiomaterialSkipped(false);
      void rcSession.patchSession(projectId, { biomaterialSkipped: false }).catch(() => {});
    }
    if (metaSelectedFileIds.size === 0) {
      alert('Please select at least one file');
      return;
    }
    if (corpusSelectionMode === 'new' && !metaCorpusName.trim()) {
      alert('Please provide a corpus name');
      return;
    }
    if (corpusSelectionMode === 'existing' && !selectedExistingCorpusId) {
      alert('Please select an existing corpus');
      return;
    }

    const metaFilesForRequest = Object.values(metaSelectedFilesMeta);
    if (metaFilesForRequest.length === 0) {
      alert('No file metadata found. Please re-select the files.');
      return;
    }

    setMetaCreating(true);
    if (metaSummaryPollRef.current) clearInterval(metaSummaryPollRef.current);
    setMetaSummaryJobStatus(null);
    const nowIso = new Date().toISOString();

    try {
      const isAddToExisting = corpusSelectionMode === 'existing' && Boolean(selectedExistingCorpusId);
      const response = await fetch('/api/rag/corpora', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          isAddToExisting
            ? {
                mode: 'existing' as const,
                existingCorpusId: selectedExistingCorpusId,
                selectedFileIds: Array.from(metaSelectedFileIds),
                allowPartialSuccess,
                files: metaFilesForRequest.map((f) => {
                  const fileData: DriveFileWithPageRange = {
                    ...f,
                    size: (f as DriveFile & { size?: number }).size ?? 0 };
                  if (metaFilePageRanges[f.id]) {
                    fileData.pageRange = metaFilePageRanges[f.id];
                  }
                  return fileData;
                }) }
            : {
                mode: 'new' as const,
                selectedFileIds: Array.from(metaSelectedFileIds),
                allowPartialSuccess,
                files: metaFilesForRequest.map((f) => {
                  const fileData: DriveFileWithPageRange = {
                    ...f,
                    size: (f as DriveFile & { size?: number }).size ?? 0 };
                  if (metaFilePageRanges[f.id]) {
                    fileData.pageRange = metaFilePageRanges[f.id];
                  }
                  return fileData;
                }),
                displayName: metaCorpusName.trim(),
                folderId: metaFilesForRequest[0]?.parents?.[0] || '' }
        ) });

      if (response.ok) {
        const { jobId } = await response.json();
        void rcSession.saveBiomaterialFiles(
          projectId,
          metaFilesForRequest.map((f) => ({
            id: f.id, name: f.name,
            mimeType: (f as DriveFile & { mimeType?: string }).mimeType ?? '',
            size: (f as DriveFile & { size?: number }).size,
            pageRange: metaFilePageRanges[f.id] })),
          corpusSelectionMode,
          metaCorpusName.trim()
        ).catch(() => {});
        void rcSession.bindJob(projectId, { stage: 'biomaterial_corpus', jobId }).catch(() => {});
        setMetaCorpusJobStatus({
          jobId,
          status: 'pending',
          displayName: metaCorpusName.trim(),
          folderId: '',
          totalFiles: metaFilesForRequest.length,
          processedFiles: 0,
          createdAt: nowIso,
          updatedAt: nowIso });
        setMetaFiles(
          metaFilesForRequest.map((f) => ({
            id: f.id,
            name: f.name,
            metaStepId: '',
            userInput: '',
            keywords: [],
            selected: true }))
        );
        setActiveView('metaprocessing');
        setMetaCreating(false);

        if (metaPollRef.current) clearInterval(metaPollRef.current);
        metaPollRef.current = setInterval(async () => {
          try {
            const statusRes = await fetch(`/api/rag/jobs/${jobId}`);
            if (statusRes.ok) {
              const job = await statusRes.json();
              setMetaCorpusJobStatus(job);
              if (job.status === 'completed' || job.status === 'completed_with_errors') {
                if (metaPollRef.current) clearInterval(metaPollRef.current);
                setCompletedMetaCorpusId(job.corpusId || null);
                const corpusId = job.corpusId as string | undefined;
                const files = metaFilesRef.current;
                if (!corpusId || files.length === 0) {
                  setActiveView('metacorpus');
                  return;
                }
                const summaryPendingIso = new Date().toISOString();
                setMetaSummaryJobStatus({
                  jobId: 'pending',
                  status: 'pending',
                  displayName: 'Corpus summary',
                  folderId: '',
                  totalFiles: files.length,
                  processedFiles: 0,
                  createdAt: summaryPendingIso,
                  updatedAt: summaryPendingIso });
                void (async () => {
                  try {
                    const outputFolderId = await ensureReportCreationCorpusFolder();
                    const response = await fetch('/api/rag/corpora/summaries', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        corpusId,
                        folderId: outputFolderId,
                        outputFileName: buildSummaryJsonFileName('biomaterial', corpusId),
                        files: files.map((f) => ({ id: f.id, name: f.name })) }) });
                    if (!response.ok) {
                      const errorData = (await response.json().catch(() => ({}))) as { error?: string };
                      throw new Error(errorData.error || `Failed to start summary job (${response.status})`);
                    }
                    const data = (await response.json()) as { jobId: string };
                    const summaryJobId = data.jobId;
                    void rcSession.bindJob(projectId, { stage: 'biomaterial_summary', jobId: summaryJobId, corpusId }).catch(() => {});
                    if (metaSummaryPollRef.current) clearInterval(metaSummaryPollRef.current);
                    metaSummaryPollRef.current = setInterval(async () => {
                      try {
                        const statusRes = await fetch(`/api/rag/jobs/${summaryJobId}`);
                        if (statusRes.ok) {
                          const summaryJob = await statusRes.json() as {
                            status: JobStatus['status'];
                            error?: string;
                            errorDetails?: unknown;
                          };
                          setMetaSummaryJobStatus((prev) => ({
                            jobId: summaryJobId,
                            status: summaryJob.status,
                            displayName: 'Corpus summary',
                            folderId: '',
                            totalFiles: files.length,
                            processedFiles: prev?.processedFiles ?? 0,
                            createdAt: summaryPendingIso,
                            updatedAt: new Date().toISOString(),
                            error: summaryJob.error,
                            errorDetails: summaryJob.errorDetails }));
                          if (summaryJob.status === 'completed' || summaryJob.status === 'completed_with_errors') {
                            if (metaSummaryPollRef.current) clearInterval(metaSummaryPollRef.current);
                            setMetaSummaryJobStatus(null);
                            setActiveView(completedCorpusIdRef.current ? 'done' : 'corpus');
                          } else if (summaryJob.status === 'failed') {
                            if (metaSummaryPollRef.current) clearInterval(metaSummaryPollRef.current);
                            setMetaSummaryJobStatus(null);
                            setErrorDetails(summaryJob.errorDetails || { message: summaryJob.error });
                            setShowErrorModal(true);
                            setActiveView('metacorpus');
                          }
                        }
                      } catch (e) {
                        console.error('Biomaterial summary polling failed', e);
                      }
                    }, 2000);
                  } catch (e) {
                    setMetaSummaryJobStatus(null);
                    setErrorDetails({
                      message: e instanceof Error ? e.message : 'Failed to summarize biomaterial corpus',
                      timestamp: new Date().toISOString() });
                    setShowErrorModal(true);
                    setActiveView('metacorpus');
                  }
                })();
              } else if (job.status === 'failed') {
                if (metaPollRef.current) clearInterval(metaPollRef.current);
                setErrorDetails(job.errorDetails || { message: job.error });
                setShowErrorModal(true);
                setActiveView('metacorpus');
              }
            }
          } catch (e) {
            console.error('Meta corpus polling failed', e);
          }
        }, 2000);
      } else {
        setMetaCreating(false);
        const data = await response.json();
        setErrorDetails(data.details || data);
        setShowErrorModal(true);
      }
    } catch (error) {
      setMetaCreating(false);
      setErrorDetails({
        message: error instanceof Error ? error.message : 'Failed to create meta corpus',
        timestamp: new Date().toISOString() });
      setShowErrorModal(true);
    }
  }, [
    metaCorpusName,
    metaSelectedFileIds,
    metaSelectedFilesMeta,
    metaFilePageRanges,
    corpusSelectionMode,
    selectedExistingCorpusId,
    allowPartialSuccess,
    ensureReportCreationCorpusFolder,
    buildSummaryJsonFileName,
    sanitizedReportCreationPrefix,
    canAccessBiomaterialStep,
    rcSession,
    projectId,
    biomaterialSkipped,
  ]);

  const openSec1Confirm = useCallback(async () => {
    setLoadingSec1(true);
    try {
      const response = await fetch('/api/templates/sec1-steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetId: TEMPLATES_SHEET_ID }) });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(errText || `Failed to load Section 1 steps (${response.status})`);
      }
      const data = await response.json();
      const loaded: Sec1Step[] = (data.steps || []).map(
        (s: { id: string; name: string; instruction: string; keywords?: string[] }) => ({
          ...s,
          keywords: Array.isArray(s.keywords) ? s.keywords : [],
          selected: true,
          userInput: '' })
      );
      setSec1Steps(loaded);
      setActiveView('sec1confirm');
    } catch (error) {
      console.error('Failed to load Sec1 steps:', error);
      setErrorDetails({
        message: error instanceof Error ? error.message : 'Failed to load Section 1 steps',
        timestamp: new Date().toISOString() });
      setShowErrorModal(true);
    } finally {
      setLoadingSec1(false);
    }
  }, [TEMPLATES_SHEET_ID]);

  const handleRenameStep = useCallback((layerId: string, name: string) => {
    if (!generatedAgent) return;
    setGeneratedAgent({
      ...generatedAgent,
      layers: generatedAgent.layers.map(l => l.id === layerId ? { ...l, name } : l) });
  }, [generatedAgent]);

  const handleUpdateModel = useCallback((layerId: string, model: string) => {
    if (!generatedAgent) return;
    setGeneratedAgent({
      ...generatedAgent,
      layers: generatedAgent.layers.map(l => l.id === layerId ? { ...l, selectedModel: model } : l) });
  }, [generatedAgent]);

  const handleUpdateUserInstruction = useCallback((layerId: string, value: string) => {
    if (!generatedAgent) return;
    setGeneratedAgent({
      ...generatedAgent,
      layers: generatedAgent.layers.map(l => l.id === layerId ? { ...l, userInstruction: value } : l) });
  }, [generatedAgent]);

  const handleUpdateUserInput = useCallback((layerId: string, value: string) => {
    if (!generatedAgent) return;
    setGeneratedAgent({
      ...generatedAgent,
      layers: generatedAgent.layers.map(l => l.id === layerId ? { ...l, userInput: value } : l) });
  }, [generatedAgent]);

  const handleRemoveBibItem = useCallback((layerId: string, itemIndex: number) => {
    if (!generatedAgent) return;
    setGeneratedAgent({
      ...generatedAgent,
      layers: generatedAgent.layers.map(layer =>
        layer.id === layerId
          ? { ...layer, bibliography: (layer.bibliography || []).filter((_, i) => i !== itemIndex) }
          : layer
      )
    });
  }, [generatedAgent]);

  const handleAddBibItem = useCallback((layerId: string) => {
    if (!generatedAgent) return;
    const value = bibInputs[layerId]?.trim();
    if (!value) return;

    const newItem: BibliographyItem = {
      name: value,
      path: value,
      type: 'file',
      description: `Reference document: ${value}`
    };

    setGeneratedAgent({
      ...generatedAgent,
      layers: generatedAgent.layers.map(layer =>
        layer.id === layerId
          ? { ...layer, bibliography: [...(layer.bibliography || []), newItem] }
          : layer
      ) });
    setBibInputs(prev => ({ ...prev, [layerId]: '' }));
  }, [generatedAgent, bibInputs]);

  const handleSaveAgent = useCallback(async () => {
    if (!generatedAgent || !projectId) return;

    setGeneratingAgent(true);
    try {
      await saveGeneratedAgentToProjectAndNavigate(generatedAgent);
    } finally {
      setGeneratingAgent(false);
    }
  }, [generatedAgent, projectId, saveGeneratedAgentToProjectAndNavigate]);

  const handleDownloadAgent = useCallback(() => {
    if (!generatedAgent) return;
    const dataStr = JSON.stringify(generatedAgent, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeAgentFile = generatedAgent.name.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'agent';
    a.download = sanitizedReportCreationPrefix
      ? `${sanitizedReportCreationPrefix}_report_${safeAgentFile}.json`
      : `${safeAgentFile}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }, [generatedAgent, sanitizedReportCreationPrefix]);

  const showPreview = activeView === 'matching' && generatedAgent !== null;

  const genericTutorialScreenKey = useMemo((): ReportCreationGenericTutorialKey | null => {
    if (!session) return null;
    if (!sessionIntroCompleted) return 'session';
    switch (activeView) {
      case 'corpus':
      case 'metacorpus':
      case 'metaconfirm':
        return null;
      case 'matching':
        return showPreview ? 'matchingPreview' : 'matching';
      case 'processing':
      case 'done':
      case 'metaprocessing':
      case 'sec3confirm':
      case 'sec1confirm':
      case 'generating':
        return activeView;
      default:
        return null;
    }
  }, [session, sessionIntroCompleted, activeView, showPreview]);

  useEffect(() => {
    setGenericWizardTutorialStep(0);
  }, [genericTutorialScreenKey]);

  const reportCreationHeaderSectionLabel = useMemo(
    () =>
      getReportCreationHeaderLabel(t, {
        hasSession: Boolean(session),
        sessionIntroCompleted,
        activeView,
        showPreview }),
    [t, session, sessionIntroCompleted, activeView, showPreview],
  );

  useEffect(() => {
    if (!sessionIntroCompleted || !projectId) return;
    const VIEW_TO_STAGE_NAV: Partial<Record<typeof activeView, import('@/app/lib/reportCreation/sessionTypes').ReportCreationStage>> = {
      corpus: 'clinical_corpus_select',
      processing: 'clinical_corpus_running',
      metacorpus: 'biomaterial_corpus_select',
      metaprocessing: 'biomaterial_corpus_running',
      done: 'matching_ready',
      matching: 'matching_in_progress',
      metaconfirm: 'meta_confirm',
      sec3confirm: 'sec3_confirm',
      sec1confirm: 'sec1_confirm',
      generating: 'agent_generated' };
    const stage = VIEW_TO_STAGE_NAV[activeView];
    if (!stage) return;
    void rcSession.patchSession(projectId, { currentStage: stage }).catch(() => {});

  }, [activeView, sessionIntroCompleted, projectId]);

  const lastSavedSnapshotRef = useRef<string>('');

  const VIEW_TO_STAGE_MAP: Partial<Record<typeof activeView, import('@/app/lib/reportCreation/sessionTypes').ReportCreationStage>> = {
    corpus: 'clinical_corpus_select',
    processing: 'clinical_corpus_running',
    metacorpus: 'biomaterial_corpus_select',
    metaprocessing: 'biomaterial_corpus_running',
    done: 'matching_ready',
    matching: 'matching_in_progress',
    metaconfirm: 'meta_confirm',
    sec3confirm: 'sec3_confirm',
    sec1confirm: 'sec1_confirm',
    generating: 'agent_generated' };

  const buildMatchingPatch = useCallback(() => ({
    agentName,
    studyOverrides: matchedStudies.map((s) => ({
      studyId: s.id,
      matchedTemplateId: s.matchedTemplateId ?? '',
      selected: s.selected ?? true,
      userInput: s.userInput ?? '' })),
    sec3Overrides: sec3Steps.map((s) => ({
      stepId: s.id,
      selected: s.selected,
      userInput: s.userInput })),
    sec1Overrides: sec1Steps.map((s) => ({
      stepId: s.id,
      selected: s.selected,
      userInput: s.userInput })),
    metaFileOverrides: metaFiles.map((f) => ({
      fileId: f.id,
      metaStepId: f.metaStepId,
      selected: f.selected,
      userInput: f.userInput })) }), [agentName, matchedStudies, sec3Steps, sec1Steps, metaFiles]);

  const buildMatchingPatchRef = useRef(buildMatchingPatch);
  useEffect(() => { buildMatchingPatchRef.current = buildMatchingPatch; }, [buildMatchingPatch]);

  const flushSessionState = useCallback((force = false): Promise<void> => {
    if (!sessionIntroCompleted || !projectId) return Promise.resolve();
    const downstreamViews: (typeof activeView)[] = [
      'done', 'matching', 'metaconfirm', 'sec3confirm', 'sec1confirm', 'generating',
    ];
    const hasMatchingState = downstreamViews.includes(activeView);
    const currentStage = VIEW_TO_STAGE_MAP[activeView];
    const patch: import('@/app/lib/reportCreation/sessionTypes').UpdateSessionPayload = {
      ...(currentStage ? { currentStage } : {}),
      ...(hasMatchingState ? { matching: buildMatchingPatchRef.current() } : {}) };
    const snapshot = JSON.stringify({ activeView, matching: (patch as Record<string, unknown>).matching ?? null });
    if (!force && snapshot === lastSavedSnapshotRef.current) return Promise.resolve();
    lastSavedSnapshotRef.current = snapshot;
    return rcSession.patchSession(projectId, patch).catch(() => {});

  }, [sessionIntroCompleted, rcSession, projectId, activeView]);

  const flushSessionStateRef = useRef(flushSessionState);
  useEffect(() => { flushSessionStateRef.current = flushSessionState; }, [flushSessionState]);

  const matchingSaveTimerRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    if (!sessionIntroCompleted || !rcSession.session || !projectId) return;
    const downstreamViews: (typeof activeView)[] = [
      'done', 'matching', 'metaconfirm', 'sec3confirm', 'sec1confirm', 'generating',
    ];
    if (!downstreamViews.includes(activeView)) return;
    if (matchingSaveTimerRef.current) clearTimeout(matchingSaveTimerRef.current);
    matchingSaveTimerRef.current = setTimeout(() => {
      void rcSession.patchSession(projectId, {
        matching: buildMatchingPatch() }).catch(() => {});
    }, 1500);
    return () => {
      if (matchingSaveTimerRef.current) clearTimeout(matchingSaveTimerRef.current);
    };

  }, [agentName, matchedStudies, sec3Steps, sec1Steps, metaFiles, activeView, sessionIntroCompleted, projectId]);

  useEffect(() => {
    if (!pendingSec3OverridesRef.current || sec3Steps.length === 0) return;
    const overrides = pendingSec3OverridesRef.current;
    pendingSec3OverridesRef.current = null;
    setSec3Steps((prev) =>
      prev.map((s) => {
        const o = overrides.find((ov) => ov.stepId === s.id);
        return o ? { ...s, selected: o.selected, userInput: o.userInput } : s;
      })
    );
  }, [sec3Steps]);

  useEffect(() => {
    if (!pendingSec1OverridesRef.current || sec1Steps.length === 0) return;
    const overrides = pendingSec1OverridesRef.current;
    pendingSec1OverridesRef.current = null;
    setSec1Steps((prev) =>
      prev.map((s) => {
        const o = overrides.find((ov) => ov.stepId === s.id);
        return o ? { ...s, selected: o.selected, userInput: o.userInput } : s;
      })
    );
  }, [sec1Steps]);

  const canSaveAgent = useMemo(() => {
    if (!generatedAgent) return false;
    if (!generatedAgent.layers || generatedAgent.layers.length === 0) return false;
    return generatedAgent.layers.every((l) => typeof l.userInstruction === 'string' && l.userInstruction.trim().length > 0);
  }, [generatedAgent]);

  const draftingTemplatesSheetList = useMemo(
    () => Object.values(templates).filter((t): t is TemplateData => Boolean(t?.id)),
    [templates]
  );

  useEffect(() => {
    if (!isOpen || !projectId) return;
    void checkReportCreationCorpusFolder();
  }, [isOpen, projectId, checkReportCreationCorpusFolder]);

  useEffect(() => {
    if (!isOpen || !projectId || !session?.accessToken) return;
    if (selectedFolderRef.current !== null) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/rag/drive/folder/${encodeURIComponent(projectId)}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled) return;
        if (selectedFolderRef.current !== null) return;

        const projectName = data.folder?.name ? String(data.folder.name) : 'Project';

        setSelectedFolder({ id: projectId, name: projectName });
        setCurrentFolderId(projectId);
        setBreadcrumbs([{ id: projectId, name: projectName }]);
        setFileTypeFilter('all');
        setSelectedFileIds(new Set());
        setSelectedFilesMeta({});
        setFilePageRanges({});
        setMetaSelectedFileIds(new Set());
        setMetaSelectedFilesMeta({});
        setMetaFilePageRanges({});

        autoNavFolderRef.current = null;
        await loadFolderContents(projectId);
      } catch {
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, projectId, session?.accessToken, loadFolderContents]);

  const reloadExistingJsonFiles = useCallback(async () => {
    if (!selectedFolder) {
      setExistingJsonFiles([]);
      setAutoSelectedJsonFile(null);
      setAutoSelectedBiomaterialJsonFile(null);
      return;
    }
    setAutoSelectedJsonFile(null);
    setAutoSelectedBiomaterialJsonFile(null);
    setLoadingExistingJson(true);
    try {
      const r = await fetch(`/api/projects/${selectedFolder.id}/folders/report_creation_corpus/files`);
      if (!r.ok) throw new Error('not found');
      const data = await r.json();
      const jsonFiles: DriveFile[] = (data.files || []).filter((f: DriveFile) =>
        /\.json$/i.test(f.name || '') && !f.name?.startsWith('report-session-')
      );
      setExistingJsonFiles(jsonFiles);
    } catch {
      setExistingJsonFiles([]);
    } finally {
      setLoadingExistingJson(false);
    }
  }, [selectedFolder]);

  useEffect(() => {
    void reloadExistingJsonFiles();
  }, [reloadExistingJsonFiles]);

  useEffect(() => {
    if (!selectedFolder || currentFolderId !== selectedFolder.id) return;
    if (folderItems.length === 0) return;
    if (autoNavFolderRef.current === selectedFolder.id) return;
    autoNavFolderRef.current = selectedFolder.id;

    const pdfsFolder = folderItems.find(
      (item) =>
        item.name === 'PDFs' &&
        item.mimeType === 'application/vnd.google-apps.folder'
    );
    if (pdfsFolder) {
      void navigateToFolder(pdfsFolder.id, 'PDFs');
    }
  }, [selectedFolder, currentFolderId, folderItems, navigateToFolder]);

  useEffect(() => {
    if (!readyForSummaries) return;
    if (!completedCorpusId && !corpusJobStatus?.corpusId) return;
    if (summaryJobStatus || summaryError) return;

    startSummaryJob();
  }, [readyForSummaries, completedCorpusId, corpusJobStatus?.corpusId, summaryJobStatus, summaryError, startSummaryJob]);

  useEffect(() => {
    if (activeView !== 'done') return;
    if (loadingTemplates) return;

    if (matchedStudies.length > 0) {
      setActiveView('matching');
      return;
    }

    startMatchingProcess();
  }, [activeView, matchedStudies.length, loadingTemplates, startMatchingProcess]);

  const dismissGenericWizardTutorial = useCallback(() => {
    setGenericWizardTutorialStep(0);
  }, []);

  const goNextGenericWizardTutorial = useCallback(() => {
    setGenericWizardTutorialStep((s) => {
      if (!genericTutorialScreenKey) return 0;
      const max = genericTutorial[genericTutorialScreenKey].length;
      if (s <= 0) return 1;
      if (s >= max) return 0;
      return s + 1;
    });
  }, [genericTutorialScreenKey]);

  const goPrevGenericWizardTutorial = useCallback(() => {
    setGenericWizardTutorialStep((s) => (s > 1 ? s - 1 : 1));
  }, []);

  const startGenericWizardTutorial = useCallback(() => {
    setCorpusLayoutTutorialStep(0);
    setMetaCorpusLayoutTutorialStep(0);
    setMetaConfirmTutorialStep(0);
    if (genericTutorialScreenKey) setGenericWizardTutorialStep(1);
  }, [genericTutorialScreenKey]);

  const handleCloseModal = useCallback(async () => {
    const stageBeingSaved = VIEW_TO_STAGE_MAP[activeView] ?? '(no stage mapped)';
    console.log(`[ReportCreation] X pressed — activeView="${activeView}" → saving stage="${stageBeingSaved}"`);
    if (sessionIntroCompleted && projectId) {
      setIsSavingOnClose(true);
      try {
        await flushSessionState(true);
      } finally {
        setIsSavingOnClose(false);
      }
    }
    onClose();
  }, [flushSessionState, onClose, activeView, sessionIntroCompleted, projectId]);

  const reportTutorialTitle = useMemo(() => {
    if (sessionStatus !== 'authenticated') {
      return t('reportCreationModal.tutorialTitleNeedSignIn');
    }
    if (!sessionIntroCompleted) {
      return t('reportCreationModal.tutorialTitleSessionTips');
    }
    if (activeView === 'corpus') {
      return t('reportCreationModal.tutorialTitleCorpusLayout');
    }
    if (activeView === 'metacorpus') {
      return t('reportCreationModal.tutorialTitleMetaCorpusLayout');
    }
    if (activeView === 'metaconfirm') {
      return t('reportCreationModal.tutorialTitleMetaConfirm');
    }
    if (genericTutorialScreenKey) {
      return t('reportCreationModal.tutorialTitleGenericStep');
    }
    return t('reportCreationModal.tutorialTitleFallback');
  }, [
    sessionStatus,
    sessionIntroCompleted,
    activeView,
    genericTutorialScreenKey,
    t,
  ]);

   if (!isOpen || !portalContainer) return null;
 
  const corpusProcessed = corpusJobStatus?.processedFiles ?? 0;
  const corpusTotal = corpusJobStatus?.totalFiles ?? selectedFileNames.length;
  const corpusProgress = corpusTotal > 0 ? Math.min(100, Math.round((corpusProcessed / corpusTotal) * 100)) : 0;
  const corpusStatusLabel =
    corpusJobStatus?.status === 'failed'
      ? 'Corpus creation failed'
      : corpusJobStatus?.status === 'completed_with_errors'
        ? 'Corpus created (with errors)'
        : corpusJobStatus?.status === 'completed'
          ? 'Corpus created'
          : `Processing ${corpusProcessed}/${corpusTotal || 0} files...`;

   const summaryProcessed = summaryJobStatus?.processedFiles ?? 0;
   const summaryTotal = summaryJobStatus?.totalFiles ?? summaryFiles.length;
   const summaryProgress = summaryTotal > 0 ? Math.min(100, Math.round((summaryProcessed / summaryTotal) * 100)) : 0;
   const summaryStatusLabel = summaryJobStatus?.status === 'failed'
     ? 'Summary generation failed'
     : summaryJobStatus?.status === 'completed'
       ? 'Summary files saved'
       : `Processing ${summaryProcessed}/${summaryTotal || 0} files...`;

  const isSummariesStage = Boolean(summaryJobStatus || summaryError);
  const isCorpusStage =
    !isSummariesStage &&
    Boolean(corpusJobStatus && !['completed', 'completed_with_errors'].includes(corpusJobStatus.status));
  const isAwaitNextStage =
    !isSummariesStage &&
    !isCorpusStage &&
    Boolean(readyForSummaries && (completedCorpusId || corpusJobStatus?.corpusId));

  const showCorpusLayoutTutorialOverlay = Boolean(
    session && activeView === 'corpus' && corpusLayoutTutorialStep > 0
  );
  const showMetaCorpusLayoutTutorialOverlay = Boolean(
    session && activeView === 'metacorpus' && metaCorpusLayoutTutorialStep > 0
  );
  const showMetaConfirmTutorialOverlay = Boolean(
    session && activeView === 'metaconfirm' && metaConfirmTutorialStep > 0
  );
  const activeLayoutTutorialStep =
    activeView === 'metacorpus' ? metaCorpusLayoutTutorialStep : corpusLayoutTutorialStep;

  const canUseReportLayoutTutorial =
    sessionStatus === 'authenticated' &&
    (activeView === 'metacorpus' ||
      activeView === 'metaconfirm' ||
      (activeView === 'corpus' && sessionIntroCompleted));

  const isReportLayoutTutorialOpen =
    (activeView === 'corpus' && corpusLayoutTutorialStep > 0) ||
    (activeView === 'metacorpus' && metaCorpusLayoutTutorialStep > 0) ||
    (activeView === 'metaconfirm' && metaConfirmTutorialStep > 0);

  const genericTutorialMaxSteps =
    genericTutorialScreenKey !== null
      ? genericTutorial[genericTutorialScreenKey].length
      : 0;

  const currentGenericTutorialSlide =
    genericTutorialScreenKey &&
    genericWizardTutorialStep > 0 &&
    genericWizardTutorialStep <= genericTutorialMaxSteps
      ? genericTutorial[genericTutorialScreenKey][genericWizardTutorialStep - 1]
      : null;

  const corpusLayoutVariant = activeView === 'metacorpus' ? 'biomaterial' : 'clinical';
  const currentCorpusLayoutSlide =
    activeLayoutTutorialStep >= 1 && activeLayoutTutorialStep <= 4
      ? getCorpusLayoutTutorialSlide(
          t,
          activeLayoutTutorialStep as 1 | 2 | 3 | 4,
          corpusLayoutVariant,
        )
      : null;
  const currentMetaConfirmSlide =
    metaConfirmTutorialStep >= 1 && metaConfirmTutorialStep <= 7
      ? getMetaConfirmTutorialSlide(t, metaConfirmTutorialStep as 1 | 2 | 3 | 4 | 5 | 6 | 7)
      : null;

  const showGenericWizardTutorialOverlay = Boolean(
    session && genericTutorialScreenKey && genericWizardTutorialStep > 0
  );

  const canOpenReportTutorial =
    sessionStatus === 'authenticated' && (canUseReportLayoutTutorial || genericTutorialScreenKey !== null);

  const pulseReportTutorialButton =
    canOpenReportTutorial && !isReportLayoutTutorialOpen && genericWizardTutorialStep === 0;

   const modalContent = (
     <div
       className="report-creation-overlay"
       style={{
         position: 'fixed',
         inset: 0,
         background: 'rgba(17, 7, 74, 0.6)',
         display: 'flex',
         alignItems: 'center',
         justifyContent: 'center',
         zIndex: 10000,
         backdropFilter: 'blur(8px)',
         overflow: 'auto',
         padding: '1rem' }}
     >
       <div
         ref={modalRef}
         className="report-creation-modal"
         onClick={(e) => e.stopPropagation()}
         style={{
           width: `${REPORT_CREATION_MODAL_WIDTH_PX}px`,
           height: `${REPORT_CREATION_MODAL_HEIGHT_PX}px`,
           maxWidth: '98vw',
           maxHeight: '98vh',
           backgroundColor: '#ffffff',
           borderRadius: '16px',
           boxShadow: '0 25px 50px -12px rgba(17, 7, 74, 0.35)',
           display: 'flex',
           flexDirection: 'column',
           overflow: 'hidden',
           position: 'relative',
           fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
           border: '1px solid #AFA8BA' }}
       >
         <div
           style={{
             display: 'flex',
             justifyContent: 'space-between',
             alignItems: 'flex-start',
             gap: '0.75rem',
             padding: '1rem 1.5rem',
             borderBottom: '1px solid #AFA8BA',
             background: 'linear-gradient(135deg, #11074A 0%, #4A4453 100%)',
             color: 'white',
             flexShrink: 0 }}
         >
           <div
             style={{
               display: 'flex',
               alignItems: 'flex-start',
               gap: '0.75rem',
               flex: 1,
               minWidth: 0 }}
           >
             <FaBrain size={20} style={{ flexShrink: 0, marginTop: '0.2rem' }} />
             <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '0.35rem', minWidth: 0, flex: 1 }}>
               {activeView === 'metaconfirm' && (
                 <span
                   style={{
                     fontSize: '0.875rem',
                     fontWeight: 800,
                     letterSpacing: '0.1em',
                     color: 'rgba(255,255,255,0.98)',
                     lineHeight: 1.3,
                     textTransform: 'uppercase' }}
                 >
                   {t('reportCreationModal.headerBioMaterial')}
                 </span>
               )}
               {reportCreationHeaderSectionLabel !== sessionNameHeaderLabel && activeView !== 'metaconfirm' && (
                 <span
                   style={{
                     fontSize: '0.875rem',
                     fontWeight: 800,
                     letterSpacing: '0.1em',
                     color: 'rgba(255,255,255,0.98)',
                     lineHeight: 1.3,
                     textTransform: 'uppercase' }}
                 >
                   {reportCreationHeaderSectionLabel}
                 </span>
               )}
             </div>
           </div>
           <div
             style={{
               display: 'flex',
               alignItems: 'center',
               gap: '0.5rem',
               flexShrink: 0 }}
           >
             <button
               type="button"
               className={pulseReportTutorialButton ? 'report-creation-tutorial-button-pulse' : undefined}
               onClick={() => {
                 if (!sessionIntroCompleted) {
                   if (genericTutorialScreenKey === 'session') startGenericWizardTutorial();
                   return;
                 }
                 if (activeView === 'corpus') {
                   startCorpusLayoutTutorial();
                 } else if (activeView === 'metacorpus') {
                   startMetaCorpusLayoutTutorial();
                 } else if (activeView === 'metaconfirm') {
                   startMetaConfirmTutorial();
                 } else if (genericTutorialScreenKey) {
                   startGenericWizardTutorial();
                 }
               }}
               disabled={!canOpenReportTutorial}
               title={reportTutorialTitle}
               aria-label={t('reportCreationModal.tutorialAria')}
               style={{
                 background: 'rgba(255,255,255,0.15)',
                 border: '1px solid rgba(255,255,255,0.3)',
                 borderRadius: '8px',
                 padding: '0.45rem 0.75rem',
                 cursor: canOpenReportTutorial ? 'pointer' : 'not-allowed',
                 color: 'white',
                 display: 'flex',
                 alignItems: 'center',
                 gap: '0.4rem',
                 fontSize: '0.8rem',
                 fontWeight: 600,
                 transition: 'all 0.2s ease',
                 opacity: canOpenReportTutorial ? 1 : 0.55 }}
               onMouseEnter={(e) => {
                 if (canOpenReportTutorial) {
                   e.currentTarget.style.background = 'rgba(255,255,255,0.25)';
                 }
               }}
               onMouseLeave={(e) => {
                 e.currentTarget.style.background = 'rgba(255,255,255,0.15)';
               }}
             >
               <FaGraduationCap size={15} aria-hidden />
               {t('reportCreationModal.tutorial')}
             </button>
             <button
               type="button"
               onClick={handleCloseModal}
               disabled={isSavingOnClose}
               aria-label={t('agentnodesPage.common.close')}
               style={{
                 background: 'rgba(255,255,255,0.15)',
                 border: '1px solid rgba(255,255,255,0.3)',
                 borderRadius: '8px',
                 padding: '0.5rem',
                 cursor: isSavingOnClose ? 'not-allowed' : 'pointer',
                 color: 'white',
                 display: 'flex',
                 flexShrink: 0,
                 transition: 'all 0.2s ease',
                 opacity: isSavingOnClose ? 0.6 : 1 }}
               onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.25)'}
               onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.15)'}
             >
               {isSavingOnClose ? <FaSpinner size={16} className="animate-spin" /> : <FaTimes size={16} />}
             </button>
           </div>
         </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            position: 'relative' }}
        >
          {!session ? (
            <div className="flex min-h-full flex-1 items-center justify-center p-8 bg-white">
              <p className="text-gray-600">{t('reportCreationModal.signInToManageRag')}</p>
            </div>
          ) : !sessionIntroCompleted ? (
            <div
              className={`flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto overflow-x-hidden bg-gray-50 px-6 py-8 ${
                showGenericWizardTutorialOverlay ? 'pb-44' : ''
              }`}
              style={{ minHeight: 0 }}
            >
              <div
                className="box-border flex w-full max-w-3xl flex-shrink-0 flex-col items-center gap-8"
                style={{ width: '100%' }}
              >
                <section className="w-full text-center" aria-labelledby="report-creation-session-intro-heading">
                  <h1
                    id="report-creation-session-intro-heading"
                    className="text-2xl font-bold leading-tight text-gray-900 sm:text-3xl"
                  >
                    <span className="block">{t('reportCreationModal.session.titleLine1')}</span>
                    <span className="mt-1 block">{t('reportCreationModal.session.titleLine2')}</span>
                  </h1>
                  <p className="mt-4 text-sm italic leading-relaxed text-gray-800">
                    {t('reportCreationModal.session.intro1')}
                  </p>
                  <p className="mt-3 text-sm italic leading-relaxed text-gray-800">
                    {t('reportCreationModal.session.intro2')}
                  </p>
                </section>
              <div
                className="box-border w-full max-w-[32rem] flex-shrink-0"
                style={{ width: '100%' }}
              >
                {}
                {showResumePrompt && driveSessionList.length > 0 && (
                  <div
                    className="mb-5 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
                    role="region"
                    aria-label={t('reportCreationModal.session.resumeAria')}
                  >
                    <div className="flex items-start justify-between gap-3 border-b border-slate-100 bg-slate-50 px-4 py-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700">
                          <FaHistory size={14} aria-hidden />
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-slate-900">{t('reportCreationModal.session.savedSessionsTitle')}</p>
                          <p className="text-xs text-slate-500">
                            {t('reportCreationModal.session.savedSessionsSub')}
                          </p>
                        </div>
                      </div>
                      <span className="shrink-0 rounded-full bg-slate-200/80 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                        {driveSessionList.length}
                      </span>
                    </div>
                    {driveSessionList.length > 5 && (
                      <p className="border-b border-slate-100 px-4 py-2 text-[11px] text-slate-500">
                        {t('reportCreationModal.session.showingRecent')}
                      </p>
                    )}
                    <ul className="divide-y divide-slate-100 px-2 py-2">
                      {driveSessionList.slice(0, 5).map((entry) => {
                        const rowBusy =
                          deletingAllSessions ||
                          deletingSessionId === entry.sessionId ||
                          resumingSessionId === entry.sessionId;
                        return (
                          <li key={entry.sessionId}>
                            <div className="group flex items-center gap-1 rounded-lg px-1 py-0.5 transition-colors hover:bg-slate-50">
                              <button
                                type="button"
                                disabled={rowBusy}
                                onClick={() => void handleResumeSession(entry)}
                                className="flex min-w-0 flex-1 items-center gap-3 rounded-lg py-2 pl-2 pr-1 text-left disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-500 group-hover:bg-indigo-50 group-hover:text-indigo-600">
                                  {resumingSessionId === entry.sessionId ? (
                                    <FaSpinner className="animate-spin" size={14} aria-hidden />
                                  ) : (
                                    <FaFileAlt size={14} aria-hidden />
                                  )}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-sm font-medium text-slate-900">
                                    {entry.sessionName}
                                  </span>
                                  <span className="mt-0.5 block truncate text-xs text-slate-500">
                                    {formatResumeStage(entry.currentStage)}
                                  </span>
                                </span>
                                <FaChevronRight
                                  className="mr-1 shrink-0 text-slate-300 transition group-hover:text-indigo-500"
                                  size={12}
                                  aria-hidden
                                />
                              </button>
                              <button
                                type="button"
                                disabled={rowBusy}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleDismissResumeSession(entry);
                                }}
                                aria-label={t('reportCreationModal.session.removeSessionAria', { name: entry.sessionName })}
                                title={t('reportCreationModal.session.removeTitle')}
                                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                              >
                                {deletingSessionId === entry.sessionId ? (
                                  <FaSpinner className="animate-spin" size={12} aria-hidden />
                                ) : (
                                  <FaTimes size={12} aria-hidden />
                                )}
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                    <div className="border-t border-slate-100 bg-slate-50/80 px-4 py-3">
                      <div className="flex items-center justify-between gap-4">
                        <button
                          type="button"
                          disabled={deletingAllSessions || !!deletingSessionId || !!resumingSessionId}
                          onClick={() => setShowResumePrompt(false)}
                          className="text-sm font-medium text-indigo-700 hover:text-indigo-900 disabled:opacity-50"
                        >
                          {t('reportCreationModal.session.startNewSession')}
                        </button>
                        <button
                          type="button"
                          disabled={deletingAllSessions || !!deletingSessionId || !!resumingSessionId}
                          onClick={() => void handleDismissAllResumeSessions()}
                          className="text-sm text-slate-500 transition hover:text-red-600 disabled:opacity-50"
                        >
                          {deletingAllSessions ? (
                            <span className="inline-flex items-center gap-1.5">
                              <FaSpinner className="animate-spin" size={12} aria-hidden />
                              {t('reportCreationModal.session.clearing')}
                            </span>
                          ) : (
                            t('reportCreationModal.session.clearAllSaved')
                          )}
                        </button>
                      </div>
                      {clearAllSessionsError && (
                        <p className="mt-2 text-right text-xs text-red-600" role="alert">
                          {clearAllSessionsError}
                          <span className="mt-0.5 block text-slate-500">
                            {t('reportCreationModal.session.clearAllRetryHint')}
                          </span>
                        </p>
                      )}
                    </div>
                  </div>
                )}
                {loadingDriveSessions && (
                  <p className="mb-3 text-center text-xs text-gray-400">
                    <FaSpinner className="mr-1 inline animate-spin" aria-hidden />
                    {t('reportCreationModal.session.checkingSessions')}
                  </p>
                )}
                <input
                  id="report-creation-session-name"
                  type="text"
                  value={reportCreationSessionName}
                  onChange={(e) => setReportCreationSessionName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && sessionPrefixReady) {
                      e.preventDefault();
                      setSessionIntroCompleted(true);
                      setActiveCorpusTarget('clinical');
                      setActiveView('corpus');
                      void rcSession.createSession(projectId, reportCreationSessionName.trim()).catch(() => {});
                    }
                  }}
                  placeholder={t('reportCreationModal.session.placeholder')}
                  autoComplete="off"
                  aria-label={t('reportCreationModal.session.nameAria')}
                  aria-required="true"
                  aria-invalid={!sessionPrefixReady}
                  aria-describedby="report-creation-session-name-hint"
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: '0.75rem 1rem',
                    borderRadius: '14px',
                    border: `2px solid ${sessionPrefixReady ? '#c7c3d4' : '#f59e0b'}`,
                    fontSize: '1rem',
                    outline: 'none',
                    background: '#fafafe',
                    textAlign: 'center',
                    boxShadow: sessionPrefixReady
                      ? 'inset 0 1px 2px rgba(17, 7, 74, 0.06)'
                      : '0 0 0 3px rgba(245, 158, 11, 0.2)' }}
                />
                <p
                  id="report-creation-session-name-hint"
                  className="text-center"
                  style={{
                    margin: '0.6rem 0 0',
                    fontSize: '0.78rem',
                    color: sessionPrefixReady ? '#6b7280' : '#b45309',
                    lineHeight: 1.45 }}
                >
                  {sessionPrefixReady ? (
                    t('reportCreationModal.session.hintReady', { prefix: `${sanitizedReportCreationPrefix}_report_` })
                  ) : (
                    t('reportCreationModal.session.hintPrefix')
                  )}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setSessionIntroCompleted(true);
                    setActiveCorpusTarget('clinical');
                    setActiveView('corpus');
                    void rcSession.createSession(projectId, reportCreationSessionName.trim()).catch(() => {});
                  }}
                  disabled={!sessionPrefixReady}
                  style={{
                    marginTop: '1.35rem',
                    width: '100%',
                    padding: '0.75rem 1.25rem',
                    borderRadius: '14px',
                    border: 'none',
                    fontSize: '0.95rem',
                    fontWeight: 700,
                    cursor: sessionPrefixReady ? 'pointer' : 'not-allowed',
                    background: sessionPrefixReady ? '#11074A' : '#c4c4cc',
                    color: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.5rem' }}
                >
                  {t('reportCreationModal.buttons.continue')}
                </button>
              </div>
              </div>
            </div>
          ) : (
            <div
              className={`relative flex min-h-0 flex-1 flex-col overflow-auto bg-white ${
                showCorpusLayoutTutorialOverlay ||
                showMetaCorpusLayoutTutorialOverlay ||
                showGenericWizardTutorialOverlay
                  ? 'pb-44'
                  : ''
              }`}
              style={{ minHeight: 0 }}
            >
            <div className="box-border flex min-h-0 w-full flex-1 flex-col p-6">
               {showErrorModal && (
                 <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                   <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[80vh] overflow-hidden flex flex-col">
                     <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between bg-white">
                       <h3 className="text-lg font-semibold" style={{ color: '#11074A' }}>
                         {(() => {
                           if (errorDetails && typeof errorDetails === 'object') {
                             const details = errorDetails as Record<string, unknown>;
                             if (typeof details.title === 'string' && details.title.trim()) return details.title;
                           }
                           return t('reportCreationModal.error');
                         })()}
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
 
                     <div className="p-6 overflow-y-auto flex-1">
                       <p className="text-gray-700 mb-4">
                         {(() => {
                           if (errorDetails && typeof errorDetails === 'object') {
                             const details = errorDetails as Record<string, unknown>;
                             if (typeof details.message === 'string' && details.message.trim()) return details.message;
                           }
                           return t('reportCreationModal.errorDefaultMessage');
                         })()}
                       </p>
                       {(() => {
                         if (errorDetails && typeof errorDetails === 'object') {
                           const details = errorDetails as Record<string, unknown>;
                           if (typeof details.hint === 'string' && details.hint.trim()) {
                             return (
                               <p className="text-sm text-gray-600 mb-4 leading-relaxed">{details.hint}</p>
                             );
                           }
                         }
                         return null;
                       })()}
 
                       <div className="relative">
                         <button
                           onClick={copyError}
                           className="absolute top-2 right-2 px-3 py-2 text-white rounded text-sm flex items-center gap-2 transition-colors z-10"
                           style={{ backgroundColor: '#11074A' }}
                          title={t('reportCreationModal.copyErrorTitle')}
                        >
                          {copied ? (
                            <>
                              <FaCheckCircle size={14} />
                              {t('reportCreationModal.copied')}
                            </>
                          ) : (
                            <>
                              <FaCopy size={14} />
                              {t('reportCreationModal.copy')}
                            </>
                          )}
                         </button>
 
                         <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-sm font-mono border border-gray-700">
                           <code>{JSON.stringify(errorDetails, null, 2)}</code>
                         </pre>
                       </div>
                     </div>
 
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
                         {t('reportCreationModal.close')}
                       </button>
                     </div>
                   </div>
                 </div>
               )}
 
               {activeView === 'processing' && (
                 <div className="max-w-3xl mx-auto flex flex-col items-center justify-center min-h-[60vh] text-center">
                   <div style={{ marginBottom: '1.25rem' }}>
                     <span style={{ fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.12em', padding: '0.2rem 0.7rem', borderRadius: '4px', background: '#11074A', color: '#fff', textTransform: 'uppercase' }}>{t('reportCreationModal.processing.clinicalBadge')}</span>
                   </div>
                  {isCorpusStage && (
                    <>
                      <div className="text-2xl font-semibold mb-3" style={{ color: '#11074A' }}>
                        {t('reportCreationModal.processing.creatingCorpus')}
                      </div>
                      <div className="text-sm text-gray-600 mb-6">
                        {corpusStatusLabel}
                      </div>
                      {corpusJobStatus?.status === 'completed_with_errors' &&
                        Array.isArray(corpusJobStatus.logs) &&
                        corpusJobStatus.logs.some((l) => l.level === 'warn' && l.message.toLowerCase().includes('failed')) && (
                          <div className="w-full mt-4 p-4 rounded-lg border border-amber-200 bg-amber-50 text-left">
                            <div className="text-sm font-semibold text-amber-800 mb-2">
                              {t('reportCreationModal.processing.pdfChunksWarning')}
                            </div>
                            <div className="text-xs text-amber-800 space-y-1 max-h-40 overflow-y-auto">
                              {corpusJobStatus.logs
                                .filter((l) => l.level === 'warn')
                                .slice(-10)
                                .map((l, idx) => (
                                  <div key={`${l.timestamp}-${idx}`} className="font-mono">
                                    {l.message}
                                  </div>
                                ))}
                            </div>
                          </div>
                        )}
                      <div className="w-full bg-gray-200 rounded-full h-4 overflow-hidden">
                        <div
                          className="h-4 rounded-full transition-all duration-300"
                          style={{ width: `${corpusProgress}%`, backgroundColor: '#11074A' }}
                        />
                      </div>
                      <div className="text-xs text-gray-500 mt-3">
                        {t('reportCreationModal.processing.percentComplete', { percent: corpusProgress })}
                      </div>
                    </>
                  )}

                  {isAwaitNextStage && (
                    <>
                      <div className="text-2xl font-semibold mb-3" style={{ color: '#11074A' }}>
                        {t('reportCreationModal.processing.corpusReady')}
                      </div>
                      <div className="text-sm text-gray-600 mb-6">
                        {t('reportCreationModal.processing.startingSummaries', { count: summaryFiles.length })}
                      </div>
                      <FaSpinner className="animate-spin text-2xl" style={{ color: '#11074A' }} />
                    </>
                  )}

                  {isSummariesStage && (
                    <>
                      <div className="text-2xl font-semibold mb-3" style={{ color: '#11074A' }}>
                        {t('reportCreationModal.processing.generatingSummaries')}
                      </div>
                      <div className="text-sm text-gray-600 mb-6">
                        {summaryStatusLabel}
                      </div>
                      <div className="w-full bg-gray-200 rounded-full h-4 overflow-hidden">
                        <div
                          className="h-4 rounded-full transition-all duration-300"
                          style={{ width: `${summaryProgress}%`, backgroundColor: '#11074A' }}
                        />
                      </div>
                      <div className="text-xs text-gray-500 mt-3">
                        {t('reportCreationModal.processing.percentComplete', { percent: summaryProgress })}
                      </div>
                      {summaryError && (
                        <div className="mt-4 text-sm text-red-600">
                          {summaryError}
                        </div>
                      )}
                      {summaryError && (
                        <button
                          onClick={() => setActiveView('corpus')}
                          className="mt-4 px-4 py-2 rounded-lg border border-gray-300 text-sm"
                          style={{ color: '#11074A' }}
                        >
                          {t('reportCreationModal.processing.backToCorpus')}
                        </button>
                      )}
                    </>
                  )}
                 </div>
               )}

               {activeView === 'done' && (
                 <div className="max-w-3xl mx-auto flex flex-col items-center justify-center min-h-[60vh] text-center">
                   <div style={{ marginBottom: '1.25rem' }}>
                     <span style={{ fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.12em', padding: '0.2rem 0.7rem', borderRadius: '4px', background: '#11074A', color: '#fff', textTransform: 'uppercase' }}>{t('reportCreationModal.done.clinicalBadge')}</span>
                   </div>
                   <div className="text-2xl font-semibold mb-3" style={{ color: '#11074A' }}>
                     {t('reportCreationModal.done.summariesReady')}
                   </div>
                   {loadingTemplates ? (
                     <>
                       <div className="text-sm text-gray-600 mb-6">
                         {t('reportCreationModal.done.loadingTemplates')}
                       </div>
                       <FaSpinner className="animate-spin text-3xl" style={{ color: '#11074A' }} />
                     </>
                   ) : (
                     <>
                       <div className="text-sm text-gray-600 mb-6">
                         {t('reportCreationModal.done.preparingMatching')}
                       </div>
                       <button
                         type="button"
                         onClick={() => setActiveView('metacorpus')}
                         style={{
                           padding: '0.625rem 1.25rem',
                           border: '1px solid #d1d5db',
                           borderRadius: '8px',
                           background: '#fff',
                           cursor: 'pointer',
                           fontSize: '0.875rem',
                           color: '#374151' }}
                       >
                         {t('reportCreationModal.done.backToBiomaterial')}
                       </button>
                     </>
                   )}
                 </div>
               )}

               {activeView === 'matching' && (
                 <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
                   {!showPreview && (
                     <>
                       {Object.keys(templates).length === 0 && (
                         <div className="mx-6 mt-3 p-2 bg-yellow-50 border border-yellow-200 rounded text-xs text-yellow-800 flex items-center justify-between flex-shrink-0">
                           <span>{t('reportCreationModal.matching.noTemplates')}</span>
                           <button
                             type="button"
                             onClick={async () => {
                               setLoadingTemplates(true);
                               try {
                                 const loaded = await loadTemplatesFromSheet();
                                 setTemplates(loaded);
                                 if (Object.keys(loaded).length > 0) {
                                   setMatchedStudies((prev) =>
                                     prev.map((study) => {
                                       const { template, score, studyType } = matchKeywordsToTemplate(
                                         study.keywords ?? [],
                                         loaded
                                       );
                                       return {
                                         ...study,
                                         matchedTemplateId: template?.id || '',
                                         matchedTemplateName: template?.name || t('reportCreationModal.matching.noMatch'),
                                         studyType,
                                         matchScore: score };
                                     })
                                   );
                                 }
                               } catch (e) {
                                 console.error('Failed to reload templates:', e);
                               } finally {
                                 setLoadingTemplates(false);
                               }
                             }}
                             disabled={loadingTemplates}
                             className="px-2 py-1 bg-yellow-600 text-white rounded text-xs hover:bg-yellow-700 disabled:opacity-50"
                           >
                             {loadingTemplates ? t('reportCreationModal.matching.loadingTemplates') : t('reportCreationModal.buttons.reload')}
                           </button>
                         </div>
                       )}

                       {}
                       <div
                         style={{
                           flex: 1,
                           minHeight: 0,
                           overflow: 'auto',
                           padding: '1rem 1.5rem 1.5rem',
                           background: '#f9fafb' }}
                       >
                         {matchedStudies.length === 0 ? (
                           <p style={{ fontSize: '0.875rem', color: '#9ca3af' }}>{t('reportCreationModal.matching.noStudies')}</p>
                         ) : (
                           <div
                             style={{
                               overflow: 'auto',
                               borderTop: '3px solid #b45309',
                               backgroundColor: '#ffffff' }}
                           >
                             <table
                               style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}
                             >
                               <thead
                                 style={{
                                   backgroundColor: '#f9fafb',
                                   position: 'sticky',
                                   top: 0,
                                   zIndex: 1 }}
                               >
                                 <tr>
                                   <th
                                     style={{
                                       padding: '0.5rem',
                                       textAlign: 'left',
                                       borderBottom: '1px solid #e5e7eb',
                                       width: '36px' }}
                                   >
                                     <input
                                       type="checkbox"
                                       checked={
                                         matchedStudies.length > 0 &&
                                         matchedStudies.every((s) => s.selected)
                                       }
                                       onChange={() => {
                                         const all = matchedStudies.every((s) => s.selected);
                                         setMatchedStudies((prev) =>
                                           prev.map((s) => ({ ...s, selected: !all }))
                                         );
                                       }}
                                       aria-label={t('reportCreationModal.matching.selectAllAria')}
                                     />
                                   </th>
                                   <th
                                     style={{
                                       padding: '0.5rem',
                                       textAlign: 'left',
                                       borderBottom: '1px solid #e5e7eb',
                                       fontWeight: 600,
                                       color: '#374151',
                                       fontSize: '0.75rem',
                                       width: '52px' }}
                                   >
                                     #
                                   </th>
                                   <th
                                     style={{
                                       padding: '0.5rem',
                                       textAlign: 'left',
                                       borderBottom: '1px solid #e5e7eb',
                                       fontWeight: 600,
                                       color: '#374151',
                                       fontSize: '0.75rem',
                                       minWidth: '160px' }}
                                   >
                                     {wizardTableCol.item}
                                   </th>
                                   <th
                                     style={{
                                       padding: '0.5rem',
                                       textAlign: 'left',
                                       borderBottom: '1px solid #e5e7eb',
                                       fontWeight: 600,
                                       color: '#374151',
                                       fontSize: '0.75rem',
                                       minWidth: '180px' }}
                                   >
                                     {wizardTableCol.instruction}
                                   </th>
                                   <th
                                     style={{
                                       padding: '0.5rem',
                                       textAlign: 'left',
                                       borderBottom: '1px solid #e5e7eb',
                                       fontWeight: 600,
                                       color: '#374151',
                                       fontSize: '0.75rem',
                                       minWidth: '120px' }}
                                   >
                                     {wizardTableCol.keywords}
                                   </th>
                                   <th
                                     style={{
                                       padding: '0.5rem',
                                       textAlign: 'left',
                                       borderBottom: '1px solid #e5e7eb',
                                       fontWeight: 600,
                                       color: '#374151',
                                       fontSize: '0.75rem',
                                       minWidth: '200px' }}
                                   >
                                     {wizardTableCol.yourInput}
                                   </th>
                                 </tr>
                               </thead>
                               <tbody>
                                 {matchedStudies.map((study, idx) => {
                                   return (
                                     <tr
                                       key={study.id}
                                       style={{
                                         borderBottom: '1px solid #e5e7eb',
                                         verticalAlign: 'top',
                                         opacity: study.selected ? 1 : 0.45,
                                         background: idx % 2 === 0 ? '#ffffff' : '#fffaf0' }}
                                     >
                                       <td style={{ padding: '0.5rem' }}>
                                         <input
                                           type="checkbox"
                                           checked={study.selected}
                                           onChange={() =>
                                             setMatchedStudies((prev) =>
                                               prev.map((s) =>
                                                 s.id === study.id ? { ...s, selected: !s.selected } : s
                                               )
                                             )
                                           }
                                           aria-label={t('reportCreationModal.matching.includeItemAria', {
                                             name: study.pdfName || t('reportCreationModal.columns.item') })}
                                         />
                                       </td>
                                       <td style={{ padding: '0.5rem' }}>
                                         <span
                                           style={{
                                             display: 'inline-flex',
                                             alignItems: 'center',
                                             justifyContent: 'center',
                                             width: '24px',
                                             height: '24px',
                                             borderRadius: '50%',
                                             background: '#b45309',
                                             color: 'white',
                                             fontSize: '0.7rem',
                                             fontWeight: 700 }}
                                         >
                                           {idx + 1}
                                         </span>
                                       </td>
                                       <td style={{ padding: '0.5rem' }}>
                                         <div style={{ fontWeight: 600, color: '#11074A' }} className="truncate">
                                           {study.pdfName || '—'}
                                         </div>
                                         {study.protocolNumber ? (
                                           <div
                                             style={{ fontSize: '0.7rem', color: '#6b7280', marginTop: '2px' }}
                                             className="font-mono truncate"
                                           >
                                             {study.protocolNumber}
                                           </div>
                                         ) : null}
                                         {study.title ? (
                                           <div
                                             style={{
                                               fontSize: '0.72rem',
                                               color: '#4b5563',
                                               marginTop: '4px',
                                               lineHeight: 1.35 }}
                                           >
                                             {study.title}
                                           </div>
                                         ) : null}
                                       </td>
                                       <td style={{ padding: '0.5rem', maxWidth: '320px' }}>
                                         {draftingTemplatesSheetList.length > 0 ? (
                                           <select
                                               id={`study-template-${study.id}`}
                                               value={study.matchedTemplateId}
                                               onChange={(e) => updateStudyType(study.id, e.target.value)}
                                               aria-label={t('reportCreationModal.matching.instructionForAria', {
                                                 name: study.pdfName || t('reportCreationModal.columns.item') })}
                                               style={{
                                                 width: '100%',
                                                 maxWidth: '100%',
                                                 fontSize: '0.75rem',
                                                 fontWeight: 600,
                                                 color: '#111827',
                                                 padding: '0.4rem 0.5rem',
                                                 borderRadius: '8px',
                                                 border: '1px solid #d1d5db',
                                                 backgroundColor: '#fff',
                                                 cursor: 'pointer',
                                                 boxSizing: 'border-box' }}
                                             >
                                               {study.matchedTemplateId &&
                                               !draftingTemplatesSheetList.some((r) => r.id === study.matchedTemplateId) ? (
                                                 <option value={study.matchedTemplateId}>
                                                   {study.matchedTemplateName || study.matchedTemplateId}
                                                 </option>
                                               ) : null}
                                               {draftingTemplatesSheetList
                                                 .slice()
                                                 .sort((a, b) =>
                                                   a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
                                                 )
                                                 .map((row) => (
                                                   <option key={row.id} value={row.id}>
                                                     {row.name}
                                                   </option>
                                                 ))}
                                             </select>
                                         ) : (
                                           <div style={{ fontWeight: 600, color: '#111827', fontSize: '0.8rem' }}>
                                             {study.matchedTemplateName || study.studyType || '—'}
                                           </div>
                                         )}
                                       </td>
                                       <td style={{ padding: '0.5rem' }}>
                                         <details style={{ fontSize: '0.72rem' }}>
                                           <summary
                                             style={{
                                               cursor: 'pointer',
                                               userSelect: 'none',
                                               color: '#6b7280',
                                               fontWeight: 600,
                                               listStyle: 'none' }}
                                           >
                                            {t('reportCreationModal.matching.keywords')}
                                            {(study.keywords || []).length > 0
                                               ? ` (${(study.keywords || []).length})`
                                               : ''}
                                           </summary>
                                           <div
                                             style={{
                                               display: 'flex',
                                               flexWrap: 'wrap',
                                               gap: '0.35rem',
                                               marginTop: '0.4rem' }}
                                           >
                                             {(study.keywords || []).length
                                               ? (study.keywords || []).map((kw, kwIdx) => (
                                                   <span
                                                     key={`${study.id}-kw-${kwIdx}`}
                                                     style={{
                                                       fontSize: '0.68rem',
                                                       padding: '0.15rem 0.45rem',
                                                       borderRadius: '4px',
                                                       background: '#eef2ff',
                                                       color: '#3730a3',
                                                       border: '1px solid #d1d5ff' }}
                                                   >
                                                     {kw}
                                                   </span>
                                                 ))
                                               : (
                                                   <span style={{ color: '#9ca3af', fontSize: '0.75rem' }}>—</span>
                                                 )}
                                           </div>
                                         </details>
                                       </td>
                                       <td style={{ padding: '0.5rem', maxWidth: '420px' }}>
                                         <textarea
                                           value={study.userInput}
                                           onChange={(e) =>
                                             setMatchedStudies((prev) =>
                                               prev.map((s) =>
                                                 s.id === study.id ? { ...s, userInput: e.target.value } : s
                                               )
                                             )
                                           }
                                           placeholder={t('reportCreationModal.matching.userInputPlaceholder')}
                                           rows={3}
                                           style={{
                                             width: '100%',
                                             minWidth: '200px',
                                             fontSize: '0.75rem',
                                             color: '#374151',
                                             lineHeight: 1.4,
                                             border: '1px solid #d1d5db',
                                             borderRadius: '8px',
                                             padding: '0.45rem 0.55rem',
                                             resize: 'vertical',
                                             fontFamily: 'inherit',
                                             boxSizing: 'border-box' }}
                                         />
                                       </td>
                                     </tr>
                                   );
                                 })}
                               </tbody>
                             </table>
                           </div>
                         )}
                       </div>

                       <div
                         style={{
                           padding: '1rem 1.5rem',
                           borderTop: '1px solid #e5e7eb',
                           display: 'flex',
                           justifyContent: 'flex-end',
                           alignItems: 'center',
                           gap: '0.5rem',
                           flexShrink: 0,
                           backgroundColor: '#ffffff' }}
                       >
                         <button
                           type="button"
                           onClick={() => setActiveView('metacorpus')}
                           style={{
                             padding: '0.625rem 1rem',
                             border: '1px solid #d1d5db',
                             borderRadius: '8px',
                             background: '#fff',
                             cursor: 'pointer',
                             fontSize: '0.875rem',
                             whiteSpace: 'nowrap' }}
                         >
                           {t('reportCreationModal.buttons.back')}
                         </button>
                        <button
                          type="button"
                          onClick={continueFromSection2ToBiomaterialStep}
                         disabled={false}
                         title={t('reportCreationModal.matching.continueToBiomaterialTitle')}
                         style={{
                           padding: '0.625rem 1.25rem',
                           backgroundColor: '#11074A',
                           color: 'white',
                           border: 'none',
                           borderRadius: '8px',
                           cursor: 'pointer',
                           fontSize: '0.875rem',
                           fontWeight: 600,
                           display: 'flex',
                           alignItems: 'center',
                           gap: '0.5rem',
                            whiteSpace: 'nowrap' }}
                        >
                          {t('reportCreationModal.buttons.continue')}
                        </button>
                       </div>
                     </>
                   )}

                   {}
                   {showPreview && generatedAgent && (
                     <div
                       style={{
                         flex: 1,
                         minHeight: 0,
                         display: 'flex',
                         flexDirection: 'column',
                         overflow: 'hidden',
                         backgroundColor: '#f8f9fa' }}
                     >
                       <div style={{ flex: 1, overflow: 'auto', padding: '1rem 1.5rem' }}>
                         <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                           {generatedAgent.layers.map((layer, idx) => (
                             <div key={layer.id} style={{ 
                               border: '1px solid #e5e7eb', 
                               borderRadius: '12px', 
                               padding: '1rem', 
                               background: '#ffffff',
                               boxShadow: '0 2px 4px rgba(17, 7, 74, 0.05)' }}>
                               {}
                               <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '0.875rem' }}>
                                 <div style={{ 
                                   width: '28px', 
                                   height: '28px', 
                                   borderRadius: '50%', 
                                   display: 'flex', 
                                   alignItems: 'center', 
                                   justifyContent: 'center', 
                                   background: '#11074A', 
                                   color: 'white', 
                                   fontWeight: 800, 
                                   fontSize: '0.8rem', 
                                   flexShrink: 0 }}>
                                   {idx + 1}
                                 </div>
                                 <input
                                   value={layer.name}
                                   onChange={(e) => handleRenameStep(layer.id, e.target.value)}
                                   style={{ 
                                     flex: 1, 
                                     border: '1px solid #AFA8BA', 
                                     borderRadius: '8px', 
                                     padding: '0.5rem 0.75rem', 
                                     fontSize: '0.875rem', 
                                     fontWeight: 600, 
                                     color: '#11074A',
                                     outline: 'none' }}
                                 />
                                 <select
                                   value={layer.selectedModel}
                                   onChange={(e) => handleUpdateModel(layer.id, e.target.value)}
                                   style={{ 
                                     border: '1px solid #AFA8BA', 
                                     borderRadius: '8px', 
                                     padding: '0.5rem 0.75rem', 
                                     fontSize: '0.75rem', 
                                     color: '#11074A', 
                                     background: '#ffffff', 
                                     cursor: 'pointer' }}
                                 >
                                   {models.map((model) => (
                                     <option 
                                       key={model.value} 
                                       value={model.value}
                                       style={{ color: '#11074A', background: '#ffffff' }}
                                     >
                                       {model.label}
                                     </option>
                                   ))}
                                 </select>
                               </div>
                               
                               {}
                               <div style={{ marginBottom: '0.75rem' }}>
                                 <div style={{ color: '#11074A', fontSize: '0.75rem', marginBottom: '0.375rem', fontWeight: 700 }}>
                                   {t('reportCreationModal.matchingPreview.userInput')}
                                 </div>
                                 <textarea
                                   value={layer.userInput || ''}
                                   onChange={(e) => handleUpdateUserInput(layer.id, e.target.value)}
                                   placeholder={t('reportCreationModal.matchingPreview.userInputPlaceholder')}
                                   style={{ 
                                     width: '100%', 
                                     minHeight: '100px', 
                                     border: '2px solid #11074A', 
                                     borderRadius: '10px', 
                                     padding: '0.625rem 0.75rem', 
                                     fontSize: '0.8rem', 
                                     lineHeight: 1.5, 
                                     fontFamily: 'inherit',
                                     resize: 'vertical',
                                     color: '#11074A',
                                     outline: 'none' }}
                                 />
                               </div>

                               {}
                               <details style={{ marginBottom: '0.75rem' }}>
                                 <summary style={{ color: '#4A4453', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', marginBottom: '0.375rem' }}>
                                   {t('reportCreationModal.matchingPreview.userInstructionSummary')}
                                 </summary>
                                 <textarea
                                   value={layer.userInstruction}
                                   onChange={(e) => handleUpdateUserInstruction(layer.id, e.target.value)}
                                   placeholder={t('reportCreationModal.matchingPreview.userInstructionPlaceholder')}
                                   style={{ 
                                     width: '100%', 
                                     minHeight: '120px', 
                                     border: '1px solid #d1d5db', 
                                     borderRadius: '10px', 
                                     padding: '0.625rem 0.75rem', 
                                     fontSize: '0.8rem', 
                                     lineHeight: 1.5, 
                                     fontFamily: 'inherit',
                                     resize: 'vertical',
                                     color: '#374151',
                                     outline: 'none',
                                     marginTop: '0.35rem' }}
                                 />
                               </details>
                               
                              {}
                              <div>
                                <div style={{ color: '#4A4453', fontSize: '0.75rem', marginBottom: '0.375rem', fontWeight: 600 }}>
                                  {t('reportCreationModal.matchingPreview.bibliography')}
                                </div>
                                <div style={{ 
                                  border: '1px solid #d1d5db', 
                                  borderRadius: '10px', 
                                  padding: '0.5rem', 
                                  minHeight: '40px',
                                  display: 'flex',
                                  flexWrap: 'wrap',
                                  gap: '0.375rem',
                                  alignItems: 'center' }}>
                                  {(layer.bibliography || []).map((item, bibIdx) => (
                                    <span 
                                      key={bibIdx} 
                                      style={{ 
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '0.25rem',
                                        backgroundColor: '#e0e7ff', 
                                        color: '#3730a3', 
                                        padding: '0.25rem 0.5rem',
                                        borderRadius: '6px',
                                        fontSize: '0.75rem',
                                        fontWeight: 500 }}
                                    >
                                      {item.name}
                                      <button
                                        onClick={() => handleRemoveBibItem(layer.id, bibIdx)}
                                        style={{
                                          background: 'none',
                                          border: 'none',
                                          cursor: 'pointer',
                                          padding: '0',
                                          marginLeft: '0.125rem',
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'center',
                                          color: '#6366f1',
                                          fontSize: '0.875rem',
                                          lineHeight: 1 }}
                                        title={t('reportCreationModal.session.removeTitle')}
                                      >
                                        ×
                                      </button>
                                    </span>
                                  ))}
                                  {}
                                  <input
                                    type="text"
                                    value={bibInputs[layer.id] || ''}
                                    onChange={(e) => setBibInputs(prev => ({ ...prev, [layer.id]: e.target.value }))}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        e.preventDefault();
                                        handleAddBibItem(layer.id);
                                      }
                                    }}
                                    placeholder={layer.bibliography?.length ? t('reportCreationModal.matchingPreview.addBibMore') : t('reportCreationModal.matchingPreview.addBibPlaceholder')}
                                    style={{
                                      border: 'none',
                                      outline: 'none',
                                      background: 'transparent',
                                      fontSize: '0.75rem',
                                      flex: '1 1 80px',
                                      minWidth: '80px',
                                      padding: '0.25rem',
                                      color: '#374151' }}
                                  />
                                </div>
                              </div>
                             </div>
                           ))}
                         </div>
                       </div>
                       
                       {}
                       <div style={{ 
                         padding: '1rem 1.5rem', 
                         borderTop: '1px solid #e5e7eb', 
                         display: 'flex', 
                         justifyContent: 'flex-end', 
                         alignItems: 'center',
                         gap: '0.75rem',
                         backgroundColor: '#ffffff' }}>
                         <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'nowrap' }}>
                           <button 
                             onClick={handleDownloadAgent} 
                             style={{ 
                               padding: '0.625rem 1.25rem', 
                               backgroundColor: '#ffffff', 
                               border: '2px solid #e5e7eb', 
                               borderRadius: '10px', 
                               cursor: 'pointer', 
                               fontSize: '0.875rem', 
                               fontWeight: 600, 
                               display: 'flex', 
                               alignItems: 'center', 
                               gap: '0.5rem',
                               color: '#11074A' }}
                           >
                             <FaDownload size={14} /> {t('reportCreationModal.matchingPreview.downloadCorpus')}
                           </button>
                           <button 
                             onClick={handleSaveAgent}
                             disabled={generatingAgent || !canSaveAgent}
                             style={{ 
                               padding: '0.625rem 1.5rem', 
                               backgroundColor: generatingAgent || !canSaveAgent ? '#9ca3af' : '#11074A', 
                               color: 'white', 
                               border: 'none', 
                               borderRadius: '10px', 
                               cursor: generatingAgent || !canSaveAgent ? 'not-allowed' : 'pointer', 
                               fontSize: '0.875rem', 
                               fontWeight: 700, 
                               display: 'flex', 
                               alignItems: 'center', 
                               gap: '0.5rem',
                               boxShadow: generatingAgent || !canSaveAgent ? 'none' : '0 4px 12px rgba(17, 7, 74, 0.25)',
                               opacity: generatingAgent || !canSaveAgent ? 0.7 : 1 }}
                             title={
                               !canSaveAgent
                                 ? t('reportCreationModal.matchingPreview.cannotSaveEmptyInstruction')
                                 : undefined
                             }
                           >
                             {generatingAgent ? <FaSpinner className="animate-spin" size={14} /> : <FaSave size={14} />}
                             {t('reportCreationModal.matchingPreview.saveAgent')}
                           </button>
                         </div>
                       </div>
                     </div>
                   )}
                 </div>
               )}

               {activeView === 'metaconfirm' && (
                 <div style={{ display: 'flex', height: '100%', flexDirection: 'column', overflow: 'hidden' }}>
                   <div
                     ref={metaConfirmTutorialTableRef}
                     style={{
                       flex: 1,
                       overflow: 'auto',
                       borderTop: '3px solid #b45309',
                       backgroundColor: '#ffffff',
                       padding: '1rem 1.25rem' }}
                   >
                     <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
                       <thead
                         style={{
                           backgroundColor: '#f9fafb',
                           position: 'sticky',
                           top: 0,
                           zIndex: 1 }}
                       >
                         <tr>
                           <th
                             ref={metaConfirmTutorialThCheckboxRef}
                             className={metaConfirmTutorialStep === 2 ? 'rounded-lg ring-4 ring-amber-400 ring-offset-2' : ''}
                             style={{
                               padding: '0.5rem',
                               textAlign: 'left',
                               borderBottom: '1px solid #e5e7eb',
                               width: '36px' }}
                           >
                             <input
                               type="checkbox"
                               checked={metaFiles.length > 0 && metaFiles.every((f) => f.selected)}
                               onChange={() => {
                                 const all = metaFiles.every((f) => f.selected);
                                 setMetaFiles((prev) => prev.map((f) => ({ ...f, selected: !all })));
                               }}
                               aria-label={t('reportCreationModal.metaconfirm.selectAllAria')}
                             />
                           </th>
                           <th
                             ref={metaConfirmTutorialThNumRef}
                             className={metaConfirmTutorialStep === 3 ? 'rounded-lg ring-4 ring-amber-400 ring-offset-2' : ''}
                             style={{
                               padding: '0.5rem',
                               textAlign: 'left',
                               borderBottom: '1px solid #e5e7eb',
                               fontWeight: 600,
                               color: '#374151',
                               fontSize: '0.75rem',
                               width: '52px' }}
                           >
                             #
                           </th>
                           <th
                             ref={metaConfirmTutorialThItemRef}
                             className={metaConfirmTutorialStep === 4 ? 'rounded-lg ring-4 ring-amber-400 ring-offset-2' : ''}
                             style={{
                               padding: '0.5rem',
                               textAlign: 'left',
                               borderBottom: '1px solid #e5e7eb',
                               fontWeight: 600,
                               color: '#374151',
                               fontSize: '0.75rem',
                               minWidth: '140px' }}
                           >
                             {wizardTableCol.item}
                           </th>
                           <th
                             ref={metaConfirmTutorialThInstructionRef}
                             className={metaConfirmTutorialStep === 5 ? 'rounded-lg ring-4 ring-amber-400 ring-offset-2' : ''}
                             style={{
                               padding: '0.5rem',
                               textAlign: 'left',
                               borderBottom: '1px solid #e5e7eb',
                               fontWeight: 600,
                               color: '#374151',
                               fontSize: '0.75rem',
                               minWidth: '180px' }}
                           >
                             {wizardTableCol.instruction}
                           </th>
                           <th
                             ref={metaConfirmTutorialThKeywordsRef}
                             className={metaConfirmTutorialStep === 6 ? 'rounded-lg ring-4 ring-amber-400 ring-offset-2' : ''}
                             style={{
                               padding: '0.5rem',
                               textAlign: 'left',
                               borderBottom: '1px solid #e5e7eb',
                               fontWeight: 600,
                               color: '#374151',
                               fontSize: '0.75rem',
                               minWidth: '120px' }}
                           >
                             {wizardTableCol.keywords}
                           </th>
                           <th
                             ref={metaConfirmTutorialThYourInputRef}
                             className={metaConfirmTutorialStep === 7 ? 'rounded-lg ring-4 ring-amber-400 ring-offset-2' : ''}
                             style={{
                               padding: '0.5rem',
                               textAlign: 'left',
                               borderBottom: '1px solid #e5e7eb',
                               fontWeight: 600,
                               color: '#374151',
                               fontSize: '0.75rem',
                               minWidth: '200px' }}
                           >
                             {wizardTableCol.yourInput}
                           </th>
                         </tr>
                       </thead>
                       <tbody>
                         {metaFiles.map((file, idx) => (
                           <tr
                             key={file.id}
                             style={{
                               borderBottom: '1px solid #e5e7eb',
                               verticalAlign: 'top',
                               opacity: file.selected ? 1 : 0.45,
                               background: idx % 2 === 0 ? '#ffffff' : '#fffaf0' }}
                           >
                             <td style={{ padding: '0.5rem' }}>
                               <input
                                 type="checkbox"
                                 checked={file.selected}
                                 onChange={() =>
                                   setMetaFiles((prev) =>
                                     prev.map((row) =>
                                       row.id === file.id ? { ...row, selected: !row.selected } : row
                                     )
                                   )
                                 }
                                 aria-label={`Include ${file.name || 'this PDF'} in the agent`}
                               />
                             </td>
                             <td style={{ padding: '0.5rem' }}>
                               <span
                                 style={{
                                   display: 'inline-flex',
                                   alignItems: 'center',
                                   justifyContent: 'center',
                                   width: '24px',
                                   height: '24px',
                                   borderRadius: '50%',
                                   background: '#b45309',
                                   color: 'white',
                                   fontSize: '0.7rem',
                                   fontWeight: 700 }}
                               >
                                 {idx + 1}
                               </span>
                             </td>
                             <td style={{ padding: '0.5rem' }}>
                               <div style={{ fontWeight: 600, color: '#11074A', fontSize: '0.8rem', wordBreak: 'break-all' }}>
                                 {file.name}
                               </div>
                             </td>
                             <td style={{ padding: '0.5rem', maxWidth: '320px' }}>
                               {metaConfirmSteps.length > 0 ? (
                                 <select
                                   id={`meta-confirm-step-${file.id}`}
                                   value={file.metaStepId}
                                   onChange={(e) =>
                                     setMetaFiles((prev) =>
                                       prev.map((row) =>
                                         row.id === file.id ? { ...row, metaStepId: e.target.value } : row
                                       )
                                     )
                                   }
                                   aria-label={`Instruction for ${file.name || 'this biomaterial PDF'}`}
                                   style={{
                                     width: '100%',
                                     maxWidth: '100%',
                                     fontSize: '0.75rem',
                                     fontWeight: 600,
                                     color: '#111827',
                                     padding: '0.4rem 0.5rem',
                                     borderRadius: '8px',
                                     border: '1px solid #d1d5db',
                                     backgroundColor: '#fff',
                                     cursor: 'pointer',
                                     boxSizing: 'border-box' }}
                                 >
                                   {file.metaStepId &&
                                   !metaConfirmSteps.some((r) => r.id === file.metaStepId) ? (
                                     <option value={file.metaStepId}>
                                       {file.metaStepId}
                                     </option>
                                   ) : null}
                                   {metaConfirmSteps
                                     .slice()
                                     .sort((a, b) =>
                                       a.typeName.localeCompare(b.typeName, undefined, { sensitivity: 'base' })
                                     )
                                     .map((row) => (
                                       <option key={row.id} value={row.id}>
                                         {row.typeName}
                                       </option>
                                     ))}
                                 </select>
                               ) : (
                                 <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>
                                   {t('reportCreationModal.metaconfirm.openFromSection2')}
                                 </div>
                               )}
                             </td>
                             <td style={{ padding: '0.5rem' }}>
                               <details style={{ fontSize: '0.72rem' }}>
                                 <summary
                                   style={{
                                     cursor: 'pointer',
                                     userSelect: 'none',
                                     color: '#6b7280',
                                     fontWeight: 600,
                                     listStyle: 'none' }}
                                 >
                                   Keywords
                                   {(file.keywords || []).length > 0
                                     ? ` (${(file.keywords || []).length})`
                                     : ''}
                                 </summary>
                                 <div
                                   style={{
                                     display: 'flex',
                                     flexWrap: 'wrap',
                                     gap: '0.35rem',
                                     marginTop: '0.4rem' }}
                                 >
                                   {(file.keywords || []).length ? (
                                     (file.keywords || []).map((kw, kwIdx) => (
                                       <span
                                         key={`${file.id}-kw-${kwIdx}`}
                                         style={{
                                           fontSize: '0.68rem',
                                           padding: '0.15rem 0.45rem',
                                           borderRadius: '4px',
                                           background: '#eef2ff',
                                           color: '#3730a3',
                                           border: '1px solid #d1d5ff' }}
                                       >
                                         {kw}
                                       </span>
                                     ))
                                   ) : (
                                     <span style={{ color: '#9ca3af', fontSize: '0.75rem' }}>—</span>
                                   )}
                                 </div>
                               </details>
                             </td>
                             <td style={{ padding: '0.5rem', maxWidth: '420px' }}>
                               <textarea
                                 value={file.userInput}
                                 onChange={(e) =>
                                   setMetaFiles((prev) =>
                                     prev.map((row) =>
                                       row.id === file.id ? { ...row, userInput: e.target.value } : row
                                     )
                                   )
                                 }
                                 placeholder={t('reportCreationModal.metaconfirm.userInputPlaceholder')}
                                 rows={3}
                                 style={{
                                   width: '100%',
                                   minWidth: '200px',
                                   fontSize: '0.75rem',
                                   color: '#374151',
                                   lineHeight: 1.4,
                                   border: '1px solid #d1d5db',
                                   borderRadius: '8px',
                                   padding: '0.45rem 0.55rem',
                                   resize: 'vertical',
                                   fontFamily: 'inherit',
                                   boxSizing: 'border-box' }}
                               />
                             </td>
                           </tr>
                         ))}
                         {metaFiles.length === 0 && (
                           <tr>
                             <td
                               colSpan={6}
                               style={{ padding: '2rem', textAlign: 'center', color: '#9ca3af', fontSize: '0.875rem' }}
                             >
                               {t('reportCreationModal.metaconfirm.noDocuments')}
                             </td>
                           </tr>
                         )}
                       </tbody>
                     </table>
                   </div>

                   <div style={{ padding: '1rem 1.5rem', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '0.75rem', backgroundColor: '#ffffff', flexShrink: 0 }}>
                       <button
                         type="button"
                         onClick={() => setActiveView(metaConfirmBackTargetRef.current)}
                         style={{ padding: '0.625rem 1rem', border: '1px solid #d1d5db', borderRadius: '8px', background: '#fff', cursor: 'pointer', fontSize: '0.875rem' }}
                       >
                         {t('reportCreationModal.buttons.back')}
                       </button>
                     <button
                       type="button"
                       onClick={() => void openSec3Confirm({ backTarget: 'metaconfirm' })}
                       disabled={loadingSec3}
                       title={t('reportCreationModal.metaconfirm.continueNextTitle')}
                       style={{
                         padding: '0.625rem 1.25rem',
                         backgroundColor: !loadingSec3 ? '#11074A' : '#9ca3af',
                         color: 'white',
                         border: 'none',
                         borderRadius: '8px',
                         cursor: !loadingSec3 ? 'pointer' : 'not-allowed',
                         fontSize: '0.875rem',
                         fontWeight: 600,
                         display: 'flex',
                         alignItems: 'center',
                         gap: '0.5rem' }}
                      >
                        {loadingSec3 && <FaSpinner className="animate-spin" size={14} />}
                        {t('reportCreationModal.buttons.continue')}
                      </button>
                   </div>
                 </div>
               )}

               {activeView === 'sec3confirm' && (
                 <div style={{ display: 'flex', height: '100%', flexDirection: 'column', overflow: 'hidden' }}>
                   {}
                   <div
                     style={{
                       flex: 1,
                       overflow: 'auto',
                       borderTop: '3px solid #b45309',
                       backgroundColor: '#ffffff' }}
                   >
                     <table
                       style={{
                         width: '100%',
                         borderCollapse: 'collapse',
                         fontSize: '0.875rem',
                         tableLayout: 'fixed' }}
                     >
                       <colgroup>
                         <col style={{ width: 36 }} />
                         <col style={{ width: 52 }} />
                         <col style={{ width: '30%' }} />
                         <col style={{ width: '70%' }} />
                       </colgroup>
                       <thead
                         style={{
                           backgroundColor: '#f9fafb',
                           position: 'sticky',
                           top: 0,
                           zIndex: 1 }}
                       >
                         <tr>
                           <th
                             style={{
                               padding: '0.5rem',
                               textAlign: 'left',
                               borderBottom: '1px solid #e5e7eb' }}
                           >
                             <input
                               type="checkbox"
                               checked={sec3Steps.length > 0 && sec3Steps.every((s) => s.selected)}
                               onChange={() => {
                                 const allSelected = sec3Steps.every((s) => s.selected);
                                 setSec3Steps((prev) => prev.map((s) => ({ ...s, selected: !allSelected })));
                               }}
                               aria-label="Select all items"
                             />
                           </th>
                           <th
                             style={{
                               padding: '0.5rem',
                               textAlign: 'left',
                               borderBottom: '1px solid #e5e7eb',
                               fontWeight: 600,
                               color: '#374151',
                               fontSize: '0.75rem' }}
                           >
                             #
                           </th>
                           <th
                             style={{
                               padding: '0.5rem',
                               textAlign: 'left',
                               borderBottom: '1px solid #e5e7eb',
                               fontWeight: 600,
                               color: '#374151',
                               fontSize: '0.75rem',
                               overflow: 'hidden' }}
                           >
                             {wizardTableCol.item}
                           </th>
                           <th
                             style={{
                               padding: '0.5rem',
                               textAlign: 'left',
                               borderBottom: '1px solid #e5e7eb',
                               fontWeight: 600,
                               color: '#374151',
                               fontSize: '0.75rem',
                               overflow: 'hidden' }}
                           >
                             {wizardTableCol.yourInput}
                           </th>
                         </tr>
                       </thead>
                       <tbody>
                         {sec3Steps.map((step, idx) => (
                           <tr
                             key={step.id}
                             style={{
                               borderBottom: '1px solid #e5e7eb',
                               verticalAlign: 'top',
                               opacity: step.selected ? 1 : 0.45,
                               background: idx % 2 === 0 ? '#ffffff' : '#fffaf0' }}
                           >
                             <td style={{ padding: '0.5rem' }}>
                               <input
                                 type="checkbox"
                                 checked={step.selected}
                                 onChange={() =>
                                   setSec3Steps((prev) =>
                                     prev.map((s) => (s.id === step.id ? { ...s, selected: !s.selected } : s))
                                   )
                                 }
                                 aria-label={`Include ${step.name || 'step'} in agent`}
                               />
                             </td>
                             <td style={{ padding: '0.5rem' }}>
                               <span
                                 style={{
                                   display: 'inline-flex',
                                   alignItems: 'center',
                                   justifyContent: 'center',
                                   width: '24px',
                                   height: '24px',
                                   borderRadius: '50%',
                                   background: '#b45309',
                                   color: 'white',
                                   fontSize: '0.7rem',
                                   fontWeight: 700 }}
                               >
                                 {matchedStudies.filter((s) => s.selected).length + idx + 1}
                               </span>
                             </td>
                             <td style={{ padding: '0.5rem', verticalAlign: 'top', overflow: 'hidden' }}>
                               <div
                                 style={{
                                   fontWeight: 600,
                                   color: '#11074A',
                                   fontSize: '0.8rem',
                                   wordBreak: 'break-word' }}
                               >
                                 {step.name}
                               </div>
                             </td>
                             <td style={{ padding: '0.5rem', verticalAlign: 'top' }}>
                               <textarea
                                 value={step.userInput}
                                 onChange={(e) =>
                                   setSec3Steps((prev) =>
                                     prev.map((s) => (s.id === step.id ? { ...s, userInput: e.target.value } : s))
                                   )
                                 }
                                 placeholder={t('reportCreationModal.sec1confirm.userInputPlaceholderShort')}
                                 rows={4}
                                 style={{
                                   width: '100%',
                                   minHeight: '88px',
                                   fontSize: '0.75rem',
                                   color: '#374151',
                                   lineHeight: 1.4,
                                   border: '1px solid #d1d5db',
                                   borderRadius: '8px',
                                   padding: '0.5rem 0.65rem',
                                   resize: 'vertical',
                                   fontFamily: 'inherit',
                                   boxSizing: 'border-box' }}
                               />
                             </td>
                           </tr>
                         ))}
                         {sec3Steps.length === 0 && (
                           <tr>
                             <td colSpan={4} style={{ padding: '2rem', textAlign: 'center', color: '#9ca3af', fontSize: '0.875rem' }}>
                               {t('reportCreationModal.sec3confirm.noSteps')}
                             </td>
                           </tr>
                         )}
                       </tbody>
                     </table>
                   </div>

                   {}
                   <div
                     style={{
                       padding: '1rem 1.5rem',
                       borderTop: '1px solid #e5e7eb',
                       display: 'flex',
                       justifyContent: 'flex-end',
                       alignItems: 'center',
                       gap: '0.75rem',
                       backgroundColor: '#ffffff',
                       flexShrink: 0 }}
                   >
                     <button
                       type="button"
                       onClick={() => setActiveView(sec3BackTargetRef.current)}
                       style={{ padding: '0.625rem 1rem', border: '1px solid #d1d5db', borderRadius: '8px', background: '#fff', cursor: 'pointer', fontSize: '0.875rem' }}
                     >
                       {t('reportCreationModal.buttons.back')}
                     </button>
                    <button
                      type="button"
                      onClick={openSec1Confirm}
                      disabled={loadingSec1}
                      style={{
                        padding: '0.625rem 1.25rem',
                        backgroundColor: !loadingSec1 ? '#11074A' : '#9ca3af',
                        color: 'white',
                        border: 'none',
                        borderRadius: '8px',
                        cursor: !loadingSec1 ? 'pointer' : 'not-allowed',
                        fontSize: '0.875rem',
                        fontWeight: 600,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem' }}
                      title={t('reportCreationModal.sec3confirm.continueToSection1Title')}
                    >
                      {loadingSec1 && <FaSpinner className="animate-spin" size={14} />}
                       {t('reportCreationModal.buttons.continue')}
                     </button>
                   </div>
                 </div>
               )}

               {activeView === 'sec1confirm' && (
                 <div style={{ display: 'flex', height: '100%', flexDirection: 'column', overflow: 'hidden' }}>
                   {}
                   <div
                     style={{
                       flex: 1,
                       overflow: 'auto',
                       borderTop: '3px solid #b45309',
                       backgroundColor: '#ffffff' }}
                   >
                     <table
                       style={{
                         width: '100%',
                         borderCollapse: 'collapse',
                         fontSize: '0.875rem',
                         tableLayout: 'fixed' }}
                     >
                       <colgroup>
                         <col style={{ width: 36 }} />
                         <col style={{ width: 52 }} />
                         <col style={{ width: '30%' }} />
                         <col style={{ width: '70%' }} />
                       </colgroup>
                       <thead
                         style={{
                           backgroundColor: '#f9fafb',
                           position: 'sticky',
                           top: 0,
                           zIndex: 1 }}
                       >
                         <tr>
                           <th
                             style={{
                               padding: '0.5rem',
                               textAlign: 'left',
                               borderBottom: '1px solid #e5e7eb' }}
                           >
                             <input
                               type="checkbox"
                               checked={sec1Steps.length > 0 && sec1Steps.every((s) => s.selected)}
                               onChange={() => {
                                 const allSelected = sec1Steps.every((s) => s.selected);
                                 setSec1Steps((prev) => prev.map((s) => ({ ...s, selected: !allSelected })));
                               }}
                               aria-label="Select all items"
                             />
                           </th>
                           <th
                             style={{
                               padding: '0.5rem',
                               textAlign: 'left',
                               borderBottom: '1px solid #e5e7eb',
                               fontWeight: 600,
                               color: '#374151',
                               fontSize: '0.75rem' }}
                           >
                             #
                           </th>
                           <th
                             style={{
                               padding: '0.5rem',
                               textAlign: 'left',
                               borderBottom: '1px solid #e5e7eb',
                               fontWeight: 600,
                               color: '#374151',
                               fontSize: '0.75rem',
                               overflow: 'hidden' }}
                           >
                             {wizardTableCol.item}
                           </th>
                           <th
                             style={{
                               padding: '0.5rem',
                               textAlign: 'left',
                               borderBottom: '1px solid #e5e7eb',
                               fontWeight: 600,
                               color: '#374151',
                               fontSize: '0.75rem',
                               overflow: 'hidden' }}
                           >
                             {wizardTableCol.yourInput}
                           </th>
                         </tr>
                       </thead>
                       <tbody>
                         {sec1Steps.map((step, idx) => (
                           <tr
                             key={step.id}
                             style={{
                               borderBottom: '1px solid #e5e7eb',
                               verticalAlign: 'top',
                               opacity: step.selected ? 1 : 0.45,
                               background: idx % 2 === 0 ? '#ffffff' : '#fffaf0' }}
                           >
                             <td style={{ padding: '0.5rem' }}>
                               <input
                                 type="checkbox"
                                 checked={step.selected}
                                 onChange={() =>
                                   setSec1Steps((prev) =>
                                     prev.map((s) => (s.id === step.id ? { ...s, selected: !s.selected } : s))
                                   )
                                 }
                                 aria-label={`Include ${step.name || 'step'} in agent`}
                               />
                             </td>
                             <td style={{ padding: '0.5rem' }}>
                               <span
                                 style={{
                                   display: 'inline-flex',
                                   alignItems: 'center',
                                   justifyContent: 'center',
                                   width: '24px',
                                   height: '24px',
                                   borderRadius: '50%',
                                   background: '#b45309',
                                   color: 'white',
                                   fontSize: '0.7rem',
                                   fontWeight: 700 }}
                               >
                                 {matchedStudies.filter((s) => s.selected).length +
                                   sec3Steps.filter((s) => s.selected).length +
                                   idx +
                                   1}
                               </span>
                             </td>
                             <td style={{ padding: '0.5rem', verticalAlign: 'top', overflow: 'hidden' }}>
                               <div
                                 style={{
                                   fontWeight: 600,
                                   color: '#11074A',
                                   fontSize: '0.8rem',
                                   wordBreak: 'break-word' }}
                               >
                                 {step.name}
                               </div>
                             </td>
                             <td style={{ padding: '0.5rem', verticalAlign: 'top' }}>
                               <textarea
                                 value={step.userInput}
                                 onChange={(e) =>
                                   setSec1Steps((prev) =>
                                     prev.map((s) => (s.id === step.id ? { ...s, userInput: e.target.value } : s))
                                   )
                                 }
                                 placeholder={t('reportCreationModal.sec1confirm.userInputPlaceholderShort')}
                                 rows={4}
                                 style={{
                                   width: '100%',
                                   minHeight: '88px',
                                   fontSize: '0.75rem',
                                   color: '#374151',
                                   lineHeight: 1.4,
                                   border: '1px solid #d1d5db',
                                   borderRadius: '8px',
                                   padding: '0.5rem 0.65rem',
                                   resize: 'vertical',
                                   fontFamily: 'inherit',
                                   boxSizing: 'border-box' }}
                               />
                             </td>
                           </tr>
                         ))}
                         {sec1Steps.length === 0 && (
                           <tr>
                             <td colSpan={4} style={{ padding: '2rem', textAlign: 'center', color: '#9ca3af', fontSize: '0.875rem' }}>
                               {t('reportCreationModal.sec1confirm.noSteps')}
                             </td>
                           </tr>
                         )}
                       </tbody>
                     </table>
                   </div>

                   {}
                   <div
                     style={{
                       padding: '1rem 1.5rem',
                       borderTop: '1px solid #e5e7eb',
                       display: 'flex',
                       justifyContent: 'flex-end',
                       alignItems: 'center',
                       gap: '0.75rem',
                       backgroundColor: '#ffffff',
                       flexShrink: 0 }}
                   >
                     <button
                       type="button"
                       onClick={() => setActiveView('sec3confirm')}
                       style={{ padding: '0.625rem 1rem', border: '1px solid #d1d5db', borderRadius: '8px', background: '#fff', cursor: 'pointer', fontSize: '0.875rem' }}
                     >
                       {t('reportCreationModal.buttons.back')}
                     </button>
                    <button
                      type="button"
                      onClick={generateAgent}
                      disabled={generatingAgent}
                      style={{
                        padding: '0.625rem 1.25rem',
                        backgroundColor: !generatingAgent ? '#11074A' : '#9ca3af',
                        color: 'white',
                        border: 'none',
                        borderRadius: '8px',
                        cursor: !generatingAgent ? 'pointer' : 'not-allowed',
                        fontSize: '0.875rem',
                        fontWeight: 600,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem' }}
                       title={t('reportCreationModal.sec1confirm.generateAgentTitle', {
                         count:
                           matchedStudies.filter((s) => s.selected).length +
                           sec3Steps.filter((s) => s.selected).length +
                           sec1Steps.filter((s) => s.selected).length })}
                     >
                       {generatingAgent ? <FaSpinner className="animate-spin" /> : <FaCheck />}
                       {t('reportCreationModal.sec1confirm.generateAgent')}
                     </button>
                   </div>
                 </div>
               )}

               {}
               {activeView === 'metacorpus' && (
                 <div className="max-w-7xl mx-auto w-full lg:h-full lg:min-h-0 lg:flex lg:flex-col">
                   {}
                   <div className="flex items-center justify-between mb-6">
                     <div>
                       <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                         <button
                           type="button"
                           onClick={() => {
                             setActiveCorpusTarget('clinical');
                             setActiveView('corpus');
                           }}
                           style={{ fontSize: '0.75rem', color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
                         >
                           {t('reportCreationModal.corpus.backLink')}
                         </button>
                         <span style={{ fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.12em', padding: '0.2rem 0.7rem', borderRadius: '4px', background: '#b45309', color: '#fff', textTransform: 'uppercase' }}>
                           {t('reportCreationModal.corpus.biomaterialBadge')}
                         </span>
                       </div>
                       <h1 className="text-3xl font-bold flex items-center gap-2" style={{ color: '#11074A' }}>
                         <FaFlask style={{ color: '#b45309' }} />
                         {t('reportCreationModal.corpus.biomaterialCorpusTitle')}
                       </h1>
                     </div>
                   </div>

                   <div
                     className="mb-5 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                     role="region"
                     aria-label={t('reportCreationModal.metacorpus.skipRegionAria')}
                   >
                     <div className="text-sm text-slate-700">
                       <span className="font-semibold text-slate-900">{t('reportCreationModal.metacorpus.noHumanBioTitle')}</span>{' '}
                       {t('reportCreationModal.metacorpus.skipToSection2Short')}
                     </div>
                     <button
                       type="button"
                       onClick={() => void handleSkipBiomaterial()}
                       className="shrink-0 rounded-lg border border-slate-400 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-100"
                     >
                       {t('reportCreationModal.metacorpus.skipBiomaterial')}
                     </button>
                   </div>

                   {}
                   <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch lg:flex-1 lg:min-h-0 lg:auto-rows-fr">

                     {}
                     <div
                       ref={metaCorpusTutorialPdfColumnRef}
                       className={`space-y-6 lg:min-h-0 lg:flex lg:flex-col ${
                         metaCorpusLayoutTutorialStep === 2 ? 'rounded-xl ring-4 ring-amber-400 ring-offset-2' : ''
                       }`}
                     >
                       {!selectedFolder ? (
                         <div className="bg-white rounded-lg shadow-md border border-gray-200 p-6 overflow-hidden lg:flex-1 lg:min-h-0 lg:flex lg:flex-col">
                           <div className="flex items-center justify-between gap-2 mb-3">
                             <div className="flex items-center gap-2">
                               <h2 className="text-xl font-semibold" style={{ color: '#11074A' }}>
                                 1. Select Files
                               </h2>
                             </div>
                           </div>
                           <div className="flex flex-wrap items-center gap-2">
                             <button
                               onClick={handleCreateFolderManually}
                               disabled={creatingFolder || corpusInitiated || !sessionPrefixReady}
                               className="h-9 px-3 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2 text-sm font-semibold"
                               style={{ color: corpusInitiated ? '#16a34a' : '#11074A' }}
                               title={
                                 sessionPrefixReady
                                   ? 'Create the required report_creation_corpus folder in the project root'
                                   : 'Enter a session name above first'
                               }
                             >
                               {creatingFolder ? <FaSpinner className="animate-spin" /> : corpusInitiated ? <FaCheckCircle /> : <FaPlus />}
                               {corpusInitiated ? t('reportCreationModal.corpus.corpusReady') : t('reportCreationModal.corpus.initiateCorpus')}
                             </button>
                           </div>
                           <p className="text-sm text-gray-500">
                             Enter a session name above, then initiate corpus and pick files below. The project comes from the navbar; the PDFs folder loads automatically.
                           </p>
                         </div>
                       ) : (
                         <div className="bg-white rounded-lg shadow-md border border-gray-200 p-6 overflow-hidden lg:flex-1 lg:min-h-0 lg:flex lg:flex-col">
                           <div className="flex items-center justify-between gap-4 mb-3">
                             <div className="flex items-center gap-2 min-w-0">
                               <h2 className="text-xl font-semibold truncate" style={{ color: '#11074A' }}>
                                 1. Select Files
                               </h2>
                             </div>
                           </div>
                           <div className="flex flex-wrap items-center gap-2 mb-4">
                             <button
                               onClick={handleCreateFolderManually}
                               disabled={creatingFolder || corpusInitiated || !sessionPrefixReady}
                               className="h-9 px-3 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2 text-sm font-semibold"
                               style={{ color: corpusInitiated ? '#16a34a' : '#11074A' }}
                               title={
                                 sessionPrefixReady
                                   ? 'Create the required report_creation_corpus folder in the project root'
                                   : 'Enter a session name above first'
                               }
                             >
                               {creatingFolder ? <FaSpinner className="animate-spin" /> : corpusInitiated ? <FaCheckCircle /> : <FaPlus />}
                               {corpusInitiated ? t('reportCreationModal.corpus.corpusReady') : t('reportCreationModal.corpus.initiateCorpus')}
                             </button>
                             <button
                               onClick={openInDrive}
                               disabled={!currentFolderId || !corpusInitiated}
                               className="h-9 px-3 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2 text-sm font-semibold"
                               style={{ color: '#11074A' }}
                               title="Open current folder in Google Drive"
                             >
                               <FaExternalLinkAlt />
                               Open in Drive
                             </button>
                             <button
                               onClick={refreshCurrentFolder}
                               disabled={!currentFolderId || loadingFiles || !corpusInitiated}
                               className="h-9 px-3 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2 text-sm font-semibold"
                               style={{ color: '#11074A' }}
                               title={loadingFiles ? 'Refreshing…' : 'Refresh folder contents'}
                             >
                               {loadingFiles ? <FaSpinner className="animate-spin" /> : <FaSync />}
                               Refresh
                             </button>
                             <button
                               onClick={() => copyText(selectedFolder.id)}
                               disabled={!corpusInitiated}
                               className="h-9 px-3 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 flex items-center gap-2 text-sm font-semibold"
                               style={{ color: '#11074A' }}
                               title={copied ? 'Copied' : 'Copy folder ID'}
                             >
                               {copied ? <FaCheckCircle /> : <FaCopy />}
                               {copied ? 'Copied' : 'Copy ID'}
                             </button>
                           </div>

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

                             <div className="flex flex-wrap items-center gap-2 mb-3 max-w-full">
                               <select
                                 value={fileTypeFilter}
                                 onChange={(e) => {
                                   const value = e.target.value;
                                   if (value === '__select_all__') {
                                     selectAllVisibleMetaSupported();
                                     return;
                                   }
                                   setFileTypeFilter(value);
                                 }}
                                 className="px-3 py-2 rounded-lg border border-gray-300 text-sm bg-white max-w-full"
                                 title="Filter by file type"
                               >
                                 <option value="all">All types</option>
                                 <option value="__select_all__">Select all (visible)</option>
                                 {fileTypeOptions.map((opt) => (
                                   <option key={opt} value={opt}>{opt}</option>
                                 ))}
                               </select>
                               <select
                                 value={sortMode}
                                 onChange={(e) => setSortMode(e.target.value as typeof sortMode)}
                                 className="px-3 py-2 rounded-lg border border-gray-300 text-sm bg-white max-w-full"
                               >
                                 <option value="name">Name (A→Z)</option>
                                 <option value="size">Size (big→small)</option>
                                 <option value="created">Last created (new→old)</option>
                                 <option value="updated">Last updated (new→old)</option>
                               </select>
                               <button
                                 type="button"
                                 onClick={() => toggleSelectAllVisibleMetaSupported()}
                                 disabled={
                                   !corpusInitiated || loadingFiles || visibleSupportedIds.length === 0
                                 }
                                 className="h-9 shrink-0 rounded-lg border border-gray-300 bg-white px-3 text-sm font-semibold text-[#11074A] hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                                 title={
                                   visibleSupportedIds.length > 0 &&
                                   visibleSupportedIds.every((id) => metaSelectedFileIds.has(id))
                                     ? 'Clear selection for every supported file currently listed'
                                     : 'Select every supported file currently listed (respects type filter and sort)'
                                 }
                               >
                                 {visibleSupportedIds.length > 0 &&
                                 visibleSupportedIds.every((id) => metaSelectedFileIds.has(id))
                                   ? 'Deselect all'
                                   : 'Select all files'}
                               </button>
                             </div>

                             {loadingFiles ? (
                               <div className="flex items-center justify-center py-8">
                                 <FaSpinner className="animate-spin text-2xl text-gray-400" />
                               </div>
                             ) : (
                               <div className="space-y-2 overflow-y-auto flex-1 min-h-0 pr-1">
                                 {folderItems.length === 0 && (
                                   <div className="text-sm text-gray-500 py-6 text-center">No items found in this folder.</div>
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
                                         <FaFolder className="text-yellow-600 flex-shrink-0" />
                                         <div className="flex-1 min-w-0">
                                           <div className="font-medium text-gray-900 truncate">{item.name}</div>
                                           <div className="text-xs text-gray-500 font-mono truncate">ID: {item.id}</div>
                                         </div>
                                         <FaChevronRight className="text-gray-400" />
                                       </button>
                                     );
                                   }

                                   const metaChecked = metaSelectedFileIds.has(item.id);
                                   return (
                                     <label
                                       key={item.id}
                                       className="flex items-center gap-3 px-4 py-3 rounded-lg border border-gray-300 hover:bg-gray-50 cursor-pointer"
                                     >
                                       <input
                                         type="checkbox"
                                         checked={metaChecked}
                                         onChange={() => {
                                           const wasSelected = metaSelectedFileIds.has(item.id);
                                           setMetaSelectedFileIds((prev) => {
                                             const next = new Set(prev);
                                             if (next.has(item.id)) next.delete(item.id);
                                             else next.add(item.id);
                                             return next;
                                           });
                                           setMetaSelectedFilesMeta((prev) => {
                                             if (wasSelected) {
                                               const next = { ...prev };
                                               delete next[item.id];
                                               return next;
                                             }
                                             return { ...prev, [item.id]: item };
                                           });
                                           if (wasSelected) {
                                             setMetaFilePageRanges((prev) => {
                                               const next = { ...prev };
                                               delete next[item.id];
                                               return next;
                                             });
                                           }
                                         }}
                                         disabled={!support.supported || !corpusInitiated}
                                         className="w-4 h-4"
                                         title={!support.supported ? (support.reason || 'Not supported') : 'Select file'}
                                       />
                                       <div className="flex-1 min-w-0">
                                         <div className="font-medium text-gray-900 truncate">{item.name}</div>
                                         <div className="text-sm text-gray-500 flex flex-wrap items-center gap-2">
                                           <span>{formatFileSize(item.size)}</span>
                                           <span className="text-gray-300">•</span>
                                           <span className="font-mono text-xs">{typeLabel}</span>
                                           <span className="text-gray-300">•</span>
                                           <span className={`text-xs px-2 py-0.5 rounded-full border ${support.supported ? 'bg-green-50 text-green-700 border-green-200' : 'bg-red-50 text-red-700 border-red-200'}`}
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
                       )}
                     </div>

                     {}
                     <div className="space-y-6 lg:min-h-0 lg:flex lg:flex-col">
                       <div
                         ref={metaCorpusTutorialCreateCorpusRef}
                         className={`bg-white rounded-lg shadow-md border border-gray-200 p-6 overflow-hidden lg:flex-1 lg:min-h-0 lg:flex lg:flex-col ${
                           metaCorpusLayoutTutorialStep === 3 ? 'ring-4 ring-amber-400 ring-offset-2' : ''
                         }`}
                       >
                         <h2 className="text-xl font-semibold mb-4" style={{ color: '#11074A' }}>
                           {t('reportCreationModal.corpus.columnCreateCorpus')}
                         </h2>

                         <div className="lg:flex-1 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
                           {}
                           <div className="mb-4">
                             <div className="flex items-center justify-between mb-2">
                               <div className="text-sm font-semibold" style={{ color: '#11074A' }}>
                                 Selected files ({metaSelectedFileIds.size})
                               </div>
                               {metaSelectedFileIds.size > 0 && (
                                 <button
                                   onClick={() => {
                                     setMetaSelectedFileIds(new Set());
                                     setMetaSelectedFilesMeta({});
                                     setMetaFilePageRanges({});
                                   }}
                                   className="text-xs text-gray-600 hover:text-gray-900 hover:underline"
                                 >
                                   Clear all
                                 </button>
                               )}
                             </div>

                             {metaSelectedFileIds.size === 0 ? (
                               <div className="text-sm text-gray-500">No files selected yet.</div>
                             ) : (
                               <div className="space-y-2">
                                 {Object.values(metaSelectedFilesMeta).map((file) => {
                                   const isPdf =
                                     file.mimeType === 'application/pdf' ||
                                     file.mimeType === 'application/vnd.google-apps.document' ||
                                     file.name.toLowerCase().endsWith('.pdf');
                                   const currentRange = metaFilePageRanges[file.id];
                                   return (
                                     <div key={file.id} className="px-3 py-2 rounded-lg border border-gray-200 hover:bg-gray-50">
                                       <div className="flex items-start gap-3">
                                         <input
                                           type="checkbox"
                                           checked={metaSelectedFileIds.has(file.id)}
                                           onChange={() => {
                                             setMetaSelectedFileIds((prev) => {
                                               const n = new Set(prev);
                                               n.delete(file.id);
                                               return n;
                                             });
                                             setMetaSelectedFilesMeta((prev) => {
                                               const next = { ...prev };
                                               delete next[file.id];
                                               return next;
                                             });
                                             setMetaFilePageRanges((prev) => {
                                               const next = { ...prev };
                                               delete next[file.id];
                                               return next;
                                             });
                                           }}
                                           className="w-4 h-4 mt-1"
                                           title="Deselect file"
                                         />
                                         <div className="min-w-0 flex-1">
                                           <div className="text-sm font-medium text-gray-900 truncate">{file.name}</div>
                                           <div className="text-xs text-gray-500 flex flex-wrap items-center gap-2">
                                             <span className="font-mono">{formatMimeLabel(file.mimeType, file.name)}</span>
                                             <span className="text-gray-300">•</span>
                                             <span className="font-mono truncate">{file.id}</span>
                                           </div>
                                           {isPdf && (
                                             <div className="mt-2 flex items-center gap-2 flex-wrap">
                                               <div className="flex items-center gap-1">
                                                 <label className="text-xs font-medium text-gray-700">Start:</label>
                                                 <input
                                                   type="number"
                                                   min="1"
                                                   placeholder="1"
                                                   value={currentRange?.startPage || ''}
                                                   onChange={(e) => {
                                                     const value = parseInt(e.target.value, 10) || undefined;
                                                     if (value) {
                                                       setMetaFilePageRanges((prev) => ({
                                                         ...prev,
                                                         [file.id]: {
                                                           startPage: value,
                                                           endPage: prev[file.id]?.endPage || value } }));
                                                     } else {
                                                       setMetaFilePageRanges((prev) => {
                                                         const next = { ...prev };
                                                         delete next[file.id];
                                                         return next;
                                                       });
                                                     }
                                                   }}
                                                   onClick={(e) => e.stopPropagation()}
                                                   className="w-16 px-2 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                                                 />
                                               </div>
                                               <span className="text-xs text-gray-400">to</span>
                                               <div className="flex items-center gap-1">
                                                 <label className="text-xs font-medium text-gray-700">End:</label>
                                                 <input
                                                   type="number"
                                                   min={currentRange?.startPage || 1}
                                                   placeholder="Last"
                                                   value={currentRange?.endPage || ''}
                                                   onChange={(e) => {
                                                     const value = parseInt(e.target.value, 10) || undefined;
                                                     if (value && currentRange?.startPage) {
                                                       setMetaFilePageRanges((prev) => ({
                                                         ...prev,
                                                         [file.id]: {
                                                           ...prev[file.id],
                                                           endPage: value } }));
                                                     }
                                                   }}
                                                   onClick={(e) => e.stopPropagation()}
                                                   className="w-16 px-2 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                                                 />
                                               </div>
                                               <span className="text-xs text-gray-500 italic">
                                                 {currentRange
                                                   ? `(pages ${currentRange.startPage}-${currentRange.endPage})`
                                                   : '(all pages)'}
                                               </span>
                                             </div>
                                           )}
                                         </div>
                                       </div>
                                     </div>
                                   );
                                 })}
                               </div>
                             )}
                           </div>

                           {}
                           <div className="mb-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
                             <div className="text-sm font-semibold mb-3" style={{ color: '#11074A' }}>
                               Corpus Mode
                             </div>
                             <div className="flex flex-col gap-3">
                               <label className="flex items-center gap-2 cursor-pointer">
                                 <input
                                   type="radio"
                                   checked={corpusSelectionMode === 'new'}
                                   onChange={() => {
                                     setCorpusSelectionMode('new');
                                     setSelectedExistingCorpusId(null);
                                   }}
                                   className="w-4 h-4"
                                   disabled={!corpusInitiated}
                                 />
                                 <span className="text-sm font-medium">Create New Corpus</span>
                               </label>
                               <label className="flex items-center gap-2 cursor-pointer">
                                 <input
                                   type="radio"
                                   checked={corpusSelectionMode === 'existing'}
                                   onChange={() => {
                                     setCorpusSelectionMode('existing');
                                     if (existingCorpora.length === 0) {
                                       loadExistingCorpora();
                                     }
                                   }}
                                   className="w-4 h-4"
                                   disabled={!corpusInitiated}
                                 />
                                 <span className="text-sm font-medium">Add to Existing Corpus</span>
                               </label>
                             </div>
                             {corpusSelectionMode === 'existing' && (
                               <div className="mt-3">
                                 {loadingExistingCorpora ? (
                                   <div className="flex items-center gap-2 text-sm text-gray-600">
                                     <FaSpinner className="animate-spin" />
                                     Loading corpora...
                                   </div>
                                 ) : existingCorpora.length === 0 ? (
                                   <div className="text-sm text-gray-500">
                                     No existing corpora found. Create your first one above.
                                   </div>
                                 ) : (
                                   <>
                                     <label className="block text-sm font-medium mb-2 text-gray-700">Select Corpus</label>
                                     <select
                                       value={selectedExistingCorpusId || ''}
                                       onChange={(e) => setSelectedExistingCorpusId(e.target.value || null)}
                                       className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                                       disabled={!corpusInitiated}
                                     >
                                       <option value="">-- Select a corpus --</option>
                                       {existingCorpora.map((corpus) => (
                                         <option key={corpus.id} value={corpus.id}>
                                           {corpus.displayName} ({corpus.files.length} files)
                                         </option>
                                       ))}
                                     </select>
                                   </>
                                 )}
                               </div>
                             )}
                           </div>

                           {}
                           {corpusSelectionMode === 'existing' && selectedExistingCorpusId && (
                             <div className="mb-4 p-4 rounded-lg border border-green-200 bg-green-50">
                               <div className="text-sm font-semibold mb-1" style={{ color: '#14532d' }}>
                                 {t('reportCreationModal.corpus.reuseTitle')}
                               </div>
                               <p className="text-xs text-green-700 mb-3">
                                 {t('reportCreationModal.corpus.reuseSubtitle', {
                                   name: existingCorpora.find(c => c.id === selectedExistingCorpusId)?.displayName || '',
                                   count: existingCorpora.find(c => c.id === selectedExistingCorpusId)?.files.length ?? 0 })}
                               </p>
                               <button
                                 onClick={generateFromExistingMetaCorpus}
                                 disabled={
                                   !canAccessBiomaterialStep ||
                                   (existingCorpora.find(c => c.id === selectedExistingCorpusId)?.files.length ?? 0) === 0
                                 }
                                 className="w-full px-4 py-3 text-white rounded-lg disabled:opacity-50 flex items-center justify-center gap-2 font-medium"
                                 style={{ backgroundColor: '#166534' }}
                               >
                                 <FaBrain size={14} />
                                 {t('reportCreationModal.corpus.reuseButton')}
                               </button>
                             </div>
                           )}

                           {corpusSelectionMode === 'new' && (
                             <input
                               type="text"
                               value={metaCorpusName}
                               onChange={(e) => setMetaCorpusName(e.target.value)}
                               placeholder="Corpus name (e.g., Legal Docs Q4)"
                               className="w-full px-4 py-2 border border-gray-300 rounded-lg mb-4"
                               disabled={metaSelectedFileIds.size === 0 || !corpusInitiated}
                             />
                           )}

                           <label className="flex items-start gap-3 mb-4 text-sm text-gray-700">
                             <input
                               type="checkbox"
                               checked={allowPartialSuccess}
                               onChange={(e) => setAllowPartialSuccess(e.target.checked)}
                               className="mt-1"
                               disabled={metaCreating || metaSelectedFileIds.size === 0 || !corpusInitiated}
                             />
                             <div>
                               <div className="font-medium">Allow partial ingestion</div>
                               <div className="text-xs text-gray-500">
                                 If some PDF chunks fail (specific page ranges), we will still keep the corpus with the chunks that succeeded and mark the job as{' '}
                                 <span className="font-medium">completed with errors</span>.
                               </div>
                             </div>
                           </label>

                           <div className="lg:sticky lg:bottom-0 lg:z-10 lg:bg-white lg:pt-2">
                             <button
                               onClick={createMetaCorpus}
                               disabled={
                                 metaCreating ||
                                 metaSelectedFileIds.size === 0 ||
                                 !corpusInitiated ||
                                 (corpusSelectionMode === 'existing' && !selectedExistingCorpusId) ||
                                 (corpusSelectionMode === 'new' && !metaCorpusName.trim())
                               }
                               className="w-full px-4 py-3 text-white rounded-lg disabled:opacity-50 flex items-center justify-center gap-2"
                               style={{ backgroundColor: '#11074A' }}
                             >
                               {metaCreating ? (
                                 <>
                                   <FaSpinner className="animate-spin" />
                                   {t('reportCreationModal.corpus.startingBackgroundJob')}
                                 </>
                               ) : (
                                 <>
                                   <FaPlus />
                                   {corpusSelectionMode === 'existing'
                                     ? t('reportCreationModal.corpus.addToCorpusWithCount', { count: metaSelectedFileIds.size })
                                     : t('reportCreationModal.corpus.createCorpusWithCount', { count: metaSelectedFileIds.size })}
                                 </>
                               )}
                             </button>
                           </div>

                           {metaSelectedFileIds.size === 0 && (
                             <p className="text-sm text-gray-500 mt-3">
                               Select at least one supported file to enable corpus creation.
                             </p>
                           )}

                           {}
                           <div
                             ref={metaCorpusTutorialExistingJsonRef}
                             className={`mt-4 p-4 rounded-lg border ${
                               metaCorpusLayoutTutorialStep === 4 ? 'ring-4 ring-amber-400 ring-offset-2' : ''
                             }`}
                             style={{
                               backgroundColor: isValidExistingBiomaterialSummaryJson ? '#f8f7ff' : '#f3f4f6',
                               borderColor: isValidExistingBiomaterialSummaryJson ? 'rgba(17, 7, 74, 0.25)' : '#e5e7eb' }}
                           >
                             <div className="mb-2 flex items-center justify-between gap-2">
                               <div className="text-sm font-semibold" style={{ color: '#11074A' }}>
                                 Use Existing Corpus (biomaterial)
                               </div>
                               <button
                                 type="button"
                                 onClick={() => void reloadExistingJsonFiles()}
                                 disabled={!selectedFolder || loadingExistingJson}
                                 className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-[#11074A] hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                                 title={
                                   !selectedFolder
                                     ? 'Select a project folder first'
                                     : loadingExistingJson
                                       ? 'Refreshing…'
                                       : 'Refresh biomaterial Corpus file list'
                                 }
                                 aria-label="Refresh biomaterial Corpus file list from report_creation_corpus"
                               >
                                 {loadingExistingJson ? (
                                   <FaSpinner className="h-3.5 w-3.5 animate-spin" aria-hidden />
                                 ) : (
                                   <FaSync className="h-3.5 w-3.5" aria-hidden />
                                 )}
                               </button>
                             </div>
                             {loadingExistingJson ? (
                               <div className="flex items-center gap-2 text-xs mb-3" style={{ color: '#6b7280' }}>
                                 <FaSpinner className="animate-spin" />
                                 Loading available files…
                               </div>
                             ) : biomaterialExistingJsonFiles.length > 0 ? (
                               <div className="mb-3">
                                 <div className="text-xs mb-1" style={{ color: '#6b7280' }}>
                                   Biomaterial summaries only (<span className="font-mono">_biomaterial_</span> in filename) in{' '}
                                   <span className="font-mono">report_creation_corpus</span>:
                                 </div>
                                 <div
                                   className="rounded border mb-3"
                                   style={{
                                     maxHeight: '140px',
                                     overflowY: 'auto',
                                     borderColor: '#e5e7eb',
                                     background: '#fff' }}
                                 >
                                   {biomaterialExistingJsonFiles.map((f) => (
                                     <button
                                       key={f.id}
                                       onClick={() =>
                                         setAutoSelectedBiomaterialJsonFile((prev) => (prev?.id === f.id ? null : f))
                                       }
                                       className="w-full text-left px-3 py-2 text-xs flex items-center gap-2"
                                       style={{
                                         background: autoSelectedBiomaterialJsonFile?.id === f.id ? 'rgba(17,7,74,0.08)' : 'transparent',
                                         color: autoSelectedBiomaterialJsonFile?.id === f.id ? '#11074A' : '#374151',
                                         borderBottom: '1px solid #f3f4f6',
                                         fontWeight: autoSelectedBiomaterialJsonFile?.id === f.id ? 600 : 400 }}
                                     >
                                       <FaFileAlt style={{ flexShrink: 0, opacity: 0.6 }} />
                                       <span className="truncate font-mono">{f.name}</span>
                                     </button>
                                   ))}
                                 </div>
                               </div>
                             ) : selectedFolder ? (
                               <p className="text-xs mb-3" style={{ color: '#6b7280' }}>
                                 No biomaterial summary Corpus found in <span className="font-mono">report_creation_corpus</span>{' '}
                                 (clinical study Corpus is hidden here).
                               </p>
                             ) : (
                               <p className="text-xs mb-3" style={{ color: '#6b7280' }}>
                                 Select a project folder on the left to see available Corpus files.
                               </p>
                             )}
                             <button
                               onClick={() => void loadExistingBiomaterialSummaries()}
                               disabled={loadingBiomaterialJsonReuse || !isValidExistingBiomaterialSummaryJson}
                               className="w-full px-4 py-2 rounded-lg flex items-center justify-center gap-2"
                               style={{
                                 backgroundColor: loadingBiomaterialJsonReuse || !isValidExistingBiomaterialSummaryJson ? '#9ca3af' : '#11074A',
                                 color: 'white',
                                 cursor: loadingBiomaterialJsonReuse || !isValidExistingBiomaterialSummaryJson ? 'not-allowed' : 'pointer',
                                 opacity: loadingBiomaterialJsonReuse || !isValidExistingBiomaterialSummaryJson ? 0.7 : 1 }}
                             >
                               {loadingBiomaterialJsonReuse ? (
                                 <>
                                   <FaSpinner className="animate-spin" />
                                   Loading...
                                 </>
                               ) : (
                                 <>
                                   <FaFileAlt />
                                   Use biomaterial Corpus
                                 </>
                               )}
                             </button>
                           </div>
                         </div>
                       </div>
                     </div>

                   </div>
                 </div>
               )}

               {}
               {activeView === 'metaprocessing' && (
                 <div className="max-w-3xl mx-auto flex flex-col items-center justify-center min-h-[60vh] text-center">
                   <div style={{ marginBottom: '1.25rem' }}>
                     <span style={{ fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.12em', padding: '0.2rem 0.7rem', borderRadius: '4px', background: '#b45309', color: '#fff', textTransform: 'uppercase' }}>BIOMATERIAL</span>
                   </div>
                   <div className="mb-3" style={{ color: '#11074A' }}>
                     {metaSummaryJobStatus ? (
                       <>
                         <div className="text-2xl font-semibold">Writing corpus summary</div>
                         {(metaCorpusName.trim() || metaCorpusJobStatus?.displayName?.trim()) && (
                           <div className="mt-2 text-xl font-semibold text-gray-800">
                             {metaCorpusName.trim() || metaCorpusJobStatus?.displayName}
                           </div>
                         )}
                       </>
                     ) : (
                       <div className="text-2xl font-semibold">Creating Biomaterial Corpus</div>
                     )}
                   </div>
                   {!metaSummaryJobStatus && (
                     <div className="text-sm text-gray-600 mb-6">
                       {metaCorpusJobStatus?.status === 'completed' || metaCorpusJobStatus?.status === 'completed_with_errors'
                         ? 'Biomaterial corpus ready — continuing…'
                         : `Indexing ${metaFiles.length} document${metaFiles.length !== 1 ? 's' : ''} into the biomaterial corpus…`}
                     </div>
                   )}
                   {(!metaCorpusJobStatus || (metaCorpusJobStatus.status !== 'completed' && metaCorpusJobStatus.status !== 'completed_with_errors')) && (
                     <FaSpinner className="animate-spin text-3xl" style={{ color: '#11074A' }} />
                   )}
                   {metaCorpusJobStatus && (metaCorpusJobStatus.status === 'completed' || metaCorpusJobStatus.status === 'completed_with_errors') && metaSummaryJobStatus && (
                     <FaSpinner className="animate-spin text-3xl" style={{ color: '#11074A' }} />
                   )}
                   {(metaCorpusJobStatus?.status === 'completed' || metaCorpusJobStatus?.status === 'completed_with_errors') && !metaSummaryJobStatus && (
                     <FaCheckCircle style={{ color: '#059669', fontSize: '2rem' }} />
                   )}
                   <div style={{ marginTop: '1.5rem' }}>
                     <button
                       onClick={() => {
                         setActiveView('metacorpus');
                       }}
                       style={{ padding: '0.5rem 1rem', border: '1px solid #d1d5db', borderRadius: '8px', background: '#fff', cursor: 'pointer', fontSize: '0.8rem', color: '#6b7280' }}
                     >
                       Back
                     </button>
                   </div>
                 </div>
               )}

               {activeView === 'generating' && (
                 <div className="max-w-3xl mx-auto flex flex-col items-center justify-center min-h-[60vh] text-center">
                   <div className="text-2xl font-semibold mb-3" style={{ color: '#11074A' }}>
                     {t('reportCreationModal.generating.title')}
                   </div>
                   <div className="text-sm text-gray-600 mb-6">
                     {t('reportCreationModal.generating.subtitle')}
                   </div>
                   <FaSpinner className="animate-spin text-3xl" style={{ color: '#11074A' }} />
                 </div>
               )}

              {activeView === 'corpus' && (
                <div className="max-w-7xl mx-auto w-full lg:h-full lg:min-h-0 lg:flex lg:flex-col">
                   <div className="flex items-center justify-between mb-6">
                     <div>
                       <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                         <button
                           type="button"
                           onClick={() => setSessionIntroCompleted(false)}
                           style={{ fontSize: '0.75rem', color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
                         >
                           {t('reportCreationModal.corpus.backToSessionName')}
                         </button>
                         <span style={{ fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.12em', padding: '0.2rem 0.7rem', borderRadius: '4px', background: '#11074A', color: '#fff', textTransform: 'uppercase' }}>
                           {t('reportCreationModal.corpus.clinicalBadge')}
                         </span>
                       </div>
                       <h1 className="text-3xl font-bold flex items-center gap-2" style={{ color: '#11074A' }}>
                         <FaFileAlt style={{ color: '#11074A' }} />
                         Study Corpus
                       </h1>
                     </div>
                   </div>

                  {}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch lg:flex-1 lg:min-h-0 lg:auto-rows-fr">

                    {}
                 <div
                   ref={corpusTutorialPdfColumnRef}
                   className={`lg:min-h-0 lg:flex lg:flex-col ${
                     corpusLayoutTutorialStep === 2 ? 'rounded-xl ring-4 ring-amber-400 ring-offset-2' : ''
                   }`}
                 >
                   <CorpusFileBrowserPanel
                     className="lg:flex-1"
                     selectedFolder={selectedFolder}
                     corpusInitiated={corpusInitiated}
                     sessionPrefixReady={sessionPrefixReady}
                     creatingFolder={creatingFolder}
                     onInitiateCorpus={handleCreateFolderManually}
                     onOpenInDrive={openInDrive}
                     onRefresh={refreshCurrentFolder}
                     onCopyFolderId={() => selectedFolder && copyText(selectedFolder.id)}
                     copied={copied}
                     currentFolderId={currentFolderId}
                     loadingFiles={loadingFiles}
                     breadcrumbs={breadcrumbs}
                     onNavigateBreadcrumb={navigateToBreadcrumb}
                     fileTypeFilter={fileTypeFilter}
                     onFileTypeFilterChange={setFileTypeFilter}
                     fileTypeOptions={fileTypeOptions}
                     sortMode={sortMode}
                     onSortModeChange={setSortMode}
                     onToggleSelectAllVisible={toggleSelectAllVisibleSupported}
                     visibleSupportedCount={visibleSupportedIds.length}
                     allVisibleSupportedSelected={
                       visibleSupportedIds.length > 0 &&
                       visibleSupportedIds.every((id) => selectedFileIds.has(id))
                     }
                     selectedFileIds={selectedFileIds}
                     folderItems={folderItems}
                     sortedFolderItems={sortedFolderItems}
                     isFolderMime={isFolderMime}
                     ragSupport={ragSupport}
                     formatMimeLabel={formatMimeLabel}
                     formatFileSize={formatFileSize}
                     onNavigateToFolder={navigateToFolder}
                     onToggleFile={toggleFile}
                     emptyHint="Initiate the corpus to browse PDFs from your project folder."
                   />
                 </div>

                  <div className="space-y-6 lg:min-h-0 lg:flex lg:flex-col">
                    <div
                      ref={corpusTutorialCreateCorpusRef}
                      className={`bg-white rounded-lg shadow-md border border-gray-200 p-6 overflow-hidden lg:flex-1 lg:min-h-0 lg:flex lg:flex-col ${
                        corpusLayoutTutorialStep === 3 ? 'ring-4 ring-amber-400 ring-offset-2' : ''
                      }`}
                    >
                       <h2 className="text-xl font-semibold mb-4" style={{ color: '#11074A' }}>
                         2. Create Corpus
                       </h2>
                      <div className="lg:flex-1 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
                      <div className="mb-4">
                         <div className="flex items-center justify-between mb-2">
                           <div className="text-sm font-semibold" style={{ color: '#11074A' }}>
                             Selected files ({selectedCount})
                           </div>
                           {selectedCount > 0 && (
                             <button
                               onClick={() => {
                                 setSelectedFileIds(new Set());
                                 setSelectedFilesMeta({});
                                 setFilePageRanges({});
                               }}
                               className="text-xs text-gray-600 hover:text-gray-900 hover:underline"
                               title="Clear all selected files"
                             >
                               Clear all
                             </button>
                           )}
                         </div>
 
                        {selectedCount === 0 ? (
                           <div className="text-sm text-gray-500">No files selected yet.</div>
                         ) : (
                          <div className="space-y-2">
                             {selectedFilesList.map((file) => {
                               const isPdf = file.mimeType === 'application/pdf' || 
                                           file.mimeType === 'application/vnd.google-apps.document' ||
                                           file.name.toLowerCase().endsWith('.pdf');
                               const currentRange = filePageRanges[file.id];
                               
                               return (
                                 <div
                                   key={file.id}
                                   className="px-3 py-2 rounded-lg border border-gray-200 hover:bg-gray-50"
                                 >
                                   <div className="flex items-start gap-3">
                                     <input
                                       type="checkbox"
                                       checked={selectedFileIds.has(file.id)}
                                       onChange={() => deselectById(file.id)}
                                       className="w-4 h-4 mt-1"
                                       title="Deselect file"
                                     />
                                     <div className="min-w-0 flex-1">
                                       <div className="text-sm font-medium text-gray-900 truncate">{file.name}</div>
                                       <div className="text-xs text-gray-500 flex flex-wrap items-center gap-2">
                                         <span className="font-mono">{formatMimeLabel(file.mimeType, file.name)}</span>
                                         <span className="text-gray-300">•</span>
                                         <span className="font-mono truncate">{file.id}</span>
                                       </div>
                                       
                                       {isPdf && (
                                         <div className="mt-2 flex items-center gap-2">
                                           <div className="flex items-center gap-1">
                                             <label className="text-xs font-medium text-gray-700">Start:</label>
                                             <input
                                               type="number"
                                               min="1"
                                               placeholder="1"
                                               value={currentRange?.startPage || ''}
                                               onChange={(e) => {
                                                 const value = parseInt(e.target.value) || undefined;
                                                 if (value) {
                                                   setFilePageRanges(prev => ({
                                                     ...prev,
                                                     [file.id]: {
                                                       startPage: value,
                                                       endPage: prev[file.id]?.endPage || value
                                                     }
                                                   }));
                                                 } else {
                                                   const newRanges = { ...filePageRanges };
                                                   delete newRanges[file.id];
                                                   setFilePageRanges(newRanges);
                                                 }
                                               }}
                                               onClick={(e) => e.stopPropagation()}
                                               className="w-16 px-2 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                                             />
                                           </div>
                                           <span className="text-xs text-gray-400">to</span>
                                           <div className="flex items-center gap-1">
                                             <label className="text-xs font-medium text-gray-700">End:</label>
                                             <input
                                               type="number"
                                               min={currentRange?.startPage || 1}
                                               placeholder="Last"
                                               value={currentRange?.endPage || ''}
                                               onChange={(e) => {
                                                 const value = parseInt(e.target.value) || undefined;
                                                 if (value && currentRange?.startPage) {
                                                   setFilePageRanges(prev => ({
                                                     ...prev,
                                                     [file.id]: {
                                                       ...prev[file.id],
                                                       endPage: value
                                                     }
                                                   }));
                                                 }
                                               }}
                                               onClick={(e) => e.stopPropagation()}
                                               className="w-16 px-2 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
                                             />
                                           </div>
                                           <span className="text-xs text-gray-500 italic">
                                             {currentRange ? `(pages ${currentRange.startPage}-${currentRange.endPage})` : '(all pages)'}
                                           </span>
                                         </div>
                                       )}
                                     </div>
                                   </div>
                                 </div>
                               );
                             })}
                           </div>
                         )}
                      </div>

                     {}
                     <div className="mb-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
                       <div className="text-sm font-semibold mb-3" style={{ color: '#11074A' }}>
                         Corpus Mode
                       </div>
                       <div className="flex flex-col gap-3">
                         <label className="flex items-center gap-2 cursor-pointer">
                           <input
                             type="radio"
                             checked={corpusSelectionMode === 'new'}
                             onChange={() => {
                               setCorpusSelectionMode('new');
                               setSelectedExistingCorpusId(null);
                             }}
                             className="w-4 h-4"
                             disabled={!corpusInitiated}
                           />
                           <span className="text-sm font-medium">Create New Corpus</span>
                         </label>
                         <label className="flex items-center gap-2 cursor-pointer">
                           <input
                             type="radio"
                             checked={corpusSelectionMode === 'existing'}
                             onChange={() => {
                               setCorpusSelectionMode('existing');
                               if (existingCorpora.length === 0) {
                                 loadExistingCorpora();
                               }
                             }}
                             className="w-4 h-4"
                             disabled={!corpusInitiated}
                           />
                           <span className="text-sm font-medium">Add to Existing Corpus</span>
                         </label>
                       </div>

                       {}
                       {corpusSelectionMode === 'existing' && (
                         <div className="mt-3">
                           {loadingExistingCorpora ? (
                             <div className="flex items-center gap-2 text-sm text-gray-600">
                               <FaSpinner className="animate-spin" />
                               Loading corpora...
                             </div>
                           ) : existingCorpora.length === 0 ? (
                             <div className="text-sm text-gray-500">
                               No existing corpora found. Create your first one above.
                             </div>
                           ) : (
                             <>
                               <label className="block text-sm font-medium mb-2 text-gray-700">
                                 Select Corpus
                               </label>
                               <select
                                 value={selectedExistingCorpusId || ''}
                                 onChange={(e) => setSelectedExistingCorpusId(e.target.value || null)}
                                 className="w-full px-4 py-2 border border-gray-300 rounded-lg"
                                 disabled={!corpusInitiated}
                               >
                                 <option value="">-- Select a corpus --</option>
                                 {existingCorpora.map((corpus) => (
                                   <option key={corpus.id} value={corpus.id}>
                                     {corpus.displayName} ({corpus.files.length} files)
                                   </option>
                                 ))}
                               </select>
                             </>
                           )}
                         </div>
                       )}
                     </div>

                    {}
                    {corpusSelectionMode === 'existing' && selectedExistingCorpusId && (
                      <div className="mb-4 p-4 rounded-lg border border-green-200 bg-green-50">
                        <div className="text-sm font-semibold mb-1" style={{ color: '#14532d' }}>
                          Generate Report from this Corpus
                        </div>
                        <p className="text-xs text-green-700 mb-3">
                          Skip file upload and generate a report directly from{' '}
                          <span className="font-medium">
                            {existingCorpora.find(c => c.id === selectedExistingCorpusId)?.displayName || 'selected corpus'}
                          </span>{' '}
                          ({existingCorpora.find(c => c.id === selectedExistingCorpusId)?.files.length ?? 0} files already ingested).
                        </p>
                        <button
                          onClick={generateFromExistingCorpus}
                          disabled={
                            (existingCorpora.find(c => c.id === selectedExistingCorpusId)?.files.length ?? 0) === 0
                          }
                          className="w-full px-4 py-3 text-white rounded-lg disabled:opacity-50 flex items-center justify-center gap-2 font-medium"
                          style={{ backgroundColor: '#166534' }}
                        >
                          <FaBrain size={14} />
                          Generate Report
                        </button>
                      </div>
                    )}

                    {}
                     {corpusSelectionMode === 'new' && (
                       <input
                         type="text"
                         value={corpusName}
                         onChange={(e) => setCorpusName(e.target.value)}
                         placeholder="Corpus name (e.g., Legal Docs Q4)"
                         className="w-full px-4 py-2 border border-gray-300 rounded-lg mb-4"
                         disabled={selectedCount === 0 || !corpusInitiated}
                       />
                     )}
                       <label className="flex items-start gap-3 mb-4 text-sm text-gray-700">
                         <input
                           type="checkbox"
                           checked={allowPartialSuccess}
                           onChange={(e) => setAllowPartialSuccess(e.target.checked)}
                           className="mt-1"
                           disabled={creating || selectedCount === 0 || !corpusInitiated}
                         />
                         <div>
                           <div className="font-medium">Allow partial ingestion</div>
                           <div className="text-xs text-gray-500">
                             If some PDF chunks fail (specific page ranges), we will still keep the corpus with the chunks that succeeded and mark the job as{' '}
                             <span className="font-medium">completed with errors</span>.
                           </div>
                         </div>
                       </label>
                      <div className="lg:sticky lg:bottom-0 lg:z-10 lg:bg-white lg:pt-2">
                        <button
                          onClick={createCorpus}
                          disabled={
                            creating || 
                            selectedCount === 0 || 
                            !corpusInitiated || 
                            (corpusSelectionMode === 'existing' && !selectedExistingCorpusId)
                          }
                          className="w-full px-4 py-3 text-white rounded-lg disabled:opacity-50 flex items-center justify-center gap-2"
                          style={{ backgroundColor: '#11074A' }}
                        >
                          {creating ? (
                            <>
                              <FaSpinner className="animate-spin" />
                              Starting Background Job...
                            </>
                          ) : (
                            <>
                              <FaPlus />
                              {corpusSelectionMode === 'existing' 
                                ? `Add to Corpus (${selectedCount} files)`
                                : `Create Corpus (${selectedCount} files)`
                              }
                            </>
                          )}
                        </button>
                      </div>
                      {selectedCount === 0 && (
                        <p className="text-sm text-gray-500 mt-3">
                          Select at least one supported file to enable corpus creation.
                        </p>
                      )}

                      {}
                      <div
                        ref={corpusTutorialExistingJsonRef}
                        className={`mt-4 p-4 rounded-lg border ${
                          corpusLayoutTutorialStep === 4 ? 'ring-4 ring-amber-400 ring-offset-2' : ''
                        }`}
                        style={{
                          backgroundColor: isValidExistingSummaryJson ? '#f8f7ff' : '#f3f4f6',
                          borderColor: isValidExistingSummaryJson ? 'rgba(17, 7, 74, 0.25)' : '#e5e7eb' }}
                      >
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <div className="text-sm font-semibold" style={{ color: '#11074A' }}>
                            Use Existing Corpus
                          </div>
                          <button
                            type="button"
                            onClick={() => void reloadExistingJsonFiles()}
                            disabled={!selectedFolder || loadingExistingJson}
                            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-[#11074A] hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                            title={
                              !selectedFolder
                                ? 'Select a project folder first'
                                : loadingExistingJson
                                  ? 'Refreshing…'
                                  : 'Refresh Corpus file list'
                            }
                            aria-label="Refresh Corpus file list from report_creation_corpus"
                          >
                            {loadingExistingJson ? (
                              <FaSpinner className="h-3.5 w-3.5 animate-spin" aria-hidden />
                            ) : (
                              <FaSync className="h-3.5 w-3.5" aria-hidden />
                            )}
                          </button>
                        </div>

                        {}
                        {loadingExistingJson ? (
                          <div className="flex items-center gap-2 text-xs mb-3" style={{ color: '#6b7280' }}>
                            <FaSpinner className="animate-spin" />
                            Loading available files…
                          </div>
                        ) : clinicalExistingJsonFiles.length > 0 ? (
                          <div className="mb-3">
                            <div className="text-xs mb-1" style={{ color: '#6b7280' }}>
                              Clinical study summaries only (biomaterial Corpus is hidden here) in{' '}
                              <span className="font-mono">report_creation_corpus</span>:
                            </div>
                            <div
                              className="rounded border"
                              style={{
                                maxHeight: '140px',
                                overflowY: 'auto',
                                borderColor: '#e5e7eb',
                                background: '#fff' }}
                            >
                              {clinicalExistingJsonFiles.map((f) => (
                                <button
                                  key={f.id}
                                  onClick={() =>
                                    setAutoSelectedJsonFile((prev) =>
                                      prev?.id === f.id ? null : f
                                    )
                                  }
                                  className="w-full text-left px-3 py-2 text-xs flex items-center gap-2"
                                  style={{
                                    background:
                                      autoSelectedJsonFile?.id === f.id
                                        ? 'rgba(17,7,74,0.08)'
                                        : 'transparent',
                                    color:
                                      autoSelectedJsonFile?.id === f.id
                                        ? '#11074A'
                                        : '#374151',
                                    borderBottom: '1px solid #f3f4f6',
                                    fontWeight:
                                      autoSelectedJsonFile?.id === f.id ? 600 : 400 }}
                                >
                                  <FaFileAlt style={{ flexShrink: 0, opacity: 0.6 }} />
                                  <span className="truncate font-mono">{f.name}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : selectedFolder ? (
                          <p className="text-xs mb-3" style={{ color: '#6b7280' }}>
                            No clinical study summary Corpus in <span className="font-mono">report_creation_corpus</span>{' '}
                            (biomaterial-only files are listed under Biomaterial).
                          </p>
                        ) : (
                          <p className="text-xs mb-3" style={{ color: '#6b7280' }}>
                            Select a project folder on the left to see available Corpus files.
                          </p>
                        )}

                        {selectedJsonFile && (
                          <div className="text-xs mb-3" style={{ color: '#374151' }}>
                            <div>Selected: <span className="font-mono font-medium">{selectedJsonFile.name}</span></div>
                            <div style={{ color: '#4b5563', marginTop: '4px' }}>
                              Corpus ID: <span className="font-mono font-medium text-blue-600">{extractCorpusIdFromSummaryJsonFilename(selectedJsonFile.name)}</span>
                            </div>
                          </div>
                        )}

                        <button
                          onClick={() => void loadExistingSummaries()}
                          disabled={loadingClinicalJsonReuse || !isValidExistingSummaryJson}
                          className="w-full px-4 py-2 rounded-lg flex items-center justify-center gap-2"
                          style={{
                            backgroundColor: loadingClinicalJsonReuse || !isValidExistingSummaryJson ? '#9ca3af' : '#11074A',
                            color: 'white',
                            opacity: loadingClinicalJsonReuse || !isValidExistingSummaryJson ? 0.7 : 1,
                            cursor: loadingClinicalJsonReuse || !isValidExistingSummaryJson ? 'not-allowed' : 'pointer' }}
                          title={
                            isValidExistingSummaryJson
                              ? 'Use selected summary Corpus'
                              : 'Select a Corpus file from the list above'
                          }
                        >
                          {loadingClinicalJsonReuse ? (
                            <>
                              <FaSpinner className="animate-spin" />
                              Loading...
                            </>
                          ) : (
                            <>
                              <FaFileAlt />
                              Use Existing Corpus
                            </>
                          )}
                        </button>
                      </div>
                      </div>
                    </div>

                  </div>
                </div>
              </div>
              )}
            </div>
          </div>
        )}
        </div>
        {(showCorpusLayoutTutorialOverlay ||
          showMetaCorpusLayoutTutorialOverlay ||
          showMetaConfirmTutorialOverlay ||
          showGenericWizardTutorialOverlay) && (
          <>
            <div
              className="absolute inset-0 z-[100] bg-gray-900/10 backdrop-blur-none pointer-events-auto"
              aria-hidden
            />
            <div className="pointer-events-none absolute inset-0 z-[110] flex flex-col justify-end">
              <div
                className={`pointer-events-auto border-t border-gray-200 px-4 shadow-[0_-8px_24px_rgba(17,7,74,0.12)] sm:px-6 ${
                  showGenericWizardTutorialOverlay
                    ? genericWizardTutorialStep === 1
                      ? 'bg-white py-8'
                      : 'bg-white py-3'
                    : showMetaConfirmTutorialOverlay
                      ? metaConfirmTutorialStep === 1
                        ? 'bg-white py-8'
                        : 'bg-white py-3'
                      : activeLayoutTutorialStep === 1
                        ? 'bg-white py-8'
                        : 'bg-white py-3'
                }`}
                role="dialog"
                aria-label={
                  showGenericWizardTutorialOverlay
                    ? t('reportCreationModal.walkthrough.chrome.tipsAria')
                    : showMetaConfirmTutorialOverlay
                      ? t('reportCreationModal.walkthrough.chrome.metaConfirmAria')
                      : activeView === 'metacorpus'
                        ? t('reportCreationModal.walkthrough.chrome.metaCorpusLayoutAria')
                        : t('reportCreationModal.walkthrough.chrome.corpusLayoutAria')
                }
              >
                <div className="mx-auto flex max-w-4xl flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                  <div className="min-w-0 flex-1">
                    {showGenericWizardTutorialOverlay && currentGenericTutorialSlide ? (
                      <>
                        <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: '#6b7280' }}>
                          {t('reportCreationModal.walkthrough.chrome.stepOf', {
                            current: genericWizardTutorialStep,
                            total: genericTutorialMaxSteps })}
                        </div>
                        <div className="mt-0.5 text-base font-semibold" style={{ color: '#11074A' }}>
                          {currentGenericTutorialSlide.title}
                        </div>
                        <p className="mt-1 text-sm leading-relaxed text-gray-700">{currentGenericTutorialSlide.body}</p>
                      </>
                    ) : showMetaConfirmTutorialOverlay && currentMetaConfirmSlide ? (
                      <>
                        <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: '#6b7280' }}>
                          {t('reportCreationModal.walkthrough.chrome.stepOf', {
                            current: metaConfirmTutorialStep,
                            total: 7 })}
                        </div>
                        <div className="mt-0.5 text-base font-semibold" style={{ color: '#11074A' }}>
                          {currentMetaConfirmSlide.title}
                        </div>
                        <p className="mt-1 text-sm leading-relaxed text-gray-700">{currentMetaConfirmSlide.body}</p>
                      </>
                    ) : currentCorpusLayoutSlide ? (
                      <>
                        <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: '#6b7280' }}>
                          {t('reportCreationModal.walkthrough.chrome.stepOf', {
                            current: activeLayoutTutorialStep - 1,
                            total: 4 })}
                        </div>
                        <div className="mt-0.5 text-base font-semibold" style={{ color: '#11074A' }}>
                          {currentCorpusLayoutSlide.title}
                        </div>
                        <p className="mt-1 text-sm leading-relaxed text-gray-700">{currentCorpusLayoutSlide.body}</p>
                      </>
                    ) : null}
                  </div>
                  <div className="flex flex-shrink-0 flex-wrap items-center gap-2 sm:pt-1">
                    <button
                      type="button"
                      onClick={
                        showGenericWizardTutorialOverlay
                          ? dismissGenericWizardTutorial
                          : showMetaConfirmTutorialOverlay
                            ? dismissMetaConfirmTutorial
                            : activeView === 'metacorpus'
                              ? dismissMetaCorpusLayoutTutorial
                              : dismissCorpusLayoutTutorial
                      }
                      className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                      {t('reportCreationModal.buttons.skip')}
                    </button>
                    <button
                      type="button"
                      onClick={
                        showGenericWizardTutorialOverlay
                          ? goPrevGenericWizardTutorial
                          : showMetaConfirmTutorialOverlay
                            ? goPrevMetaConfirmTutorial
                            : activeView === 'metacorpus'
                              ? goPrevMetaCorpusTutorial
                              : goPrevCorpusTutorial
                      }
                      disabled={
                        showGenericWizardTutorialOverlay
                          ? genericWizardTutorialStep <= 1
                          : showMetaConfirmTutorialOverlay
                            ? metaConfirmTutorialStep === 1
                            : activeLayoutTutorialStep === 1
                      }
                      className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {t('reportCreationModal.buttons.back')}
                    </button>
                    <button
                      type="button"
                      onClick={
                        showGenericWizardTutorialOverlay
                          ? goNextGenericWizardTutorial
                          : showMetaConfirmTutorialOverlay
                            ? goNextMetaConfirmTutorial
                            : activeView === 'metacorpus'
                              ? goNextMetaCorpusTutorial
                              : goNextCorpusTutorial
                      }
                      className="rounded-lg px-4 py-2 text-sm font-semibold text-white"
                      style={{ backgroundColor: '#11074A' }}
                    >
                      {showGenericWizardTutorialOverlay
                        ? genericWizardTutorialStep >= genericTutorialMaxSteps
                          ? t('reportCreationModal.buttons.done')
                          : t('reportCreationModal.buttons.next')
                        : showMetaConfirmTutorialOverlay
                          ? metaConfirmTutorialStep === 7
                            ? t('reportCreationModal.buttons.done')
                            : t('reportCreationModal.buttons.next')
                          : activeLayoutTutorialStep === 4
                            ? t('reportCreationModal.buttons.done')
                            : t('reportCreationModal.buttons.next')}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );

  return createPortal(modalContent, portalContainer);
}
