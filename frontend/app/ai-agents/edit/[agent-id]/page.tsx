"use client";

import { MathJaxContext } from 'better-react-mathjax';
import { mathJaxConfig as mathConfig, preprocessMath } from '@/app/lib/mathJax';
import { useSession } from 'next-auth/react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStepModels } from '../../../hooks/useStepModels';
import GalileoCatalogStatus from '../../../components/GalileoCatalogStatus';
import StepModelOptions from '../../../components/StepModelOptions';
import StepRunStatus from '../../../components/StepRunStatus';
import { canSelectStepModel, isGalileoModel } from '../../../lib/stepModels';
import { assertStepModelReady, getGalileoGenerationSettings, getStepEndpoint, getStepFailureDiagnostics, isStepSessionFailure, parseStepRunDiagnostics, readStepRunResponse, type StepRunDiagnostics } from '../../../lib/stepExecution';
import {
  FaArrowLeft,
  FaBookOpen,
  FaBrain,
  FaBug,
  FaChevronDown,
  FaChevronUp,
  FaClone, FaCopy, FaDownload, FaExclamationTriangle,
  FaEye,
  FaEyeSlash,
  FaFileAlt,
  FaFolder,
  FaGoogleDrive,
  FaImage,
  FaNewspaper,
  FaPen,
  FaPlay,
  FaPlus,
  FaSave,
  FaShieldAlt,
  FaSpinner,
  FaTimes,
  FaUser
} from 'react-icons/fa';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { CollectionContextProvider, useCollectionContext } from '../../../components/CollectionContext';
import ListExtracts, { type SelectedRag } from '../../../components/ListExtracts';
import ProjectFilePicker, { type SelectedFile } from '../../../components/ProjectFilePicker';
import { useProjectState } from '../../../components/ProjectStateContext';
import ScientificPaperSearch, { SelectedPaper } from '../../../components/ScientificPaperSearch';
import StepReferenceSelector, { Step, getTagColor } from '../../../components/StepReferenceSelector';

import { DEFAULT_MODEL, isValidModel, isImageModel, withImageModels, type ModelValue } from '../../../lib/modelConfig';
import { generateStepImages, fileToBase64, dataUrlToInlineData, type InlineImage } from '../../../lib/imageGen';
import { getLayerImageUrls } from '../../../canvas-272/lib/layerOutput';
import { getRequiredFoldersCount } from '../../../lib/project-constants';
import { BibliographyItem } from '../../../lib/types';
import { isPickableFile, getGoogleDriveDownloadUrl, validateFileSize, detectPdfPageCount, MAX_FILE_SIZE_BYTES } from '../../../lib/fileValidation';
import { addRecentAgent, recordAgentOpened } from '../../../lib/recentItemsManager';
import { useVoiceModalOpen } from '../../../lib/voice/voiceModalEvents';
import PersonaPopup from '../../components/PersonaPopup';
import PromptActionsPopup from '../../components/PromptActionsPopup';
import { useGlobalStepExecution } from '../../hooks/useGlobalStepExecution';
import { useRunAllStepsManager, type RunAllProgress } from '../../hooks/useRunAllStepsManager';
import { IntegrityChainProvider, useIntegrityChain } from '../../../contexts/IntegrityChainContext';
import { createIntegrityRecord } from '../../../lib/integrity';
import { filterAIResponseSections } from '../../../lib/filterAIStepOutput';
import { resolveLayerCorpusId as resolveLayerCorpusIdShared, collectCorpusIdCandidatesFromLayer, collectLayerCorpusDisplayHints } from '../../../agentnodes/lib/corpus';
import { CorpusPickerDropdown, type CorpusPickerItem } from '../../../agentnodes/components/CorpusPickerDropdown';
import { v1ScanProjectCorpusLinks, v1AddProjectCorpusLink, type ProjectCorpusLink } from '../../../lib/agentnodesApi/agentnodesV1Client';
import { resolveStoreNameFromLinks } from '../../../lib/agentnodesApi/projectCorpusLinks';
import { isDevUser } from '../../../lib/devAccess';
import { AgentEditorProvider, useAgentEditor, type AgentData, type Layer } from './AgentEditorContext';
import AgentEditorSidebar from './AgentEditorSidebar';
import AnswerDebugPanel from '../../../components/AnswerDebugPanel';
import type { AnswerDebugInfo, DebugAnswerSupport, DebugSourceChunk } from '../../../lib/answerDebug';
import nextDynamic from 'next/dynamic';

// Sentinel used by the linear-view step filter to represent "steps with no tag".
const STEP_FILTER_UNTAGGED = '__step_filter_untagged__';

interface StepRunApiResponse {
  response?: string;
  isGrounded?: boolean;
  groundingChunks?: unknown[];
  sources?: DebugSourceChunk[];
  supports?: DebugAnswerSupport[];
  reasoning?: string | null;
  error?: string;
  runDiagnostics?: StepRunDiagnostics;
}

// Safety net: force-dismiss hover tooltips after this long in case onMouseLeave
// never fires (e.g. a control becomes disabled while hovered, re-renders, or unmounts).
const TOOLTIP_AUTO_CLOSE_MS = 8000;

function buildStepDebugInfo(data: StepRunApiResponse, model: string): AnswerDebugInfo {
  return {
    reasoning: typeof data.reasoning === 'string' ? data.reasoning : undefined,
    model,
    grounded: data.isGrounded ?? (Array.isArray(data.sources) && data.sources.length > 0),
    sources: Array.isArray(data.sources) ? data.sources : [],
    supports: Array.isArray(data.supports) ? data.supports : [],
    capturedAt: new Date().toISOString(),
  };
}

const AgentNodesView = nextDynamic(() => import('../../../agentnodes/components/AgentNodesView'), { ssr: false });
const OutputView = nextDynamic(() => import('./OutputView'), { ssr: false });
const LogView = nextDynamic(() => import('./LogView'), { ssr: false });
const PersonaPromptEditor = nextDynamic(() => import('../../components/PersonaPromptEditor'), { ssr: false });
const EnhancementModal = nextDynamic(() => import('../../components/EnhancementModal'), { ssr: false });
const MissingFoldersModal = nextDynamic(() => import('../../../components/MissingFoldersModal'), { ssr: false });
const IntegrityChainModal = nextDynamic(() => import('../../../components/IntegrityChainModal'), { ssr: false });

interface GeminiRequestPayload {
  messages: { role: string; text: string }[];
  model: ModelValue;
  ragKnowledge?: { id: string; filename?: string }[];
  projectId?: string;
  systemInstruction?: { role: 'system'; text: string };
}

import ReactDOM from 'react-dom';
import { usePageReady } from '../../../components/SplashScreenWrapper';
import { useNavigationLoading } from '../../../contexts/NavigationLoadingContext';
import { ThemeProvider } from '../../../contexts/ThemeContext';
import { canAutosaveAgentVersion, saveAgentWithVersioning, type AgentData as AgentSnapshot, type VersionedAgentData } from '../../../lib/versionUtils';
import { useAgentRunVersioning, type AgentVersionRun } from '../../hooks/useAgentRunVersioning';
import OutputFrame from '../../components/OutputFrame';
import BeautifulModal from '../../components/BeautifulModal';
import '../../style.css';
import { buildStepMessagesPayload, buildStepImagePrompt, buildReferencedStepsContext, combineSkillsWithSystemInstruction } from '../../../lib/stepPrompt';
import { resolveSubsetFilter } from '../../../rag-optimization/lib/metadataFilter';
import SkillsPanel from '../../../components/skills/SkillsPanel';
import { normalizeAgentInputMetadata, type AgentInputMetadata } from '../../../lib/agentFiles';
import { hasAgentInputs, snapshotAgentInputMetadata, type AgentInputSnapshot } from '../../../lib/agentInputs';
import { prepareAgentInputSnapshot } from '../../../lib/agentFilesApi';
import { fetchWithAgentInputs, getActiveStepInputs, getAgentInputFileSourceId, prepareAgentImagePrompt, registerAgentInputFile } from '../../../lib/agentInputsClient';
import AgentFilesPanel, { AgentFilesIndicator } from '../../../components/agent-files/AgentFilesPanel';
import { useSkillsLibrary } from '../../../components/skills/useSkillsLibrary';

interface QcRow {
  claim:       string;
  status:      'MATCHING' | 'PARTIALLY_MATCHING' | 'NOT_MATCHING' | 'SOURCE_NOT_FOUND' | 'PENDING';
  action:      string;
  ragLocation: string | null;
  rationale:   string;
  sourceDoc:   string;
}

function stripDateSuffixFromAgentName(name: string): string {
  if (!name || typeof name !== 'string') return name;
  return name.replace(/-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}$/, '').trim() || name;
}

type LayerWithState = Layer & {
  userInput?: string;
  ragKnowledge?: SelectedRag[];
  collection?: number;
};

type DataType = 'collection' | 'rag' | 'input' | 'file';

type FileWithReplaceFlag = File & { _replaceExistingRAG?: boolean };

const setReplaceExistingFlag = (file: File, value: boolean) => {
  (file as FileWithReplaceFlag)._replaceExistingRAG = value;
};

const hasReplaceExistingFlag = (file: File): boolean => {
  return Boolean((file as FileWithReplaceFlag)._replaceExistingRAG);
};

const normalizePdfName = (name: string): string =>
  name.trim().toLowerCase().replace(/\.pdf$/i, '');

interface CorpusPdfNameResolution {
  resolved: string[];
  matched: number;
  unmatched: string[];
}

const resolveCorpusPdfNames = (
  selectedNames: readonly string[],
  liveDocs: readonly { pdfName: string }[],
): CorpusPdfNameResolution => {
  if (selectedNames.length === 0) {
    return { resolved: [], matched: 0, unmatched: [] };
  }
  const liveByNorm = new Map<string, string>();
  for (const d of liveDocs) {
    if (!d.pdfName) continue;
    const norm = normalizePdfName(d.pdfName);
    if (norm && !liveByNorm.has(norm)) liveByNorm.set(norm, d.pdfName);
  }
  const resolved: string[] = [];
  const unmatched: string[] = [];
  let matched = 0;
  for (const sel of selectedNames) {
    if (typeof sel !== 'string' || !sel) continue;
    const live = liveByNorm.get(normalizePdfName(sel));
    if (live) {
      resolved.push(live);
      matched += 1;
    } else {
      resolved.push(sel);
      unmatched.push(sel);
    }
  }
  return { resolved, matched, unmatched };
};


// A selectable corpus document as returned by /api/rag/corpora/[id]/documents.
// `fileId` (2026-07+) is the stable filter key; `pdfName` is display + legacy fallback.
type StepCorpusDoc = { fileId: string | null; pdfName: string; pdfNameSource?: string; state: string };

interface Tooltip {
  x: number;
  y: number;
  text: string;
}

const enhanceReadability = (text: string) => {
    let enhanced = text;

    enhanced = enhanced.replace(/^🧠\s*(.*?)$/gm, '\n**$1**\n');
    enhanced = enhanced.replace(/^🚀\s*(.*?)$/gm, '\n**$1**\n');
    enhanced = enhanced.replace(/^📊\s*(.*?)$/gm, '\n**$1**\n');
    enhanced = enhanced.replace(/^🎯\s*(.*?)$/gm, '\n**$1**\n');
    enhanced = enhanced.replace(/^🔍\s*(.*?)$/gm, '\n**$1**\n');
    enhanced = enhanced.replace(/^📄\s*(.*?)$/gm, '\n**$1**\n');

    enhanced = enhanced.replace(/^(IDENTIFY THE MISTAKES|PROPOSE SOLUTION|BE CRITICAL OF YOUR PROPOSED SOLUTION|REFINE THE SOLUTION BASED ON CRITICISM|INTROSPECTION STEP|KEY IMPROVEMENTS MADE|IMPROVED RESULT|CONFIDENCE LEVEL|FINAL ANSWER|RE-READ WHAT YOU WROTE|SUMMARY|ANALYSIS|METHODOLOGY|FINDINGS|CONCLUSIONS|RECOMMENDATIONS|ASSESSMENT|EVALUATION|REVIEW|VALIDATION|RESULTS|DISCUSSION|BACKGROUND|CONTEXT|OVERVIEW|EXECUTIVE SUMMARY)(:?)$/gm, '\n**$1**$2\n');

    enhanced = enhanced.replace(/^(Extraction \(by page\)|Tables|Figures|Key Data Points|Instructions|Goal|Introspection Philosophy|REQUIRED ANALYSIS STEPS)(:?)$/gm, '\n**$1**$2\n');

    enhanced = enhanced.replace(/^(STEP CONTEXT|ACTUAL OUTPUT|DEEP INTROSPECTION METHODOLOGY|ANALYSIS REQUIRED|USER'S ORIGINAL REQUEST|USER INPUT PROVIDED|FILES PROVIDED|ORIGINAL TASK CONTEXT|ORIGINAL OUTPUT \(TO IMPROVE\)|ANALYSIS INSIGHTS|YOUR TASK|OUTPUT FORMAT)(:?)$/gm, '\n**$1**$2\n');

    enhanced = enhanced.replace(/^(\d+\.\s+[A-Z][A-Z\s]+)(:?)$/gm, '\n**$1**$2\n');

    enhanced = enhanced.replace(/^(- Page \d+)(:)$/gm, '\n\n**$1**$2\n');
    enhanced = enhanced.replace(/^(Page \d+)(:)$/gm, '\n\n**$1**$2\n');

    enhanced = enhanced.replace(/^(\s*- )(Tables|Figures|Key Data Points)(:)$/gm, '$1**$2**$3');

    enhanced = enhanced.replace(/^(\s*- )(\[.*?\]|\w.*?)(:)(\s.*)/gm, '$1**$2**$3$4');

    enhanced = enhanced.replace(/(\n- Page \d+:)/g, '\n$1');

    enhanced = enhanced.replace(/^([A-Z][A-Z\s]{4 })(:?)$/gm, '\n**$1**$2\n');

    enhanced = enhanced.replace(/^([A-Z][A-Z\s]+ EVALUATION)(:?)$/gm, '\n**$1**$2\n');

    enhanced = enhanced.replace(/^([A-Z\s]*VERDICT[A-Z\s]*)(:?)$/gm, '\n**$1**$2\n');

    enhanced = enhanced.replace(/\n{4 }/g, '\n\n\n');

    return enhanced;
};

const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      console.log("Copied to clipboard!");
    } catch (err) {
      console.error("Failed to copy:", err);
    }
};

const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkMath];

const markdownComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
        pre: ({ children, ...props }) => {
          const hasCodeChild = React.Children.toArray(children).some(
            child => React.isValidElement(child) && child.type === 'code'
          );

          return (
            <pre {...props} style={{
              position: 'relative',
              background: '#f8f9fa',
              padding: '1rem',
              borderRadius: '0.375rem',
              overflow: 'auto',
              border: '1px solid #e5e7eb'
            }}>
              {children}
              {hasCodeChild && (
                <button
                  onClick={() => {
                    const text = (children as React.ReactElement)?.props?.children || '';
                    copyToClipboard(text);
                  }}
                  style={{
                    position: 'absolute',
                    top: '8px',
                    right: '8px',
                    background: '#ffffff',
                    border: '1px solid #d1d5db',
                    borderRadius: '4px',
                    padding: '4px 8px',
                    cursor: 'pointer',
                    fontSize: '12px',
                    color: '#6b7280'
                  }}
                >
                  Copy
                </button>
              )}
            </pre>
          );
        },
        code: ({ children, inline, ...restProps }: React.ComponentProps<'code'> & { inline?: boolean }) => {
          if (inline) {
            return (
              <code
                {...restProps}
                style={{
                  background: '#f3f4f6',
                  padding: '0.125rem 0.25rem',
                  borderRadius: '0.25rem',
                  fontSize: '0.875em',
                  fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
                }}
              >
                {children}
              </code>
            );
          }
          return <code {...restProps}>{children}</code>;
        }
};

const MarkdownWithMath = React.memo(({ content }: { content: string }) => {
  const processed = useMemo(() => preprocessMath(enhanceReadability(content)), [content]);
  return (
    <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} components={markdownComponents}>
      {processed}
    </ReactMarkdown>
  );
});
MarkdownWithMath.displayName = 'MarkdownWithMath';

const EditAgentPage: React.FC = () => {
  const { models, catalog, refreshing, refreshCatalog } = useStepModels();
  const modelOptions = useMemo(() => withImageModels(models), [models]);

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const deepLinkStepId = searchParams?.get('step') ?? null;
  const isEmbedded = searchParams?.get('embed') === '1';
  const runAllOnLoad = searchParams?.get('runAll') === '1';
  const { projectFolder } = useProjectState();
  const { collections } = useCollectionContext();
  const { signalPageReady, signalPageNotReady } = usePageReady();
  const { endNavigation } = useNavigationLoading();
  const agentId = decodeURIComponent((pathname ?? '').split('/').filter(Boolean).pop() || '');
  const { data: session } = useSession() as { data: { accessToken?: string; user?: { name?: string; email?: string } } | null };
  // Corpus search over all attachable corpora is a dev-only feature (allow-list).
  const canSearchCorpora = isDevUser(session?.user?.email);

  const [agentName, setAgentName] = useState('');
  const { agent, setAgent, agentRef, runVersioningRef, updateLayer: updateEditorLayer, updateSkillIds, updateInputs, logActivity, logStepEdit } = useAgentEditor();

  const skillsLib = useSkillsLibrary(Boolean(session?.accessToken));
  const attachedSkillIds = agent?.metadata?.skillIds ?? [];

  useEffect(() => {
    if (agent?.name) {
      setAgentName(stripDateSuffixFromAgentName(agent.name));
    }
  }, [agent?.name]);
  const bibSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoadedTokenRef = useRef<string | undefined>(undefined);
  const isMountedRef = useRef(true);
  const handleAutosaveRef = useRef<() => Promise<void>>(async () => {});
  const runAbortRef = useRef<AbortController | null>(null);
  const runAllVersionRef = useRef<AgentVersionRun | null>(null);
  const sharedBatchInputsRef = useRef<{ metadata: AgentInputMetadata; prepared?: Promise<AgentInputSnapshot>; cancelled: boolean } | null>(null);
  useEffect(() => () => {
    runAbortRef.current?.abort();
    if (sharedBatchInputsRef.current) sharedBatchInputsRef.current.cancelled = true;
  }, [agentId, projectFolder?.projectId, session?.user?.email]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastAutosaveTime, setLastAutosaveTime] = useState<number>(0);
  const [isAutosaving, setIsAutosaving] = useState(false);
  const [lastSaveTimestamp, setLastSaveTimestamp] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [timeUpdateTrigger, setTimeUpdateTrigger] = useState(0);

  const [, setMasterContextString] = useState('');
  const [selectedAgentFiles, setSelectedAgentFiles] = useState<SelectedFile[]>([]);
  const [selectedAgentPapers, setSelectedAgentPapers] = useState<SelectedPaper[]>([]);
  const [_selectedAgentRag, setSelectedAgentRag] = useState<SelectedRag[]>([]);

  const _getAttachedRagItems = (layerId: string): SelectedRag[] => {
    const layer = agent?.layers.find(l => l.id === layerId);
    const ragItems = layer?.ragKnowledge || [];
    console.log(`🔍 [GetRAG] Layer ${layerId} has ${ragItems.length} RAG items:`, ragItems.map(r => r.filename));
    return ragItems;
  };

  const isDataTypeDisabled = (layer: LayerWithState | undefined, dataType: DataType): boolean => {
    if (!layer) return false;
    
    const hasRagKnowledge = (layer.ragKnowledge && layer.ragKnowledge.length > 0);
    
    if (hasRagKnowledge && (dataType === 'file' || dataType === 'collection')) {
      return true;
    }
    
    return false;
  };
  
  const _isBibliographyReadOnly = (layer: LayerWithState | undefined): boolean => {
    if (!layer) return false;
    return (layer.ragKnowledge && layer.ragKnowledge.length > 0) || false;
  };

  const [inputsVisible, setInputsVisible] = useState<Record<string, boolean>>({});
  const [fileStates, setFileStates] = useState<Record<string, { files: File[], fileUrls: string[] }>>({});
  const [filePageCounts, setFilePageCounts] = useState<Record<string, number[]>>({});
  const [attachingFiles, setAttachingFiles] = useState<Record<string, boolean>>({});
  const pendingFileAttachmentsRef = useRef(new Set<string>());
  const [_bibliographyHighlight, setBibliographyHighlight] = useState<Record<string, boolean>>({});

  const [availableCorpora, setAvailableCorpora] = useState<Array<{
    id: string;
    corpusId?: string;
    displayName: string;
    files?: Array<{ name: string; status: string }>;
  }>>([]);
  const [stepCorpusIds, setStepCorpusIds] = useState<Record<string, string>>({});
  const [stepDocumentSelections, setStepDocumentSelections] = useState<Record<string, string[]>>({});
  const [stepCorpusDocuments, setStepCorpusDocuments] = useState<Record<string, StepCorpusDoc[]>>({});
  const [stepCorpusDocumentsLoading, setStepCorpusDocumentsLoading] = useState<Record<string, boolean>>({});
  const [stepInputTab, setStepInputTab] = useState<Record<string, 'text' | 'upload' | 'bibliography' | 'files' | 'papers' | 'corpus'>>({});
  const [projectCorpusLinks, setProjectCorpusLinks] = useState<ProjectCorpusLink[]>([]);

  const [stepQcEnabled,         setStepQcEnabled]         = useState<Record<string, boolean>>({});
  const [stepIncludeThoughts,   setStepIncludeThoughts]   = useState<Record<string, boolean>>({});
  const [stepThinkingLevel,     setStepThinkingLevel]     = useState<Record<string, 'minimal' | 'low' | 'medium' | 'high'>>({});
  const [stepOptimizeQuery,     setStepOptimizeQuery]     = useState<Record<string, boolean>>({});
  const [stepQcRunning,         setStepQcRunning]         = useState<Record<string, boolean>>({});
  const [stepQcRows,            setStepQcRows]            = useState<Record<string, QcRow[]>>({});
  const [stepQcError,           setStepQcError]           = useState<Record<string, string | null>>({});
  type QcPhase = 'idle' | 'extracting' | 'selecting' | 'verifying' | 'done';
  const [stepQcPhase,           setStepQcPhase]           = useState<Record<string, QcPhase>>({});
  const [stepQcExtractedClaims, setStepQcExtractedClaims] = useState<Record<string, string[]>>({});
  const [stepQcSelectedClaims,  setStepQcSelectedClaims]  = useState<Record<string, number[]>>({});
  const [stepQcExpandedRow,     setStepQcExpandedRow]     = useState<Record<string, number | null>>({});

  const [draggingStepId, setDraggingStepId] = useState<string | null>(null);
  const [dragOverStepId, setDragOverStepId] = useState<string | null>(null);
  const [justDroppedStepId, setJustDroppedStepId] = useState<string | null>(null);

  const stepNodeRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const stepPrevRectsRef = useRef<Map<string, DOMRect>>(new Map());
  const stepPrevOrderRef = useRef<string[]>([]);
  const stepPrevAgentIdRef = useRef(agentId);
  const dragReorderRafRef = useRef<number | null>(null);
  const lastReorderAtRef = useRef<number>(0);
  const reorderLockUntilRef = useRef<number>(0);
  const lastOverIdRef = useRef<string | null>(null);
  const REORDER_THROTTLE_MS = 450;
  const DROP_LOCK_MS = 1000;

  const setStepNodeRef = useCallback((stepId: string) => {
    return (el: HTMLDivElement | null) => {
      stepNodeRefs.current[stepId] = el;
    };
  }, []);

  useEffect(() => {
    if (!isEmbedded) return;
    document.body.classList.add('agent-edit-embed');
    const singleStep = Boolean(deepLinkStepId);
    if (singleStep && deepLinkStepId) {
      document.body.classList.add('agent-edit-embed-step');
      document.body.setAttribute('data-embed-step', deepLinkStepId);
    }
    return () => {
      document.body.classList.remove('agent-edit-embed');
      document.body.classList.remove('agent-edit-embed-step');
      document.body.removeAttribute('data-embed-step');
    };
  }, [isEmbedded, deepLinkStepId]);

  useEffect(() => {
    if (!deepLinkStepId) return;
    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 40;

    const tryScroll = () => {
      if (cancelled) return;
      const el = stepNodeRefs.current[deepLinkStepId]
        ?? document.getElementById(`agent-step-${deepLinkStepId}`);
      if (el) {
        if (isEmbedded) {
          el.classList.add('agent-step-embed-focus');
        }
        if (!isEmbedded) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          el.classList.add('agent-step-focus-flash');
          window.setTimeout(() => {
            el.classList.remove('agent-step-focus-flash');
          }, 2400);
        }
        return;
      }
      if (attempts++ < maxAttempts) {
        window.setTimeout(tryScroll, 100);
      }
    };

    tryScroll();
    return () => {
      cancelled = true;
      const el = stepNodeRefs.current[deepLinkStepId]
        ?? document.getElementById(`agent-step-${deepLinkStepId}`);
      el?.classList.remove('agent-step-embed-focus');
    };
  }, [deepLinkStepId, agentId, isEmbedded]);

  const reindexLayers = useCallback(<T extends { order: number }>(layers: T[]): T[] => {
    return layers.map((l, idx) => ({ ...l, order: idx } as T));
  }, []);

  const moveLayer = useCallback(<T extends { id: string; order: number }>(
    layers: T[],
    fromId: string,
    toId: string
  ): T[] => {
    const fromIndex = layers.findIndex(l => l.id === fromId);
    const toIndex = layers.findIndex(l => l.id === toId);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return layers;

    const next = [...layers];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    return reindexLayers(next);
  }, [reindexLayers]);

  useLayoutEffect(() => {
    const layers = agent?.layers || [];
    const nextOrder = layers.map(layer => layer.id);
    const previousOrder = stepPrevOrderRef.current;
    const previousIds = new Set(previousOrder);
    const reordered = stepPrevAgentIdRef.current === agentId
      && previousOrder.length === nextOrder.length
      && nextOrder.every(stepId => previousIds.has(stepId))
      && nextOrder.some((stepId, index) => stepId !== previousOrder[index]);

    const nextRects = new Map<string, DOMRect>();
    for (const layer of layers) {
      const el = stepNodeRefs.current[layer.id];
      if (!el) continue;
      nextRects.set(layer.id, el.getBoundingClientRect());
    }

    const prevRects = stepPrevRectsRef.current;
    stepPrevRectsRef.current = nextRects;
    stepPrevOrderRef.current = nextOrder;
    stepPrevAgentIdRef.current = agentId;
    if (!reordered) return;

    for (const layer of layers) {
      const el = stepNodeRefs.current[layer.id];
      const prev = prevRects.get(layer.id);
      const next = nextRects.get(layer.id);
      if (!el || !prev || !next) continue;

      const dy = prev.top - next.top;
      if (Math.abs(dy) < 1) continue;

      try {
        el.animate(
          [
            { transform: `translateY(${dy}px)` },
            { transform: 'translateY(0)' }
          ],
          {
            duration: 650,
            easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
          }
        );
      } catch {
      }
    }
  }, [agent?.layers, agentId]);

  const handleStepDragStart = (e: React.DragEvent<HTMLElement>, stepId: string) => {
    setDraggingStepId(stepId);
    setDragOverStepId(stepId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', stepId);
    lastReorderAtRef.current = 0;
    reorderLockUntilRef.current = 0;
    lastOverIdRef.current = null;
  };

  const handleStepDragOver = (e: React.DragEvent<HTMLElement>, overStepId: string) => {
    if (!draggingStepId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverStepId !== overStepId) setDragOverStepId(overStepId);

    if (overStepId === draggingStepId) return;
    const now = Date.now();
    if (now < reorderLockUntilRef.current) return;
    if (now - lastReorderAtRef.current < REORDER_THROTTLE_MS) return;
    if (lastOverIdRef.current === overStepId) return;

    lastReorderAtRef.current = now;
    lastOverIdRef.current = overStepId;

    if (dragReorderRafRef.current) return;
    dragReorderRafRef.current = window.requestAnimationFrame(() => {
      dragReorderRafRef.current = null;
      setAgent(prev => {
        if (!prev) return prev;
        const nextLayers = moveLayer(prev.layers || [], draggingStepId, overStepId);
        return { ...prev, layers: nextLayers };
      });
    });
  };

  const handleStepDrop = (e: React.DragEvent<HTMLElement>, dropStepId: string) => {
    if (!draggingStepId) return;
    e.preventDefault();
    const sourceId = e.dataTransfer.getData('text/plain') || draggingStepId;
    if (!sourceId || sourceId === dropStepId) {
      setDragOverStepId(null);
      return;
    }

    setAgent(prev => {
      if (!prev) return prev;
      const nextLayers = moveLayer(prev.layers || [], sourceId, dropStepId);
      return { ...prev, layers: nextLayers };
    });

    setJustDroppedStepId(sourceId);
    window.setTimeout(() => setJustDroppedStepId(null), 320);
    reorderLockUntilRef.current = Date.now() + DROP_LOCK_MS;
    setDragOverStepId(null);
    setDraggingStepId(null);
    if (dragReorderRafRef.current) {
      window.cancelAnimationFrame(dragReorderRafRef.current);
      dragReorderRafRef.current = null;
    }
  };

  const handleStepDragEnd = () => {
    setDraggingStepId(null);
    setDragOverStepId(null);
    if (dragReorderRafRef.current) {
      window.cancelAnimationFrame(dragReorderRafRef.current);
      dragReorderRafRef.current = null;
    }
  };

  const [_bibliographyVerification, setBibliographyVerification] = useState<Record<string, 'unverified' | 'checking' | 'verified' | 'not_found' | 'local_path'>>({});
  const [_bibliographyVerificationDetails, setBibliographyVerificationDetails] = useState<Record<string, { webViewLink?: string; message?: string; fileName?: string; note?: string }>>({});
  
  const _verifyBibliographyFile = async (layerId: string, itemIndex: number, item: BibliographyItem) => {
    const verificationKey = `${layerId}-${itemIndex}`;
    setBibliographyVerification(prev => ({ ...prev, [verificationKey]: 'checking' }));
    setBibliographyVerificationDetails(prev => ({ ...prev, [verificationKey]: { message: 'Searching in Google Drive...' } }));
    
    try {
      const path = item.path || '';
      const fileName = item.name || '';
      
      if (path.startsWith('/uploads/') || path.startsWith('/PDFs/')) {
        try {
          const response = await fetch(path, { method: 'HEAD' });
          if (response.ok) {
            setBibliographyVerification(prev => ({ ...prev, [verificationKey]: 'verified' }));
            setBibliographyVerificationDetails(prev => ({ ...prev, [verificationKey]: { message: 'File accessible at local path' } }));
            return;
          }
        } catch {
        }
      }
      
      const response = await fetch('/api/ai-agents/verify-bibliography', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: fileName,
          filePath: path,
          projectId: projectFolder?.projectId
        })
      });
      
      const result = await response.json();
      
      if (result.found) {
        setBibliographyVerification(prev => ({ ...prev, [verificationKey]: 'verified' }));
        setBibliographyVerificationDetails(prev => ({ 
          ...prev, 
          [verificationKey]: { 
            webViewLink: result.webViewLink,
            message: result.message,
            fileName: result.fileName
          } 
        }));
      } else {
        if (result.pathType === 'local') {
          setBibliographyVerification(prev => ({ ...prev, [verificationKey]: 'local_path' }));
          setBibliographyVerificationDetails(prev => ({ 
            ...prev, 
            [verificationKey]: { 
              message: result.message,
              note: result.note
            } 
          }));
        } else if (result.pathType === 'gdrive') {
          setBibliographyVerification(prev => ({ ...prev, [verificationKey]: 'not_found' }));
          setBibliographyVerificationDetails(prev => ({ 
            ...prev, 
            [verificationKey]: { 
              message: result.message || 'File not found in Google Drive'
            } 
          }));
        } else {
          setBibliographyVerification(prev => ({ ...prev, [verificationKey]: 'not_found' }));
          setBibliographyVerificationDetails(prev => ({ 
            ...prev, 
            [verificationKey]: { 
              message: result.message || 'File not found'
            } 
          }));
        }
      }
    } catch (error) {
      console.error('Error verifying bibliography file:', error);
      setBibliographyVerification(prev => ({ ...prev, [verificationKey]: 'not_found' }));
      setBibliographyVerificationDetails(prev => ({ 
        ...prev, 
        [verificationKey]: { 
          message: 'Verification failed - please check your connection'
        } 
      }));
    }
  };

  const syncFileBibliography = (layerId: string, files: File[]) => {
    setAgent(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        layers: prev.layers.map(layer => {
          if (layer.id !== layerId) return layer;
          const nonFileBib = (layer.bibliography || []).filter(b => b.type !== 'file');
          const fileBib: BibliographyItem[] = files
            .filter(f => f.type === 'application/pdf')
            .map(f => ({
              name: f.name,
              path: `/uploads/${f.name}`,
              type: 'file' as const,
              description: 'Auto-added from file attachment',
              source: 'Uploaded PDF'
            }));
          return { ...layer, bibliography: [...nonFileBib, ...fileBib] };
        })
      };
    });
  };

  const addPdfToBibliography = (layerId: string, fileName: string, filePath: string) => {
    console.log('📚 [BIBLIOGRAPHY] Adding PDF to bibliography:', { layerId, fileName, filePath });

    const bibItem: BibliographyItem = {
      name: fileName,
      path: filePath,
      type: 'file',
      description: 'Auto-added from file attachment'
    };

    setAgent(prev => {
      if (!prev) return prev;

      const updatedLayers = prev.layers.map(layer => {
        if (layer.id === layerId) {
          const currentBibliography = layer.bibliography || [];

          const alreadyExists = currentBibliography.some(item =>
            item.name === fileName && item.path === filePath
          );

          if (!alreadyExists) {
            console.log('📝 [BIBLIOGRAPHY] Added to layer bibliography:', bibItem);

            return {
              ...layer,
              bibliography: [...currentBibliography, bibItem]
            };
          } else {
            console.log('⚠️ [BIBLIOGRAPHY] PDF already exists in bibliography, skipping');
          }
        }
        return layer;
      });

      return {
        ...prev,
        layers: updatedLayers
      };
    });

    console.log('📂 [BIBLIOGRAPHY] Auto-expanding Attach Data section to show bibliography');
    setInputsVisible(prev => ({ ...prev, [layerId]: true }));

    setBibliographyHighlight(prev => ({ ...prev, [layerId]: true }));

    setTimeout(() => {
      setBibliographyHighlight(prev => ({ ...prev, [layerId]: false }));
    }, 3000);
  };

  const processPdfFileWithWarning = async (file: File, layerId: string) => {
    const pageCount = await detectPdfPageCount(file);
    const fileSizeMB = file.size / (1024 * 1024);

    if (pageCount > 500 && pageCount <= 1000) {
      console.log(`📚 [PDF RAG ADVICE] Medium-large PDF detected: ${file.name} has ${pageCount} pages`);

      const useRagInstead = window.confirm(
        `📚 RAG RECOMMENDED FOR LARGE PDF\n\n` +
        `"${file.name}" contains ${pageCount.toLocaleString()} pages.\n\n` +
        `For documents over 500 pages, we recommend using RAG (Retrieval-Augmented Generation) instead of direct file attachment.\n\n` +
        `HOW TO USE RAG:\n` +
        `1. Cancel this upload\n` +
        `2. Go to "RAG Knowledge" section above\n` +
        `3. Click "+ Add RAG" to upload the PDF to the corpus\n` +
        `4. Select the indexed file from the dropdown\n\n` +
        `Click "OK" to proceed with DIRECT UPLOAD anyway\n` +
        `Click "Cancel" to stop and use RAG instead (recommended)`
      );

      if (!useRagInstead) {
        console.log(`📚 [PDF RAG ADVICE] User chose to cancel and use RAG for ${file.name}`);
        return;
      }

      console.log(`📄 [PDF RAG ADVICE] User chose direct upload for ${file.name} despite RAG recommendation`);
    }

    if (pageCount > 1000) {
      console.log(`⚠️ [PDF WARNING] Large PDF detected: ${file.name} has ${pageCount} pages`);

      alert(
        `⚠️ FILE TOO LARGE\n\n` +
        `"${file.name}" contains ${pageCount.toLocaleString()} pages.\n\n` +
        `PDFs with more than 1000 pages are currently not supported for direct attachment due to processing limits.\n\n` +
        `RECOMMENDATION: Consider splitting this PDF into smaller sections (<1000 pages each) or use RAG (Retrieval-Augmented Generation) instead.`
      );

      console.log(`❌ [PDF WARNING] User prevented from uploading ${file.name} due to >1000 pages`);
      return;
    }

    if (fileSizeMB > 30) {
      if (pageCount > 1000) {
        try {
          console.log(`🔍 [Agent] Checking for RAG duplicates for: ${file.name}`);
          const duplicateResponse = await fetch('/api/rag-knowledge/check-duplicate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileName: file.name })
          });

          if (duplicateResponse.ok) {
            const duplicateData = await duplicateResponse.json();

            if (duplicateData.exists) {
              const createdDate = new Date(duplicateData.createdTime).toLocaleDateString();
              const userConfirmed = window.confirm(
                `⚠️ RAG Knowledge Folder Already Exists\n\n` +
                `A processed knowledge folder for "${file.name}" already exists (created ${createdDate}).\n\n` +
                `This large document will trigger RAG processing. Do you want to:\n\n` +
                `✅ REPLACE the existing folder with fresh processing\n` +
                `❌ SKIP processing and use the existing folder\n\n` +
                `Click "OK" to REPLACE, or "Cancel" to SKIP and use existing data.`
              );

              if (userConfirmed) {
                console.log(`🔄 [Agent] User chose to REPLACE existing RAG folder for: ${file.name}`);
                setReplaceExistingFlag(file, true);
              } else {
                console.log(`📋 [Agent] User chose to SKIP processing for: ${file.name}`);
                setReplaceExistingFlag(file, false);
              }
            } else {
              console.log(`✅ [Agent] No existing RAG folder found for: ${file.name}`);
              setReplaceExistingFlag(file, false);
            }
          } else {
            console.warn(`⚠️ [Agent] Failed to check for duplicates: ${duplicateResponse.statusText}`);
            setReplaceExistingFlag(file, false);
          }
        } catch (duplicateError) {
          console.error('❌ [Agent] Error checking for RAG duplicates:', duplicateError);
          setReplaceExistingFlag(file, false);
        }
      }
      console.log(`📄 [PDF SPLIT] PDF is ${fileSizeMB.toFixed(1)}MB (>30MB limit), prompting user for splitting`);
      setPendingSplitPdf({ layerId, file: file, pageCount });
      setExpandedPdfOptions(layerId);
      setPdfRangeStart(1);
      setPdfRangeEnd(Math.min(950, pageCount));
      return;
    }

    const validUrls = [URL.createObjectURL(file)];
    const updatedPdfFiles = [...(fileStates[layerId]?.files || []), file];
    setFileStates(prev => ({
      ...prev,
      [layerId]: {
        files: updatedPdfFiles,
        fileUrls: [...(prev[layerId]?.fileUrls || []), ...validUrls]
      }
    }));
    setFilePageCounts(prev => ({
      ...prev,
      [layerId]: [...(prev[layerId] || []), pageCount]
    }));
    setStepInputTab(prev => ({ ...prev, [layerId]: 'upload' }));
    syncFileBibliography(layerId, updatedPdfFiles);
  };

  const [isSearching,] = useState(false);

  const {
    isAnyStepRunning,
    runningSteps,
    executionErrors,
    startExecution,
    completeExecution,
    failExecution,
    isStepRunning
  } = useGlobalStepExecution();

  const { appendRecord, getChain, chainLength, saveChain, listChains, loadChain } = useIntegrityChain();
  const [showIntegrityModal, setShowIntegrityModal] = useState(false);

  const [showRunAllProgress, setShowRunAllProgress] = useState(false);

  const runStepWithCache = async (stepId: string, stepResults?: Map<string, string>): Promise<string | undefined> => {
    const batchInputs = sharedBatchInputsRef.current;
    if (batchInputs?.cancelled) throw new DOMException('Batch cancelled', 'AbortError');
    const versionRun = runAllVersionRef.current;
    if (!versionRun || !runVersioning.isRunCurrent(versionRun)) throw new DOMException('Step cancelled', 'AbortError');
    const currentAgent = versionRun.snapshot as AgentData;

    const layer = currentAgent.layers.find(l => l.id === stepId);
    if (!layer || isStepRunning(stepId)) return;

    if (!layer.userInstruction?.trim()) {
      throw new Error('Please enter a user instruction for this step before running it.');
    }

    if (!startExecution(stepId)) {
      throw new Error('Another step is currently executing. Please wait for it to complete.');
    }

    const startedAt = new Date().toISOString();
    const model = isValidModel(layer.selectedModel) ? layer.selectedModel : DEFAULT_MODEL;
    const controller = new AbortController();
    runAbortRef.current = controller;
    if (layer.lastRunDiagnostics) updateEditorLayer(stepId, { lastRunDiagnostics: undefined });
    try {
      if (isGalileoModel(model)) await assertStepModelReady(model, controller.signal);
      const inputSelection = batchInputs?.metadata ?? currentAgent.metadata;
      const sharedInputs = hasAgentInputs(inputSelection)
        ? await (batchInputs ? (batchInputs.prepared ??= prepareAgentInputSnapshot(inputSelection, controller.signal)) : prepareAgentInputSnapshot(inputSelection, controller.signal))
        : null;
      const fileState = fileStates[stepId];
      const activeInputTab = stepInputTab[stepId] || 'text';
      const localInputs = getActiveStepInputs(activeInputTab, fileState?.files ?? [], stepCorpusIds[stepId], stepDocumentSelections[stepId], layer.ragKnowledge, projectFolder?.projectId);
      if (sharedInputs && localInputs.corpora.length && !(stepDocumentSelections[stepId]?.length) && stepCorpusDocuments[stepId]?.some(document => document.state !== 'FAILED')) {
        throw new Error('No documents selected in the step corpus. Select at least one document to run.');
      }

      const refContext = buildReferencedStepsContext(layer.referencedSteps, {
        getName: (refId) => currentAgent.layers.find(l => l.id === refId)?.name,
        getResult: (refId) => stepResults?.get(refId) });

      let currentStepContext = sharedInputs ? refContext.text : '';
      if (activeInputTab === 'text') {
        if (!sharedInputs) currentStepContext += refContext.text;
        if (layer.collection && layer.collection > 0) {
          const collectionContent = fetchCollectionContent(layer.collection);
          if (collectionContent && collectionContent !== 'Collection is empty') {
            currentStepContext += `Collection ${layer.collection} Content:\n${collectionContent}\n\n`;
          }
        }
      }

      if (preprocessingEnabled[stepId]) {
        setPreprocessingResults(prev => ({ ...prev, [stepId]: {} }));
        const hasFilesForPrep = (activeInputTab === 'upload' || activeInputTab === 'files') && (fileState?.files?.length ?? 0) > 0;

        if (hasFilesForPrep) {
          try {
            const preprocessingPrompt = createPreprocessingDataExtractionPrompt(layer);
            const preprocessingMessages = [{ role: 'user', text: preprocessingPrompt }];
            const preprocessingFormData = new FormData();
            fileState!.files.forEach((file, index) => {
              if (file && file.size > 0) preprocessingFormData.append(`file${index}`, file);
            });
            preprocessingFormData.append('messages', JSON.stringify(preprocessingMessages));
            preprocessingFormData.append('model', DEFAULT_MODEL);

            const preprocessingRes = await fetch('/api/gemini', {
              method: 'POST',
              body: preprocessingFormData, signal: controller.signal });
            if (preprocessingRes.ok) {
              const preprocessingData = await preprocessingRes.json();
              const extractedData = (preprocessingData.response as string)?.trim();
              if (extractedData && extractedData !== 'Extraction (by page): None') {
                setPreprocessingResults(prev => ({
                  ...prev,
                  [stepId]: { ...prev[stepId], document: extractedData } }));
                currentStepContext += `\n=== DOCUMENT STRUCTURED DATA ===\n${extractedData}\n\n`;
              }
            }
          } catch (error) {
            console.warn('[RunAll] Document preprocessing failed:', error);
          }
        }

        try {
          const promptSource = [
            layer.systemInstruction?.trim() && `System Instruction:\n${layer.systemInstruction.trim()}`,
            layer.userInstruction?.trim() && `User Instruction:\n${layer.userInstruction.trim()}`,
            layer.userInput?.trim() && `User Input:\n${layer.userInput.trim()}`,
          ].filter(Boolean).join('\n\n');

          if (promptSource) {
            const promptPreprocessRes = await fetch('/api/gemini', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                messages: [{ role: 'user', text: createPromptPreprocessingPrompt(promptSource) }],
                model: DEFAULT_MODEL }), signal: controller.signal });
            if (promptPreprocessRes.ok) {
              const promptPreprocessData = await promptPreprocessRes.json();
              const extractedData = (promptPreprocessData.response as string)?.trim();
              if (extractedData && extractedData !== 'Extraction: None') {
                setPreprocessingResults(prev => ({
                  ...prev,
                  [stepId]: { ...prev[stepId], prompt: extractedData } }));
                currentStepContext += `\n=== PROMPT STRUCTURED DATA ===\n${extractedData}\n\n`;
              }
            }
          }
        } catch (error) {
          console.warn('[RunAll] Prompt preprocessing extraction failed:', error);
        }
      }

      const agentSkillTexts = skillsLib.resolveTexts(agentRef.current?.metadata?.skillIds);
      const { messages, systemInstruction } = buildStepMessagesPayload(layer, currentStepContext, agentSkillTexts);
      const sharedBody = { model, messages, systemInstruction, projectId: projectFolder?.projectId,
        ragKnowledge: localInputs.ragKnowledge, ...getGalileoGenerationSettings(model, layer),
        includeThoughts: false, thinkingLevel: stepThinkingLevel[stepId] ?? 'low', optimizeQuery: Boolean(stepOptimizeQuery[stepId]) };

      if (isImageModel(layer.selectedModel)) {
        let base: InlineImage | null = null;
        const uploadedImage = fileState?.files?.find((f) => f && f.type.startsWith('image/'));
        if (uploadedImage) {
          base = await fileToBase64(uploadedImage);
        } else {
          for (const refId of layer.referencedSteps ?? []) {
            const ref = currentAgent.layers.find((l) => l.id === refId);
            const refImage = ref ? getLayerImageUrls(ref)[0] : undefined;
            if (refImage) {
              base = dataUrlToInlineData(refImage);
              if (base) break;
            }
          }
        }
        const { imageUrls, text } = await generateStepImages({
          prompt: sharedInputs ? await prepareAgentImagePrompt(sharedInputs, sharedBody, localInputs.files, localInputs.corpora, controller.signal) : buildStepImagePrompt(messages, systemInstruction),
          model: layer.selectedModel as string,
          base,
        });
        if (controller.signal.aborted || runAbortRef.current !== controller) throw new DOMException('Step cancelled', 'AbortError');
        const caption = text ?? '';
        updateEditorLayer(stepId, { result: caption, imageUrls });
        return caption;
      }

      const corpusIdForStep = stepCorpusIds[stepId];
      const useCorpus = activeInputTab === 'corpus' && Boolean(corpusIdForStep);
      const useUpload =
        (activeInputTab === 'upload' || activeInputTab === 'bibliography' || activeInputTab === 'files')
        && (fileState?.files?.length ?? 0) > 0;
      const useBibliography =
        activeInputTab === 'bibliography'
        && (layer.ragKnowledge?.length ?? 0) > 0;
      const useFilesOrPapers =
        (activeInputTab === 'files' || activeInputTab === 'papers')
        && (layer.ragKnowledge?.length ?? 0) > 0;

      let response;

      if (sharedInputs) {
        response = await fetchWithAgentInputs(sharedInputs, sharedBody, localInputs.files, localInputs.corpora, controller.signal);
      } else if (useCorpus) {
        const checkedDocs = stepDocumentSelections[stepId] || [];
        const allCorpusDocs = (stepCorpusDocuments[stepId] || []).filter(d => d.state !== 'FAILED');

        if (checkedDocs.length === 0 && allCorpusDocs.length > 0) {
          throw new Error('No documents selected in corpus. Select at least one document to run.');
        }

        // Resolve the subset filter on the stable file_id (falls back to pdf_name for
        // pre-file_id corpora). `block` = the selection matches nothing in this corpus
        // (fail fast, don't let the model loop for minutes on a dead filter).
        const subset = resolveSubsetFilter(checkedDocs, allCorpusDocs);
        if (subset.action === 'block') {
          throw new Error('Selected documents are not in this corpus (metadata mismatch). Re-select the documents, or open the RAG Knowledge Manager to Verify and self-heal this corpus.');
        }
        const metadataFilter = subset.filter;

        const ragSystemInstructionParts: string[] = [];
        if (layer.userInstruction?.trim()) ragSystemInstructionParts.push(layer.userInstruction.trim());
        if (layer.systemInstruction?.trim()) ragSystemInstructionParts.push(layer.systemInstruction.trim());
        if (refContext.text) ragSystemInstructionParts.push(refContext.text);
        const ragSystemInstruction = combineSkillsWithSystemInstruction(ragSystemInstructionParts.join('\n\n'), agentSkillTexts) || undefined;

        console.log(
          `📁 [Corpus][RunAll] step="${layer.name}" corpusId=${corpusIdForStep} ` +
          `filterAction=${subset.action} checkedDocs=${checkedDocs.length}/${allCorpusDocs.length} ` +
          `refSteps=${refContext.stepsIncluded} refBytes=${refContext.bytes} ` +
          `refTruncated=${refContext.truncated} filter=${metadataFilter ?? 'none'}`,
        );
        if (subset.filter) {
          console.log(`📁 [Corpus][RunAll] narrowed file list:`, checkedDocs);
        }

        // Send the selected corpus id first, then every other candidate the layer
        // could refer to — a stale primary id no longer 404s / hits an empty store.
        // For a cross-user corpus, also forward its exact Gemini store name (known from
        // the project link list) so the server resolves it without fuzzy name matching.
        const runStoreName = resolveStoreNameFromLinks(projectCorpusLinks, corpusIdForStep);
        const corpusIds = Array.from(new Set([
          corpusIdForStep,
          ...collectCorpusIdCandidatesFromLayer(layer),
          ...(runStoreName ? [runStoreName] : []),
        ].filter(Boolean)));
        response = await fetch(getStepEndpoint(model, true), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            corpusId: corpusIdForStep,
            corpusIds,
            // Corpus display-name hints + project id — let the server resolve a corpus
            // owned by another user (project-member gated) exactly as single Run Step does.
            corpusDisplayHints: collectLayerCorpusDisplayHints(layer),
            projectId: projectFolder?.projectId,
            messages,
            systemInstruction: ragSystemInstruction,
            model: isValidModel(layer.selectedModel) ? layer.selectedModel : DEFAULT_MODEL,
            metadataFilter,
            // Run All keeps thought traces off (fast batch) but respects each step's
            // chosen thinking depth.
            includeThoughts: false,
            ...getGalileoGenerationSettings(model, layer),
            thinkingLevel: stepThinkingLevel[stepId] ?? 'low',
            optimizeQuery: Boolean(stepOptimizeQuery[stepId]) }),
          credentials: 'include',
          signal: controller.signal });
      } else if (useUpload) {
        for (const file of fileState!.files) {
          if (file.type === 'application/pdf') {
            const fileSizeMB = file.size / (1024 * 1024);
            if (fileSizeMB > 30) {
              throw new Error(`PDF "${file.name}" is ${fileSizeMB.toFixed(1)}MB and exceeds the 30MB limit. Please split the file before processing.`);
            }
          }
        }

        const formData = new FormData();

        fileState!.files.forEach((file, index) => {
          if (file && file.size > 0) {
            formData.append(`file${index}`, file);
          }
        });

        const shouldReplaceExisting = fileState!.files.some(file => hasReplaceExistingFlag(file));
        if (shouldReplaceExisting) {
          console.log('🔄 [Agent] Including replaceExistingRAG flag for step execution');
          formData.append('replaceExistingRAG', 'true');
        }

        formData.append('messages', JSON.stringify(messages));
        formData.append('model', isValidModel(layer.selectedModel) ? layer.selectedModel : DEFAULT_MODEL);
        for (const [key, value] of Object.entries(getGalileoGenerationSettings(model, layer))) formData.append(key, JSON.stringify(value));

        if (systemInstruction) {
          formData.append('systemInstruction', JSON.stringify(systemInstruction));
        }

        if ((useBibliography || useFilesOrPapers) && layer.ragKnowledge?.length) {
          formData.append('ragKnowledge', JSON.stringify(layer.ragKnowledge));
          console.log(`🔍 [Agent] Adding ${layer.ragKnowledge.length} RAG knowledge items to FormData:`, layer.ragKnowledge.map(r => r.filename));
        }

        if (projectFolder?.projectId) {
          formData.append('projectId', projectFolder.projectId);
        }

        response = await fetch(getStepEndpoint(model), {
          method: 'POST',
          body: formData, signal: controller.signal });
      } else {
        const ragForRequest = (useBibliography || useFilesOrPapers) ? (layer.ragKnowledge ?? []) : [];

        const requestBody: GeminiRequestPayload = {
          messages,
          ...getGalileoGenerationSettings(model, layer),
          model: (isValidModel(layer.selectedModel) ? layer.selectedModel : DEFAULT_MODEL) as ModelValue,
          ragKnowledge: ragForRequest };

        if (systemInstruction) {
          requestBody.systemInstruction = systemInstruction;
        }

        if (ragForRequest.length > 0) {
          console.log(`✅ [Agent] Adding ${ragForRequest.length} RAG knowledge items to JSON request:`, ragForRequest.map(r => r.filename));
        }

        if (projectFolder?.projectId) {
          requestBody.projectId = projectFolder.projectId;
        }

        response = await fetch(getStepEndpoint(model), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody), signal: controller.signal });
      }

      const data = await readStepRunResponse(response, Boolean(useCorpus) && !isGalileoModel(model), model);
      if (controller.signal.aborted || runAbortRef.current !== controller) throw new DOMException('Step cancelled', 'AbortError');
      const rawResult = data.response?.trim();

      if (useCorpus) {
        const chunks = data.groundingChunks?.length ?? 0;
        if ((rawResult?.length ?? 0) > 0 && data.isGrounded) {
          console.log(`✅ [Step "${layer.name}"] RAG: ${rawResult!.length} chars | grounded | ${chunks} chunk(s)`);
        } else {
          console.warn(`⚠️ [Step "${layer.name}"] RAG returned empty/ungrounded response`);
          console.warn(`   isGrounded : ${data.isGrounded}`);
          console.warn(`   chunks     : ${chunks}`);
          console.warn(`   corpusId   : ${corpusIdForStep}`);
        }
      }

      const result = (useCorpus && !rawResult)
        ? `⚠️ **No relevant content found in the corpus for this query.**\n\n` +
          `**Diagnostics:**\n` +
          `- isGrounded: ${data.isGrounded ?? 'N/A'}\n` +
          `- Grounding chunks: ${data.groundingChunks?.length ?? 0}\n\n` +
          `*Possible causes: the file search store is still indexing, the query doesn't match ` +
          `any document content, or the selected document filter is too narrow.*`
        : filterAIResponseSections(rawResult ?? '');

      if (!result) {
        throw new Error('No response from AI model');
      }

      const debugInfo = buildStepDebugInfo(
        data,
        isValidModel(layer.selectedModel) ? layer.selectedModel : DEFAULT_MODEL,
      );
      updateEditorLayer(stepId, { result, debugInfo, ...(data.runDiagnostics ? { lastRunDiagnostics: data.runDiagnostics } : {}) });

      if (stepQcEnabled[stepId] && stepCorpusIds[stepId] && result.trim()) {
        runStepQc(stepId, result);
      }

      try {
        const stepIndex    = currentAgent.layers.findIndex(l => l.id === stepId);
        const selectedCorpusId   = stepCorpusIds[stepId] ?? null;
        const selectedDocs       = stepDocumentSelections[stepId] ?? [];
        const referencedOutputs  = layer.referencedSteps?.map(refId => ({
          stepId: refId,
          stepName: currentAgent.layers.find(l => l.id === refId)?.name ?? refId,
          output: stepResults?.get(refId) ?? null })) ?? [];
        const prevChainHash = getChain().at(-1)?.chain_hash ?? null;

        const record = await createIntegrityRecord({
          name: layer.name,
          previousChainHash: prevChainHash,
          components: [
            { type: 'user_input',         label: 'User Instruction',        value: layer.userInstruction ?? '' },
            { type: 'user_input',         label: 'User Input',              value: layer.userInput ?? '' },
            { type: 'system_instruction', label: 'System Instruction',      value: layer.systemInstruction ?? null },
            { type: 'context_dependency', label: 'Referenced Step Outputs', value: referencedOutputs },
            { type: 'context_dependency', label: 'Collection Content',      value: currentStepContext || null },
            { type: 'rag_config',         label: 'Corpus ID',               value: selectedCorpusId },
            { type: 'rag_config',         label: 'Selected Corpus Files',   value: selectedDocs },
            { type: 'model_config',       label: 'Model',                   value: layer.selectedModel ?? 'default' },
            { type: 'model_config',       label: 'Model Settings',          value: { temperature: layer.temperature ?? null, topP: layer.topP ?? null, maxTokens: layer.maxTokens ?? null } },
            { type: 'execution_metadata', label: 'Step Index',              value: stepIndex },
            { type: 'execution_metadata', label: 'User Email',              value: session?.user?.email ?? 'anonymous' },
            { type: 'execution_metadata', label: 'Timestamp',               value: new Date().toISOString() },
            { type: 'execution_metadata', label: 'Project ID',              value: projectFolder?.projectId ?? null },
            { type: 'output',             label: 'Step Output',             value: result },
          ] });
        appendRecord(record);
      } catch (integrityError) {
        console.warn('[Integrity] Record creation failed — step result is not affected:', integrityError);
      }

      return result;

    } catch (error) {
      if (runAbortRef.current !== controller) return;
      const diagnostics = getStepFailureDiagnostics(error, model, startedAt);
      if (diagnostics) updateEditorLayer(stepId, { lastRunDiagnostics: diagnostics });
      // User Stop / cancel aborts the in-flight query — propagate as-is so the
      // Run All manager stops cleanly instead of reporting a step failure.
      if (error instanceof Error && error.name === 'AbortError') throw error;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      failExecution(stepId, new Error(errorMessage));
      throw new Error(`Step execution failed: ${errorMessage}`);
    } finally {
      if (runAbortRef.current === controller) {
        runAbortRef.current = null;
        completeExecution(stepId);
      }
    }
  };

  const runAllManager = useRunAllStepsManager({
    runStep: runStepWithCache,
    onProgress: (progress: RunAllProgress) => {
      console.log(`Progress: ${progress.current}/${progress.total} - ${progress.currentStepName}`);
    },
    onComplete: (results) => {
      setShowRunAllProgress(false);
      console.log('Run All Steps completed:', results);
    },
    onError: (error) => {
      // Swallow user-initiated cancellation (Stop aborts the in-flight query).
      if (/abort/i.test(String(error))) {
        setShowRunAllProgress(false);
        return;
      }
      alert(`Run All Steps Error: ${error}`);
      setShowRunAllProgress(false);
    } });

  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const tooltipAutoCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [editingStep, setEditingStep] = useState<string | null>(null);
  const [stepSearch, setStepSearch] = useState('');
  const [stepFilterTags, setStepFilterTags] = useState<string[]>([]);
  const [stepTagMenuOpen, setStepTagMenuOpen] = useState(false);
  const stepTagMenuRef = useRef<HTMLDivElement | null>(null);

  const distinctStepTags = useMemo(() => {
    const tags = new Set<string>();
    for (const layer of agent?.layers ?? []) {
      if (layer.tag) tags.add(layer.tag);
    }
    return Array.from(tags).sort((a, b) => a.localeCompare(b));
  }, [agent?.layers]);

  const hasUntaggedSteps = useMemo(
    () => (agent?.layers ?? []).some(layer => !layer.tag),
    [agent?.layers],
  );

  const stepFilterActive = stepSearch.trim() !== '' || stepFilterTags.length > 0;

  const stepMatchesFilter = useCallback((layer: Layer) => {
    const query = stepSearch.trim().toLowerCase();
    const matchesSearch = query === '' || layer.name.toLowerCase().includes(query);
    const matchesTags = stepFilterTags.length === 0
      || (layer.tag
        ? stepFilterTags.includes(layer.tag)
        : stepFilterTags.includes(STEP_FILTER_UNTAGGED));
    return matchesSearch && matchesTags;
  }, [stepSearch, stepFilterTags]);

  useEffect(() => {
    if (!stepTagMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (stepTagMenuRef.current && !stepTagMenuRef.current.contains(event.target as Node)) {
        setStepTagMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [stepTagMenuOpen]);
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState<string>('');
  const [showTagPicker, setShowTagPicker] = useState<string | null>(null);
  const [enhancingPrompts, setEnhancingPrompts] = useState<Record<string, boolean>>({});
  const [enhancingUserInputs] = useState<Record<string, boolean>>({});
  const [analyzingSteps, setAnalyzingSteps] = useState<Record<string, boolean>>({});
  const [currentAnalysisStep, setCurrentAnalysisStep] = useState<Record<string, string>>({});
  const [preprocessingEnabled, setPreprocessingEnabled] = useState<Record<string, boolean>>({});
  const [preprocessingResults, setPreprocessingResults] = useState<Record<string, { document?: string; prompt?: string }>>({});
  const [preprocessingVisible, setPreprocessingVisible] = useState<Record<string, boolean>>({});
  const [introspectionResults, setIntrospectionResults] = useState<Record<string, { first: string; second?: string; extraction?: string; reinterpretation?: string; reexecution?: string }>>({});
  const [introspectionVisible, setIntrospectionVisible] = useState<Record<string, boolean>>({});
  const [resultsVisible, setResultsVisible] = useState<Record<string, boolean>>({});
  const [debugPanelLayerId, setDebugPanelLayerId] = useState<string | null>(null);
  const [quickTooltip, setQuickTooltip] = useState<{ content: string; x: number; y: number } | null>(null);
  const quickTooltipTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quickTooltipAutoCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showQuickTooltip = useCallback((content: string, e: React.MouseEvent) => {
    if (quickTooltipTimeoutRef.current) clearTimeout(quickTooltipTimeoutRef.current);
    if (quickTooltipAutoCloseRef.current) clearTimeout(quickTooltipAutoCloseRef.current);
    quickTooltipTimeoutRef.current = setTimeout(() => {
      setQuickTooltip({ content, x: e.clientX, y: e.clientY });
      quickTooltipTimeoutRef.current = null;
      // Safety net: auto-dismiss if the pointer never triggers onMouseLeave.
      quickTooltipAutoCloseRef.current = setTimeout(() => {
        setQuickTooltip(null);
        quickTooltipAutoCloseRef.current = null;
      }, TOOLTIP_AUTO_CLOSE_MS);
    }, 180);
  }, []);

  const hideQuickTooltip = useCallback(() => {
    if (quickTooltipTimeoutRef.current) {
      clearTimeout(quickTooltipTimeoutRef.current);
      quickTooltipTimeoutRef.current = null;
    }
    if (quickTooltipAutoCloseRef.current) {
      clearTimeout(quickTooltipAutoCloseRef.current);
      quickTooltipAutoCloseRef.current = null;
    }
    setQuickTooltip(null);
  }, []);

  const moveQuickTooltip = useCallback((e: React.MouseEvent) => {
    setQuickTooltip(prev => prev ? { ...prev, x: e.clientX, y: e.clientY } : null);
  }, []);

  const quickTooltipEnter = useCallback((e: React.MouseEvent) => {
    const el = e.currentTarget;
    const content = el.getAttribute('title') ?? '';
    el.setAttribute('data-title-backup', content);
    el.setAttribute('title', '');
    showQuickTooltip(content, e);
  }, [showQuickTooltip]);

  const quickTooltipLeave = useCallback((e: React.MouseEvent) => {
    const el = e.currentTarget;
    const backup = el.getAttribute('data-title-backup') ?? '';
    el.setAttribute('title', backup);
    el.removeAttribute('data-title-backup');
    hideQuickTooltip();
  }, [hideQuickTooltip]);

  const [personaModalOpen, setPersonaModalOpen] = useState(false);
  const [personaModalConfig, setPersonaModalConfig] = useState<{
    layerId: string;
    type: 'userInstruction' | 'userInput';
    content: string;
  } | null>(null);

  const [versionedAgentData, setVersionedAgentData] = useState<VersionedAgentData | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string>('');
  const selectedVersionRef = useRef(selectedVersion);
  selectedVersionRef.current = selectedVersion;
  const versionedAgentDataRef = useRef(versionedAgentData);
  versionedAgentDataRef.current = versionedAgentData;
  const autosaveScopeKey = JSON.stringify([projectFolder?.projectId, agentId, selectedVersion, versionedAgentData?.currentVersion]);
  const autosaveScopeRef = useRef({ key: autosaveScopeKey });
  if (autosaveScopeRef.current.key !== autosaveScopeKey) autosaveScopeRef.current = { key: autosaveScopeKey };
  const savingRef = useRef(isSaving);
  savingRef.current = isSaving;
  const versionBaselineRef = useRef<AgentSnapshot | null>(null);
  const versionInputBaselineRef = useRef('');
  const versionLoadRef = useRef(0);
  const localInputSignature = (layers: Layer[], tabs: Record<string, string>) => JSON.stringify(layers.map(layer => ({
    id: layer.id,
    mode: tabs[layer.id] || 'text',
    files: (fileStates[layer.id]?.files ?? []).map(file => ({
      name: file.name, size: file.size, type: file.type, lastModified: file.lastModified,
    })),
    preprocessing: Boolean(preprocessingEnabled[layer.id]),
    includeThoughts: Boolean(stepIncludeThoughts[layer.id]),
    thinkingLevel: stepThinkingLevel[layer.id] ?? 'low',
    optimizeQuery: Boolean(stepOptimizeQuery[layer.id]),
  })));
  const captureVersionBaseline = (
    loaded: AgentData,
    corpusIds: Record<string, string>,
    selections: Record<string, string[]>,
    tabs: Record<string, string>,
  ) => {
    versionBaselineRef.current = JSON.parse(JSON.stringify({
      ...loaded,
      name: stripDateSuffixFromAgentName(loaded.name),
      layers: loaded.layers.map(layer => ({
        ...layer,
        corpusId: corpusIds[layer.id] ?? layer.corpusId,
        documentSelections: selections[layer.id] ?? layer.documentSelections,
      })),
    }));
    versionInputBaselineRef.current = localInputSignature(loaded.layers, { ...stepInputTab, ...tabs });
  };

  const [showVersionDropdown, setShowVersionDropdown] = useState(false);
  const [isImageUploading, setIsImageUploading] = useState(false);
  const [viewCollectionContent, setViewCollectionContent] = useState<string | null>(null);

  const [isPageVisible, setIsPageVisible] = useState(true);
  const [pendingReload, setPendingReload] = useState(false);

  const [notesPanelOpen, setNotesPanelOpen] = useState(false);
  const [currentNote, setCurrentNote] = useState('');
  const [isSavingNote, setIsSavingNote] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageContainerRef = useRef<HTMLDivElement>(null);

  const [showMissingFoldersModal, setShowMissingFoldersModal] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [missingFolders, setMissingFolders] = useState<string[]>([]);

  const [personaInstructionPopupVisible, setPersonaInstructionPopupVisible] = useState<Record<string, boolean>>({});

  const [promptActionsPopup, setPromptActionsPopup] = useState<{
    visible: boolean;
    layerId: string | null;
    position: { top: number; left: number };
  }>({ visible: false, layerId: null, position: { top: 0, left: 0 } });

  const [modal, setModal] = useState<{
    isOpen: boolean;
    type: 'success' | 'error' | 'warning' | 'info';
    title: string;
    message: string;
    onConfirm?: () => void;
    autoClose?: boolean;
    autoCloseDelay?: number;
  }>({
    isOpen: false,
    type: 'info',
    title: '',
    message: '',
    autoClose: false,
    autoCloseDelay: 3000
  });

  const [expandedPdfOptions, setExpandedPdfOptions] = useState<string | null>(null);
  const [pendingSplitPdf, setPendingSplitPdf] = useState<{ layerId: string; file: File; pageCount: number } | null>(null);
  const [splittingInProgress, setSplittingInProgress] = useState(false);
  const [splittingProgress, setSplittingProgress] = useState<string>('');
  const [pdfRangeStart, setPdfRangeStart] = useState<number>(1);
  const [pdfRangeEnd, setPdfRangeEnd] = useState<number>(100);

  const [enhancementModal, setEnhancementModal] = useState<{
    isVisible: boolean;
    type: 'userInstruction' | 'userInput';
  }>({
    isVisible: false,
    type: 'userInstruction'
  });

  const showModal = (
    type: 'success' | 'error' | 'warning' | 'info',
    title: string,
    message: string,
    onConfirm?: () => void,
    autoClose: boolean = false,
    autoCloseDelay: number = 2000
  ) => {
    setModal({
      isOpen: true,
      type,
      title,
      message,
      onConfirm,
      autoClose,
      autoCloseDelay
    });
  };

  const hideModal = () => {
    setModal(prev => ({ ...prev, isOpen: false }));
  };

  const splitPdfIntoChunks = async (file: File, chunkSize: number = 200): Promise<File[]> => {
    try {
      const pdfLibModule = await import('pdf-lib');
      const { PDFDocument } = pdfLibModule;

      const arrayBuffer = await file.arrayBuffer();
      const sourcePdf = await PDFDocument.load(arrayBuffer);
      const totalPages = sourcePdf.getPageCount();

      const chunks: File[] = [];
      const baseName = file.name.replace(/\.pdf$/i, '');

      for (let startPage = 0; startPage < totalPages; startPage += chunkSize) {
        const endPage = Math.min(startPage + chunkSize - 1, totalPages - 1);
        const chunkPdf = await PDFDocument.create();

        const pageIndices = Array.from({ length: endPage - startPage + 1 }, (_, i) => startPage + i);
        const copiedPages = await chunkPdf.copyPages(sourcePdf, pageIndices);
        copiedPages.forEach(page => chunkPdf.addPage(page));

        const chunkBytes = await chunkPdf.save();
        const chunkNumber = Math.floor(startPage / chunkSize) + 1;
        const chunkName = `${baseName}_part${chunkNumber.toString().padStart(2, '0')}.pdf`;
        const chunkFile = new File([chunkBytes], chunkName, { type: 'application/pdf' });

        chunks.push(chunkFile);
      }

      return chunks;
    } catch (error) {
      console.error('Error splitting PDF:', error);
      throw new Error(`Failed to split PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  useEffect(() => {
    const handleVisibilityChange = () => {
      const isVisible = document.visibilityState === 'visible';
      setIsPageVisible(isVisible);

      if (isVisible) {
        console.log('👁️ Edit page visible - all operations continue normally');
        if (pendingReload) {
          console.log('⏰ Executing delayed agent reload...');
          setPendingReload(false);
          loadAgentFromStorage();
        }
      } else {
        console.log('🙈 Edit page hidden - operations continue in background');

      }
    };

    if (typeof document !== 'undefined') {
      setIsPageVisible(document.visibilityState === 'visible');
      document.addEventListener('visibilitychange', handleVisibilityChange);

      return () => {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      };
    }
  }, [pendingReload]);

  const loadAgentFromStorage = async ({ silent = false }: { silent?: boolean } = {}) => {
    const loadSequence = ++versionLoadRef.current;
    autosaveScopeRef.current = { ...autosaveScopeRef.current };
    runVersioningRef.current?.invalidate();
    if (!agentId || !projectFolder?.projectId || !session?.accessToken) {
      const missingItems = [];
      if (!agentId) missingItems.push('Agent ID');
      if (!projectFolder?.projectId) missingItems.push('Project');
      if (!session?.accessToken) missingItems.push('Authentication');

      setError(`Missing required data: ${missingItems.join(', ')}. Please go back to the dashboard and try again.`);
      setIsLoading(false);
      signalPageReady();
      endNavigation();
      return;
    }

    if (!isPageVisible) {

      setPendingReload(true);
      setIsLoading(false);
      return;
    }

    if (!silent) {
      signalPageNotReady();
      setIsLoading(true);
    }
    setError(null);
    try {
      const timestamp = Date.now();
      const url = `/api/projects/${projectFolder.projectId}/folders/AF/files/${agentId}?t=${timestamp}&nocache=${Math.random()}`;
      const response = await fetch(url, {
        cache: 'no-cache',
        headers: {
          'Authorization': `Bearer ${session.accessToken}`,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      });

      if (!response.ok) {
        const responseText = await response.text();
        throw new Error(`Failed to load agent: ${response.status} ${response.statusText} - ${responseText}`);
      }

      const responseData = await response.json();

      let agentData;
      if (typeof responseData.content === 'string') {
        try {
          agentData = JSON.parse(responseData.content);
        } catch {
          throw new Error('Invalid JSON in agent file');
        }
      } else {
        agentData = responseData;
      }

      const { isVersionedAgent, getCurrentVersionLayers, getAgentVersionMetadata } = await import('../../../lib/versionUtils');
      if (versionLoadRef.current !== loadSequence) return;

      let agentToLoad;

      if (isVersionedAgent(agentData)) {
        versionedAgentDataRef.current = agentData;
        selectedVersionRef.current = agentData.currentVersion;
        setVersionedAgentData(agentData);
        setSelectedVersion(agentData.currentVersion);

        const currentLayers = getCurrentVersionLayers(agentData);
        const currentVersion = agentData.versions.find(version => version.version === agentData.currentVersion);
        agentToLoad = {
          name: agentData.agentName,
          layers: currentLayers,
          metadata: {
            ...getAgentVersionMetadata(agentData),
            modified: currentVersion?.timestamp ?? agentData.metadata?.lastModified,
            currentVersion: agentData.currentVersion,
            totalVersions: agentData.totalVersions
          }
        };

      } else {
        agentToLoad = agentData;
        versionedAgentDataRef.current = null;
        selectedVersionRef.current = '';
        setVersionedAgentData(null);
        setSelectedVersion('');

      }

      const { agent: migratedAgent, wasHealed } = migrateAgent(agentToLoad);
      if (migratedAgent.layers) {
        migratedAgent.layers = migratedAgent.layers.map(layer => ({
          ...layer,
          collection: layer.collection || undefined
        }));
      }
      setAgent(migratedAgent);
      setAgentName(stripDateSuffixFromAgentName(migratedAgent.name));

      if (wasHealed && projectFolder?.projectId && agentId) {
        try {
          const { updateAgentSameVersionByFileId } = await import('../../../lib/versionUtils');
          const agentToSave = { ...migratedAgent, name: stripDateSuffixFromAgentName(migratedAgent.name) };
          await updateAgentSameVersionByFileId(projectFolder.projectId, agentId, agentToSave, {
            expectedCurrentVersion: isVersionedAgent(agentData) ? agentData.currentVersion : undefined,
            shouldSave: () => versionLoadRef.current === loadSequence,
          });
        } catch (saveErr) {
          console.warn('[Auto-heal] Could not persist healed agent:', saveErr);
        }
      }

      const corpusIds: Record<string, string> = {};
      const docSelections: Record<string, string[]> = {};
      const inputTabs: Record<string, 'text' | 'upload' | 'bibliography' | 'files' | 'papers' | 'corpus'> = {};
      for (const layer of migratedAgent.layers) {
        const resolvedCorpusId = resolveLayerCorpusIdShared(layer) || undefined;
        if (resolvedCorpusId) {
          corpusIds[layer.id] = resolvedCorpusId;
          const raw = layer.documentSelections ?? [];
          const hasBib = layer.bibliography && layer.bibliography.length > 0;
          if (hasBib && layer.bibliography) {
            const bibNames = new Set<string>();
            for (const b of layer.bibliography) {
              const fromPath = b.path?.split(/[/\\]/).pop()?.trim();
              const fromName = b.name?.trim();
              if (fromPath) bibNames.add(fromPath);
              if (fromName) bibNames.add(fromName);
            }
            const isInBib = (n: string) =>
              Array.from(bibNames).some(bn => n === bn || n.endsWith(bn) || n.includes(bn));
            docSelections[layer.id] = raw.filter(n => isInBib(n));
          } else {
            docSelections[layer.id] = raw;
          }
          inputTabs[layer.id] = 'corpus';
        }
      }
      if (versionLoadRef.current !== loadSequence) return;
      captureVersionBaseline(migratedAgent, corpusIds, docSelections, inputTabs);
      setStepCorpusIds(corpusIds);
      setStepDocumentSelections(docSelections);
      setStepInputTab(prev => ({ ...prev, ...inputTabs }));

      const corpusDocsCache = new Map<string, Promise<StepCorpusDoc[]>>();
      const fetchCorpusDocuments = (cid: string) => {
        const cached = corpusDocsCache.get(cid);
        if (cached) return cached;
        const pidQuery = projectFolder?.projectId ? `?projectId=${encodeURIComponent(projectFolder.projectId)}` : '';
        const pending = fetch(`/api/rag/corpora/${encodeURIComponent(cid)}/documents${pidQuery}`, { credentials: 'include' })
          .then(r => (r.ok ? r.json() : null))
          .then(data => (data?.documents || []) as StepCorpusDoc[]);
        corpusDocsCache.set(cid, pending);
        return pending;
      };
      for (const layer of migratedAgent.layers) {
        const resolvedCorpusId = resolveLayerCorpusIdShared(layer) || undefined;
        if (resolvedCorpusId) {
          setStepCorpusDocumentsLoading(prev => ({ ...prev, [layer.id]: true }));
          fetchCorpusDocuments(resolvedCorpusId)
            .then(docs => {
              if (versionLoadRef.current !== loadSequence) return;
              setStepCorpusDocuments(prev => ({ ...prev, [layer.id]: docs }));
              const hasBib = layer.bibliography && layer.bibliography.length > 0;
              const bibNames = new Set<string>();
              if (hasBib && layer.bibliography) {
                for (const b of layer.bibliography) {
                  const fromPath = b.path?.split(/[/\\]/).pop()?.trim();
                  const fromName = b.name?.trim();
                  if (fromPath) bibNames.add(fromPath);
                  if (fromName) bibNames.add(fromName);
                }
              }
              const isInBib = (pdfName: string) =>
                Array.from(bibNames).some(bn => pdfName === bn || pdfName.endsWith(bn) || pdfName.includes(bn));
              const serverSelections = Array.isArray(layer.documentSelections)
                ? layer.documentSelections.filter((n): n is string => typeof n === 'string' && n.length > 0)
                : [];
              let initialSelection: string[];
              if (serverSelections.length > 0) {
                const resolution = resolveCorpusPdfNames(serverSelections, docs);
                if (resolution.unmatched.length > 0) {
                  console.warn(
                    `⚠️ [Corpus] step "${layer.name}": ${resolution.unmatched.length} persisted doc selection(s) did not match any live corpus pdf_name after normalisation; sending them verbatim.`,
                    { unmatched: resolution.unmatched, liveDocCount: docs.length },
                  );
                }
                initialSelection = resolution.resolved;
              } else {
                initialSelection = hasBib
                  ? docs.filter((d: { pdfName: string }) => isInBib(d.pdfName)).map((d: { pdfName: string }) => d.pdfName)
                  : docs.map((d: { pdfName: string }) => d.pdfName);
              }
              const baselineLayer = versionBaselineRef.current?.layers.find(candidate => candidate.id === layer.id);
              if (baselineLayer) baselineLayer.documentSelections = [...initialSelection];
              setStepDocumentSelections(prev => ({ ...prev, [layer.id]: initialSelection }));
            })
            .catch(() => { setStepCorpusDocuments(prev => ({ ...prev, [layer.id]: [] })); })
            .finally(() => { setStepCorpusDocumentsLoading(prev => ({ ...prev, [layer.id]: false })); });
        }
      }

      if (agentId && migratedAgent.name) {
        addRecentAgent(agentId, migratedAgent.name, projectFolder?.projectId);
      }

      if (agentId && projectFolder?.projectId) {
        recordAgentOpened(agentId, projectFolder.projectId);
      }
      
      if (!silent) {
        signalPageReady();
        endNavigation();
      }
    } catch (error) {
      setError(`Failed to load agent: ${error instanceof Error ? error.message : String(error)}`);
      if (!silent) {
        signalPageReady();
        endNavigation();
      }
    } finally {
      if (!silent) setIsLoading(false);
    }
  };

  useEffect(() => {
    signalPageNotReady();
  }, [signalPageNotReady]);

  useEffect(() => {
    const prevToken = lastLoadedTokenRef.current;
    const currentToken = session?.accessToken;
    lastLoadedTokenRef.current = currentToken;

    if (prevToken && currentToken && prevToken !== currentToken) {
      return;
    }

    loadAgentFromStorage();
  }, [agentId, projectFolder?.projectId, session?.accessToken]);

  useEffect(() => {
    if (!session?.accessToken) return;
    fetch('/api/rag/corpora', { credentials: 'include' })
      .then(r => {
        if (!r.ok) throw new Error(`GET /api/rag/corpora failed: ${r.status}`);
        return r.json();
      })
      .then(data => {
        if (!data) return;
        const rawCorpora: Array<{ id: string; corpusId?: string; displayName: string; files?: Array<{ name: string; status: string }> }> =
          data.corpora || [];
        setAvailableCorpora(rawCorpora.map((c) => ({
          id: c.id,
          corpusId: c.corpusId,
          displayName: c.displayName,
          files: c.files || [] })));
      })
      .catch((error) => { console.error('[Corpus] Failed to load available corpora:', error); });
  }, [session?.accessToken]);

  // Load the project's corpus links. Uses SCAN (not plain list) so that simply opening a
  // project backfills the shared project file from *this* user's registry — an owner
  // opening their project fills in names + store paths only they can resolve, for everyone.
  const reloadProjectCorpusLinks = useCallback(() => {
    const pid = projectFolder?.projectId;
    if (!pid) return;
    v1ScanProjectCorpusLinks(pid)
      .then(setProjectCorpusLinks)
      .catch((error) => { console.error('[Corpus] Failed to load project corpus links:', error); });
  }, [projectFolder?.projectId]);

  useEffect(() => { reloadProjectCorpusLinks(); }, [reloadProjectCorpusLinks]);

  const currentUserEmail = session?.user?.email ?? '';

  // Build the picker item list for a step: registry corpora the user can see, plus
  // any project-linked corpus that isn't in their own registry (cross-user). Own
  // corpuses sort first; project-linked get a gold border; others show creator + color.
  const buildCorpusPickerItems = useCallback(
    (attachedId: string, attachedDisplayName?: string, attachedOwnerEmail?: string): CorpusPickerItem[] => {
      const linkByCorpusId = new Map(projectCorpusLinks.map((l) => [l.corpusId, l]));
      const items: CorpusPickerItem[] = availableCorpora.map((c) => {
        const link = linkByCorpusId.get(c.id) || (c.corpusId ? linkByCorpusId.get(c.corpusId) : undefined);
        const ownerEmail = link?.ownerEmail || currentUserEmail;
        return {
          id: c.id,
          label: c.displayName || c.id,
          ownerEmail,
          isOwn: !link || (ownerEmail || '').toLowerCase() === currentUserEmail.toLowerCase(),
          isProjectLinked: Boolean(link),
        };
      });
      const known = new Set(items.map((i) => i.id));
      // Cross-user project-linked corpora not in the current user's registry.
      for (const link of projectCorpusLinks) {
        if (known.has(link.corpusId)) continue;
        items.push({
          id: link.corpusId,
          label: link.displayName || link.corpusId,
          ownerEmail: link.ownerEmail,
          isOwn: (link.ownerEmail || '').toLowerCase() === currentUserEmail.toLowerCase(),
          isProjectLinked: true,
        });
        known.add(link.corpusId);
      }
      // The corpus already attached to this step but visible in neither list.
      if (attachedId && !known.has(attachedId)) {
        items.push({
          id: attachedId,
          label: attachedDisplayName || attachedId,
          ownerEmail: attachedOwnerEmail,
          isOwn: !attachedOwnerEmail || attachedOwnerEmail.toLowerCase() === currentUserEmail.toLowerCase(),
          isProjectLinked: false,
        });
      }
      return items;
    },
    [availableCorpora, projectCorpusLinks, currentUserEmail],
  );

  const resolveCorpusDisplayName = useCallback(
    (corpusId: string): string => {
      const inRegistry = availableCorpora.find((c) => c.id === corpusId || c.corpusId === corpusId);
      if (inRegistry?.displayName) return inRegistry.displayName;
      const link = projectCorpusLinks.find((l) => l.corpusId === corpusId);
      if (link?.displayName) return link.displayName;
      return corpusId;
    },
    [availableCorpora, projectCorpusLinks],
  );

  // Single source of truth: write the corpus binding onto the layer itself (so it
  // survives autosave/round-trips), keep the sidecar map in sync, and add the
  // corpus to the project link list. A corpus, PDF attachments, and a bibliography
  // may all coexist on a step; runtime picks the active tab's source.
  const attachCorpusToStep = useCallback(
    (layerId: string, corpusId: string) => {
      const displayName = resolveCorpusDisplayName(corpusId);
      setAgent(prev => prev ? {
        ...prev,
        layers: prev.layers.map((l) =>
          l.id === layerId
            ? {
                ...l,
                corpusId: corpusId || undefined,
                corpusDisplayName: corpusId ? displayName : undefined,
                corpusOwnerEmail: corpusId ? (l.corpusOwnerEmail || currentUserEmail || undefined) : undefined,
              }
            : l,
        ),
      } : prev);
      setStepCorpusIds(prev => ({ ...prev, [layerId]: corpusId }));
      const stepLabel = agentRef.current?.layers.find(l => l.id === layerId)?.name ?? layerId;
      logActivity(corpusId ? 'link_corpus' : 'unlink_corpus', stepLabel, {
        targetId: layerId,
        detail: corpusId ? displayName : '',
      });
      if (!corpusId) {
        setStepDocumentSelections(prev => ({ ...prev, [layerId]: [] }));
        setStepCorpusDocuments(prev => ({ ...prev, [layerId]: [] }));
        return;
      }
      const pid = projectFolder?.projectId;
      if (pid) {
        const storeName = availableCorpora.find((c) => c.id === corpusId || c.corpusId === corpusId)?.corpusId;
        v1AddProjectCorpusLink(pid, { corpusId, storeName, displayName, ownerEmail: currentUserEmail })
          .then(setProjectCorpusLinks)
          .catch((error) => { console.error('[Corpus] Failed to add project corpus link:', error); });
      }
    },
    [resolveCorpusDisplayName, setAgent, projectFolder?.projectId, currentUserEmail, availableCorpora, agentRef, logActivity],
  );

  // No-drop merge for save/autosave: only write corpusId:undefined when the step
  // was explicitly detached (key present + empty); otherwise fall back to the
  // layer's own binding so a corpus that never entered the sidecar map is kept.
  const mergeLayerCorpusForSave = useCallback(
    (layer: Layer): Layer => {
      const hasCorpusEntry = Object.prototype.hasOwnProperty.call(stepCorpusIds, layer.id);
      const corpusId = hasCorpusEntry
        ? (stepCorpusIds[layer.id] || undefined)
        : (layer.corpusId || undefined);
      const hasDocEntry = Object.prototype.hasOwnProperty.call(stepDocumentSelections, layer.id);
      const documentSelections = hasDocEntry
        ? (stepDocumentSelections[layer.id] ?? [])
        : (layer.documentSelections ?? []);
      return {
        ...layer,
        corpusId,
        corpusDisplayName: corpusId ? (layer.corpusDisplayName || resolveCorpusDisplayName(corpusId)) : undefined,
        documentSelections,
      };
    },
    [stepCorpusIds, stepDocumentSelections, resolveCorpusDisplayName],
  );

  const runVersioning = useAgentRunVersioning({
    scope: JSON.stringify([projectFolder?.projectId, agentId, selectedVersion, session?.user?.email]),
    selectedVersion,
    latestVersion: versionedAgentData?.currentVersion,
    getDraft: () => {
      const current = agentRef.current;
      return current ? { ...current, name: agentName, layers: current.layers.map(mergeLayerCorpusForSave) } : null;
    },
    getBaseline: () => versionBaselineRef.current,
    hasInputEdits: () => localInputSignature(agentRef.current?.layers ?? [], stepInputTab) !== versionInputBaselineRef.current,
    saveVersion: async (snapshot, shouldSave) => {
      if (!projectFolder?.projectId || !agentId) return { success: false, error: 'Select a saved agent and project first.' };
      savingRef.current = true;
      try {
        return await saveAgentWithVersioning(projectFolder.projectId, snapshot.name, snapshot, agentId, { shouldSave });
      } finally {
        savingRef.current = false;
      }
    },
    onVersionSaved: (saved, snapshot) => {
      versionedAgentDataRef.current = saved;
      selectedVersionRef.current = saved.currentVersion;
      autosaveScopeRef.current = { ...autosaveScopeRef.current };
      versionBaselineRef.current = JSON.parse(JSON.stringify(snapshot));
      setVersionedAgentData(saved);
      setSelectedVersion(saved.currentVersion);
      setLastSaveTimestamp(new Date().toISOString());
      setLastAutosaveTime(Date.now());
    },
    onError: error => showModal('error', 'Version Save Failed', error.message),
  });
  runVersioningRef.current = runVersioning;
  savingRef.current = isSaving || runVersioning.isSaving;

  useEffect(() => () => {
    runVersioning.invalidate();
    runAbortRef.current?.abort();
    if (sharedBatchInputsRef.current) sharedBatchInputsRef.current.cancelled = true;
  }, [agentId, projectFolder?.projectId, selectedVersion, runVersioning.invalidate]);

  useEffect(() => {
    if (availableCorpora.length === 0) return;
    const stored = Object.entries(stepCorpusIds).filter(([, v]) => Boolean(v));
    if (stored.length === 0) {
      console.log('[CorpusNormalize] no stepCorpusIds yet to normalize',
        { availableCorpora: availableCorpora.length });
      return;
    }
    const altById = new Map<string, string>();
    for (const c of availableCorpora) {
      if (c.corpusId) altById.set(c.corpusId, c.id);
    }
    const summary = stored.map(([layerId, storedId]) => {
      if (availableCorpora.some(c => c.id === storedId)) {
        return { layerId, storedId, status: 'canonical' as const };
      }
      const canonical = altById.get(storedId);
      if (canonical) {
        return { layerId, storedId, canonical, status: 'remapped' as const };
      }
      return { layerId, storedId, status: 'unmatched' as const };
    });
    console.log('[CorpusNormalize]', {
      availableCorporaCount: availableCorpora.length,
      summary });
    const anyRemap = summary.some(s => s.status === 'remapped');
    if (!anyRemap) return;
    setStepCorpusIds(prev => {
      let changed = false;
      const next = { ...prev };
      for (const s of summary) {
        if (s.status === 'remapped' && next[s.layerId] === s.storedId) {
          next[s.layerId] = s.canonical;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [availableCorpora, stepCorpusIds]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.version-selector')) {
        setShowVersionDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  useEffect(() => {
    const isAnyEnhancing = Object.values(enhancingPrompts).some(isEnhancing => isEnhancing);
    setEnhancementModal({
      isVisible: isAnyEnhancing,
      type: 'userInstruction'
    });
  }, [enhancingPrompts]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const autosaveInterval = setInterval(() => {
      handleAutosaveRef.current();
    }, 10000);

    return () => clearInterval(autosaveInterval);
  }, []);

  const formatRelativeTime = (timestamp: string): string => {
    const now = new Date();
    const saveTime = new Date(timestamp);
    const diffMs = now.getTime() - saveTime.getTime();
    const diffMinutes = Math.floor(diffMs / 60000);
    const diffSeconds = Math.floor((diffMs % 60000) / 1000);

    if (diffMinutes > 0) {
      return `${diffMinutes}m ago`;
    } else if (diffSeconds > 0) {
      return `${diffSeconds}s ago`;
    } else {
      return 'just now';
    }
  };

  useEffect(() => {
    if (!lastSaveTimestamp) return;

    const updateInterval = setInterval(() => {
      setTimeUpdateTrigger(prev => prev + 1);
    }, 30000);

    return () => clearInterval(updateInterval);
  }, [lastSaveTimestamp]);

  const migrateAgent = (oldAgent: Record<string, unknown>): { agent: AgentData; wasHealed: boolean } => {
    const healed = { value: false };
    const markHealed = (_reason: string) => { healed.value = true; };

    if (!oldAgent || typeof oldAgent !== 'object') {
      markHealed('corrupted root');
      return {
        agent: {
          version: "1",
          name: "Corrupted Agent",
          layers: [],
          metadata: {
            created: new Date().toISOString(),
            modified: new Date().toISOString(),
            description: "This agent has corrupted data"
          }
        },
        wasHealed: true
      };
    }

    const versionedWrapper = oldAgent as Record<string, unknown> & {
      current?: { layers?: unknown[]; metadata?: Record<string, unknown> };
    };
    const isVersionedWrapper = versionedWrapper.current && Array.isArray(versionedWrapper.current.layers);

    const agentSource: Record<string, unknown> = isVersionedWrapper
      ? {
          name: versionedWrapper.name || (versionedWrapper.current?.metadata as Record<string, unknown>)?.name || 'Untitled Agent',
          layers: versionedWrapper.current?.layers || [],
          metadata: versionedWrapper.current?.metadata || {}
        }
      : oldAgent;

    if (isVersionedWrapper) markHealed('versioned wrapper normalized');
    if (!agentSource.name) markHealed('missing name');

    const newAgent: AgentData = {
      version: "1",
      name: (agentSource.name as string) || "Untitled Agent",
      layers: [],
      metadata: {
        created: ((agentSource.metadata as Record<string, unknown>)?.created as string) || (agentSource.created as string) || new Date().toISOString(),
        modified: new Date().toISOString(),
        description: ((agentSource.metadata as Record<string, unknown>)?.description as string) || (agentSource.description as string) || "",
        ...normalizeAgentInputMetadata(agentSource.metadata),
        skillIds: (() => {
          const skillIds = (agentSource.metadata as Record<string, unknown>)?.skillIds;
          return Array.isArray(skillIds)
            ? skillIds.filter((skillId): skillId is string => typeof skillId === 'string' && skillId.length > 0)
            : undefined;
        })(),
        notes: (() => {
          const rawNotes = ((agentSource.metadata as Record<string, unknown>)?.notes as unknown) || [];

          if (Array.isArray(rawNotes)) {
            return rawNotes.map((note: unknown) => {
              if (note && typeof note === 'object' && 'username' in note && 'text' in note) {
                return note as { username: string; text: string; timestamp: string };
              }

              if (note && typeof note === 'object') {
                const noteObj = note as Record<string, string>;
                const keys = Object.keys(noteObj);
                if (keys.length === 1) {
                  const username = keys[0];
                  const text = noteObj[username];
                  return {
                    username,
                    text,
                    timestamp: new Date().toISOString()
                  };
                }
              }

              return {
                username: 'Unknown',
                text: String(note || ''),
                timestamp: new Date().toISOString()
              };
            });
          }

          return [];
        })()
      }
    };

    let layersData: Record<string, unknown>[] = [];
    if (agentSource.layers && Array.isArray(agentSource.layers)) {
      layersData = agentSource.layers as Record<string, unknown>[];
    } else if (agentSource.steps && Array.isArray(agentSource.steps)) {
      layersData = agentSource.steps as Record<string, unknown>[];
      markHealed('layers from steps');
    } else if (agentSource.chain && Array.isArray(agentSource.chain)) {
      layersData = agentSource.chain as Record<string, unknown>[];
      markHealed('layers from chain');
    } else if (!agentSource.layers) {
      markHealed('missing layers');
    }

    layersData.forEach((oldLayer: Record<string, unknown>, index: number) => {
      try {
        const hadId = Boolean(oldLayer.id || oldLayer._id);
        const hadName = Boolean(oldLayer.name || oldLayer.title || oldLayer.stepName);
        if (!hadId || !hadName) markHealed(`layer ${index + 1} missing id/name`);
        const newLayer: Layer = {
          id: (oldLayer.id as string) || (oldLayer._id as string) || `layer-${Date.now()}-${index}`,
          name: (oldLayer.name as string) || (oldLayer.title as string) || (oldLayer.stepName as string) || `Step ${index + 1}`,
          type: 'user',
          isActive: true,
          order: index,
          selectedModel: (oldLayer.selectedModel as string) ||
            (oldLayer.model as string) ||
            DEFAULT_MODEL,
          referencedSteps: (oldLayer.referencedSteps as string[]) ||
            (oldLayer.references as string[]) ||
            (oldLayer.deps as string[]) ||
            [],
          collection: (oldLayer.collection as number) || (oldLayer.collectionId as number) || undefined,
          systemInstruction: (oldLayer.systemInstruction as string) || (oldLayer.instructions as string) || (oldLayer.systemPrompt as string) || "",
          userInput: (oldLayer.userInput as string) ||
            (oldLayer.input as string) ||
            (oldLayer.userPrompt as string) ||
            (oldLayer.query as string) ||
            "",
          result: (oldLayer.result as string) || (oldLayer.output as string) || "",
          outputHistory: Array.isArray(oldLayer.outputHistory) ? oldLayer.outputHistory as Layer['outputHistory'] : undefined,
          modified: (oldLayer.modified as string) || ((agentSource.metadata as Record<string, unknown>)?.modified as string) || undefined,
          imageUrls: (oldLayer.imageUrls as string[]) ||
            (oldLayer.images as string[]) ||
            (oldLayer.attachments as string[]) || [],
          urlContent: (oldLayer.urlContent as string[]) ||
            (oldLayer.urls as string[]) ||
            (oldLayer.links as string[]) || [],
          pod: (oldLayer.pod as string) || "",
          userInstruction: (oldLayer.userInstruction as string) || (oldLayer.prompt as string) || "",
          assistantResponse: (oldLayer.assistantResponse as string) || "",
          functionCall: (oldLayer.functionCall as string) || "",
          toolCall: (oldLayer.toolCall as string) || "",
          condition: (oldLayer.condition as string) || "",
          isFrozen: (oldLayer.isFrozen as boolean) || false,
          keepMaster: (oldLayer.keepMaster as boolean) || false,
          outputType: ((oldLayer.outputType as string) === 'code' ? 'code' : 'basic') as 'basic' | 'code',
          image: (oldLayer.image as string) || null,
          inputUrl: (oldLayer.inputUrl as string) || "",
          inputUrlType: ((oldLayer.inputUrlType as string) || "") as 'webpage' | 'gdrive' | 'gdoc' | 'gsheet' | 'database' | '',
          selectedPersona: (oldLayer.selectedPersona as string) || undefined,
          selectedPersonaIcon: (oldLayer.selectedPersonaIcon as string) || undefined,
          bibliography: (oldLayer.bibliography as BibliographyItem[]) || [],
          ragKnowledge: (oldLayer.ragKnowledge as SelectedRag[]) || [],
          corpusId: (oldLayer.corpusId as string) || undefined,
          documentSelections: Array.isArray(oldLayer.documentSelections) ? (oldLayer.documentSelections as string[]) : [],
          tag: (oldLayer.tag as string) || undefined,
          debugInfo: (oldLayer.debugInfo as AnswerDebugInfo) || undefined,
          lastRunDiagnostics: parseStepRunDiagnostics(oldLayer.lastRunDiagnostics),
        };
        if (newLayer.ragKnowledge && newLayer.ragKnowledge.length > 0) {
          console.log(`📚 [Migration] Layer ${newLayer.id} has ${newLayer.ragKnowledge.length} RAG items:`, newLayer.ragKnowledge.map(r => r.filename));
        }
        newAgent.layers.push(newLayer);
      } catch (layerError) {
        console.error(`Error migrating layer ${index}:`, layerError);
        markHealed(`layer ${index + 1} corrupted`);
        newAgent.layers.push({
          id: `corrupted-layer-${index}`,
          name: `Corrupted Step ${index + 1}`,
          type: 'user',
          isActive: true,
          order: index,
          selectedModel: DEFAULT_MODEL,
          systemInstruction: "This step has corrupted data",
          userInput: "",
          result: "",
          referencedSteps: [],
          imageUrls: [],
          urlContent: [],
          pod: "",
          userInstruction: "",
          assistantResponse: "",
          functionCall: "",
          toolCall: "",
          condition: "",
          isFrozen: false,
          keepMaster: false,
          outputType: 'basic',
          image: null,
          inputUrl: "",
          inputUrlType: "",
          selectedPersona: undefined,
          selectedPersonaIcon: undefined,
          bibliography: [],
          ragKnowledge: []
        });
      }
    });

    return { agent: newAgent, wasHealed: healed.value };
  };

  const handleSaveAgent = async () => {
    if (savingRef.current) return;
    if (!agent || !agentName.trim()) {
      showModal('warning', 'Agent Name Required', 'Please enter an agent name before saving.');
      return;
    }
    if (!projectFolder?.projectId) {
      showModal('warning', 'No Project Selected', 'Please select a project folder first.');
      return;
    }
    runVersioning.invalidate();
    runAbortRef.current?.abort();
    autosaveScopeRef.current = { ...autosaveScopeRef.current };
    savingRef.current = true;
    setIsSaving(true);
    try {
      const { saveAgentWithVersioning } = await import('../../../lib/versionUtils');

      const timestamp = new Date().toISOString();
      const agentToSave = {
        ...agent,
        name: agentName,
        layers: agent.layers.map(mergeLayerCorpusForSave),
        metadata: {
          ...agent.metadata,
          modified: timestamp
        }
      };

      console.log('📚 [NEW VERSION] Bibliography data being saved:',
        agentToSave.layers.map(layer => ({
          layerId: layer.id,
          layerName: layer.name,
          bibliographyCount: layer.bibliography?.length || 0,
          bibliography: layer.bibliography || []
        }))
      );

      const result = await saveAgentWithVersioning(
        projectFolder.projectId,
        agentName,
        agentToSave,
        agentId || undefined
      );

      if (result.success) {
        await loadAgentFromStorage({ silent: true });
      } else {
        throw new Error(result.error || 'Save failed');
      }

    } catch (error) {
      showModal(
        'error',
        'Save Failed',
        `Failed to save agent: ${error instanceof Error ? error.message : 'Please try again.'}`
      );
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  const handleAutosave = async () => {
    if (!isMountedRef.current) return;

    if (!agentId || !projectFolder?.projectId || !agentName.trim() || isLoading || savingRef.current || isAutosaving || !agent) {
      return;
    }
    if (!canAutosaveAgentVersion(versionedAgentData, selectedVersion)) return;
    const savedScope = autosaveScopeRef.current;
    const savedVersion = selectedVersion;
    const shouldSave = () => isMountedRef.current && !savingRef.current
      && autosaveScopeRef.current === savedScope && selectedVersionRef.current === savedVersion
      && canAutosaveAgentVersion(versionedAgentDataRef.current, savedVersion);

    const currentTime = Date.now();

    if (currentTime - lastAutosaveTime < 10000) {
      return;
    }

    setIsAutosaving(true);

    try {
      const { updateAgentSameVersionByFileId } = await import('../../../lib/versionUtils');

      if (!shouldSave()) return;

      const timestamp = new Date().toISOString();
      const agentToSave = {
        ...agent,
        name: agentName,
        // No-drop merge: keeps a corpus that never entered the sidecar map (e.g. a
        // cross-user shared corpus) instead of silently writing corpusId: undefined.
        layers: agent.layers.map(mergeLayerCorpusForSave),
        metadata: {
          ...agent.metadata,
          modified: timestamp
        }
      };

      console.log('📚 [AUTO-SAVE] Bibliography data being saved:',
        agentToSave.layers.map(layer => ({
          layerId: layer.id,
          layerName: layer.name,
          bibliographyCount: layer.bibliography?.length || 0,
          bibliography: layer.bibliography || []
        }))
      );

      const result = await updateAgentSameVersionByFileId(projectFolder.projectId, agentId, agentToSave, {
        expectedCurrentVersion: savedVersion || undefined, shouldSave,
      });

      if (!shouldSave()) return;

      if (result.success) {
        setLastAutosaveTime(currentTime);
        setLastSaveTimestamp(new Date().toISOString());
        if (result.versionedAgent) {
          const savedAgent = result.versionedAgent;
          versionedAgentDataRef.current = savedAgent;
          setVersionedAgentData(savedAgent);
        }
        console.log('✅ Agent autosaved successfully');
      } else if (!result.skipped) {
        console.warn('⚠️ Autosave skipped:', result.error);
      }

    } catch (error) {
      if (!isMountedRef.current) return;
      console.error('❌ Autosave error:', error);
    } finally {
      if (isMountedRef.current) setIsAutosaving(false);
    }
  };
  handleAutosaveRef.current = handleAutosave;

  const triggerBibSave = () => {
    if (isLoading || savingRef.current || !canAutosaveAgentVersion(versionedAgentData, selectedVersion)) return;
    if (bibSaveTimerRef.current) clearTimeout(bibSaveTimerRef.current);
    const savedAgentId = agentId;
    const savedProjectId = projectFolder?.projectId;
    const savedAgentName = agentName;
    const savedVersion = selectedVersion;
    const savedScope = autosaveScopeRef.current;
    const shouldSave = () => isMountedRef.current && !savingRef.current
      && autosaveScopeRef.current === savedScope && selectedVersionRef.current === savedVersion
      && canAutosaveAgentVersion(versionedAgentDataRef.current, savedVersion);
    bibSaveTimerRef.current = setTimeout(async () => {
      if (!shouldSave()) return;
      const currentAgent = agentRef.current;
      if (!currentAgent || !savedAgentId || !savedProjectId || !savedAgentName.trim()) return;
      setIsAutosaving(true);
      try {
        const { updateAgentSameVersionByFileId } = await import('../../../lib/versionUtils');
        const timestamp = new Date().toISOString();
        const agentToSave = {
          ...currentAgent,
          name: savedAgentName,
          layers: currentAgent.layers.map(mergeLayerCorpusForSave),
          metadata: { ...currentAgent.metadata, modified: timestamp }
        };
        const result = await updateAgentSameVersionByFileId(savedProjectId, savedAgentId, agentToSave, {
          expectedCurrentVersion: savedVersion || undefined, shouldSave,
        });
        if (result.success && shouldSave()) {
          setLastSaveTimestamp(new Date().toISOString());
          if (result.versionedAgent) {
            const savedAgent = result.versionedAgent;
            versionedAgentDataRef.current = savedAgent;
            setVersionedAgentData(savedAgent);
          }
        }
      } catch (e) {
        console.error('Bibliography silent save error:', e);
      } finally {
        setIsAutosaving(false);
      }
    }, 2000);
  };

  const handleAddNote = async () => {
    if (!currentNote.trim() || !agent) return;
    if (!agentName.trim()) {
      showModal('warning', 'Agent Name Required', 'Please enter an agent name first');
      return;
    }
    if (!projectFolder?.projectId) {
      showModal('warning', 'No Project Selected', 'Please select a project folder first.');
      return;
    }

    setIsSavingNote(true);

    const userName = session?.user?.name || session?.user?.email || 'Anonymous';
    const newNote = {
      username: userName,
      text: currentNote.trim(),
      timestamp: new Date().toISOString()
    };

    const updatedNotes = [...(agent.metadata?.notes || []), newNote];
    setAgent(prev => prev ? {
      ...prev,
      metadata: {
        ...prev.metadata,
        created: prev.metadata?.created || new Date().toISOString(),
        modified: new Date().toISOString(),
        description: prev.metadata?.description || '',
        notes: updatedNotes
      }
    } : prev);

    setCurrentNote('');

    try {
      const { updateAgentNotesOnly } = await import('../../../lib/versionUtils');

      await new Promise(resolve => setTimeout(resolve, 100));

      const result = await updateAgentNotesOnly(
        projectFolder.projectId,
        agentName,
        updatedNotes
      );

      if (!result.success) {
        throw new Error(result.error || 'Failed to save notes to Google Drive');
      }

      console.log('✅ Notes saved to Google Drive after agent data preservation');

    } catch (error) {
      console.error('Error saving note to Google Drive:', error);
      showModal(
        'error',
        'Failed to Save Note',
        `Failed to save note to Google Drive: ${error instanceof Error ? error.message : 'Please try again.'}`
      );

      setAgent(prev => prev ? {
        ...prev,
        metadata: {
          created: prev.metadata?.created || new Date().toISOString(),
          modified: prev.metadata?.modified || new Date().toISOString(),
          ...prev.metadata,
          notes: prev.metadata?.notes?.slice(0, -1) || []
        }
      } : prev);
    } finally {
      setIsSavingNote(false);
    }
  };

  const handleBackToDashboard = () => {
    const confirmNavigation = window.confirm('Are you sure you want to go back? Any unsaved changes will be lost.');

    if (confirmNavigation) {
      router.push('/ai-agents');
    }
  };

  const addStep = () => {
    if (!agent) return;

    const currentLayers = agent.layers || [];
    const newLayer: Layer = {
      id: `layer-${Date.now()}`,
      name: `Step ${currentLayers.length + 1}`,
      type: 'user',
      isActive: true,
      order: currentLayers.length,
      selectedModel: DEFAULT_MODEL,
      systemInstruction: '',
      userInput: '',
      result: '',
      referencedSteps: [],
      imageUrls: [],
      urlContent: [],
      pod: '',
      userInstruction: '',
      assistantResponse: '',
      functionCall: '',
      toolCall: '',
      condition: '',
      isFrozen: false,
      keepMaster: false,
      outputType: 'basic',
      inputUrl: '',
      inputUrlType: '',
      selectedPersona: undefined,
      selectedPersonaIcon: undefined
    };

    setAgent(prev => prev ? ({
      ...prev,
      layers: [...(prev.layers || []), newLayer]
    }) : null);
    logActivity('add_step', newLayer.name, { targetId: newLayer.id });
  };

  useEffect(() => {
    const handleVoicePageAction = (event: Event) => {
      const detail = (event as CustomEvent<{ pageAction?: string }>).detail;
      const action = (detail?.pageAction || '').trim();

      if (!action) return;

      if (action === 'add_step') {
        const prevAgent = agentRef.current;
        if (!prevAgent) {
          window.dispatchEvent(
            new CustomEvent('alma:page-action-result', {
              detail: { ok: false, message: 'No agent is loaded yet.' } })
          );
          return;
        }

        const currentLayers = prevAgent.layers || [];
        const newLayer: Layer = {
          id: `layer-${Date.now()}`,
          name: `Step ${currentLayers.length + 1}`,
          type: 'user',
          isActive: true,
          order: currentLayers.length,
          selectedModel: DEFAULT_MODEL,
          systemInstruction: '',
          userInput: '',
          result: '',
          referencedSteps: [],
          imageUrls: [],
          urlContent: [],
          pod: '',
          userInstruction: '',
          assistantResponse: '',
          functionCall: '',
          toolCall: '',
          condition: '',
          isFrozen: false,
          keepMaster: false,
          outputType: 'basic',
          inputUrl: '',
          inputUrlType: '',
          selectedPersona: undefined,
          selectedPersonaIcon: undefined };

        setAgent((prev) => prev ? ({ ...prev, layers: [...(prev.layers || []), newLayer] }) : prev);
        window.dispatchEvent(
          new CustomEvent('alma:page-action-result', {
            detail: { ok: true, message: `Added ${newLayer.name}.` } })
        );
        logActivity('add_step', newLayer.name, { targetId: newLayer.id });
        return;
      }

      if (action === 'clear_editor') {
        setAgent((prev) => {
          if (!prev) {
            window.dispatchEvent(
              new CustomEvent('alma:page-action-result', {
                detail: { ok: false, message: 'No agent is loaded yet.' } })
            );
            return prev;
          }
          const cleared = (prev.layers || []).map((layer) => ({
            ...layer,
            userInstruction: '',
            userInput: '',
            result: '' }));
          window.dispatchEvent(
            new CustomEvent('alma:page-action-result', {
              detail: { ok: true, message: 'Cleared current editor step content.' } })
          );
          return { ...prev, layers: cleared };
        });
        return;
      }

      window.dispatchEvent(
        new CustomEvent('alma:page-action-result', {
          detail: { ok: false, message: `Unsupported page action: ${action}` } })
      );
    };

    window.addEventListener('alma:page-action', handleVoicePageAction as EventListener);
    return () => {
      window.removeEventListener('alma:page-action', handleVoicePageAction as EventListener);
    };
  }, []);

  const removeStep = (layerId: string) => {
    if (!agent || !agent.layers || agent.layers.length <= 1) {
      showModal('warning', 'Cannot Remove Step', 'Agent must have at least one step');
      return;
    }

    const removedName = agent.layers.find(l => l.id === layerId)?.name || layerId;
    setAgent(prev => prev ? ({
      ...prev,
      layers: (prev.layers || [])
        .filter(l => l.id !== layerId)
        // Drop the removed step from every other step's referencedSteps so the
        // form delete leaves no dangling references — matching the graph delete
        // (AgentEditorContext.removeLayer).
        .map(l => ({
          ...l,
          referencedSteps: (l.referencedSteps ?? []).filter(id => id !== layerId),
        })),
    }) : null);
    logActivity('remove_step', removedName, { targetId: layerId });
  };

  const duplicateStep = (layerId: string) => {
    if (!agent || !agent.layers) return;

    const originalLayer = agent.layers.find(l => l.id === layerId);
    if (!originalLayer) return;

    const cloneLayer = (layer: Layer): Layer => {
      try {
        return structuredClone(layer);
      } catch {
        return JSON.parse(JSON.stringify(layer));
      }
    };

    const duplicatedLayer = cloneLayer(originalLayer);

    duplicatedLayer.id = `layer-${Date.now()}`;
    duplicatedLayer.name = `${originalLayer.name} (copy)`;
    duplicatedLayer.result = '';
    duplicatedLayer.assistantResponse = '';
    duplicatedLayer.functionCall = '';
    duplicatedLayer.toolCall = '';

    const originalIndex = agent.layers.findIndex(l => l.id === layerId);
    const newLayers = [...agent.layers];
    newLayers.splice(originalIndex + 1, 0, duplicatedLayer);

    newLayers.forEach((layer, index) => {
      layer.order = index;
    });

    setAgent(prev => prev ? ({
      ...prev,
      layers: newLayers
    }) : null);
    logActivity('add_step', duplicatedLayer.name, { targetId: duplicatedLayer.id });
  };

  // User-authored fields worth logging as an edit. Excludes run outputs/state
  // (result, executionTime, isActive, order, …) which change programmatically.
  const LOGGED_EDIT_FIELDS: ReadonlyArray<keyof Layer> = [
    'name', 'systemInstruction', 'userInstruction', 'userInput', 'assistantResponse',
    'functionCall', 'toolCall', 'condition', 'selectedModel', 'tag', 'selectedPersona',
  ];

  const updateStep = <K extends keyof Layer>(layerId: string, field: K, value: Layer[K]) => {
    setAgent(prev => {
      if (!prev) return null;

      const updatedAgent = {
        ...prev,
        layers: prev.layers.map(layer =>
          layer.id === layerId
            ? { ...layer, [field]: value }
            : layer
        )
      };

      agentRef.current = updatedAgent;

      return updatedAgent;
    });
    if (LOGGED_EDIT_FIELDS.includes(field)) {
      const label = field === 'name'
        ? String(value)
        : (agentRef.current?.layers.find(l => l.id === layerId)?.name ?? layerId);
      logStepEdit(layerId, label);
    }
  };

  const handleMouseEnter = (e: React.MouseEvent, text: string) => {
    if (tooltipAutoCloseRef.current) clearTimeout(tooltipAutoCloseRef.current);
    setTooltip({ x: e.clientX, y: e.clientY, text });
    tooltipAutoCloseRef.current = setTimeout(() => {
      setTooltip(null);
      tooltipAutoCloseRef.current = null;
    }, TOOLTIP_AUTO_CLOSE_MS);
  };

  const handleMouseLeave = () => {
    if (tooltipAutoCloseRef.current) {
      clearTimeout(tooltipAutoCloseRef.current);
      tooltipAutoCloseRef.current = null;
    }
    setTooltip(null);
  };

  const updateNodeField = <K extends keyof Layer>(layerId: string, key: K, val: Layer[K]) => {
    updateStep(layerId, key, val);
  };

  const toggleInputsVisibility = (layerId: string) => {
    setInputsVisible(prev => ({ ...prev, [layerId]: !prev[layerId] }));
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const downloadAsText = (text: string, name: string) => {
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name || 'result'}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to download:", err);
    }
  };

  const fetchCollectionContent = (collectionNumber: number): string => {
    if (!collections || !collectionNumber || collectionNumber <= 0) return '';

    const entries = collections[collectionNumber - 1] || [];
    if (!entries.length) return 'Collection is empty';

    const content = entries
      .map(
        (entry) =>
          `% Page ${entry.pageNumber}, PDF: ${entry.PDFName}\n${entry.content}`
      )
      .join("\n\n");
    return content;
  };

  const validateFile = (file: File): { isValid: boolean; error?: string } => {
    const maxSizeInBytes = 30 * 1024 * 1024;

    if (file.size > maxSizeInBytes) {
      return {
        isValid: false,
        error: `File "${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)}MB, which exceeds the maximum allowed size of 30MB.`
      };
    }

    if (!isPickableFile(file.type)) {
      return {
        isValid: false,
        error: `File "${file.name}" has an unsupported format (${file.type}).\n\nSupported formats:\n• Images: PNG, JPG, GIF, WebP, SVG, etc.\n• PDF Documents\n• Audio: MP3, WAV, M4A, OGG, etc.\n• Video: MP4, AVI, MOV, WebM, etc.`
      };
    }

    return { isValid: true };
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLElement>, layerId: string) => {
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const blob = items[i].getAsFile();
        if (blob) {
          const sizeValidation = validateFileSize(blob);
          if (!sizeValidation.isValid) {
            alert(sizeValidation.error);
            return;
          }
          const validation = validateFile(blob);
          if (!validation.isValid) {
            alert(validation.error);
            return;
          }

          const url = URL.createObjectURL(blob);
          setFileStates(prev => ({
            ...prev,
            [layerId]: {
              files: [...(prev[layerId]?.files || []), blob],
              fileUrls: [...(prev[layerId]?.fileUrls || []), url]
            }
          }));
          setStepInputTab(prev => ({ ...prev, [layerId]: 'upload' }));
          e.preventDefault();
        }
      }
    }
  };

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>, layerId: string) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const validFiles: File[] = [];
      const validUrls: string[] = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const sizeValidation = validateFileSize(file);
        if (!sizeValidation.isValid) {
          alert(sizeValidation.error);
          continue;
        }
        const validation = validateFile(file);
        if (!validation.isValid) {
          alert(`Error with file ${file.name}: ${validation.error}`);
          continue;
        }

        if (file.type === 'application/pdf') {
          await processPdfFileWithWarning(file, layerId);
          e.target.value = '';
          continue;
        }

        validFiles.push(file);
        validUrls.push(URL.createObjectURL(file));
      }

      if (validFiles.length > 0) {
        const updatedFiles = [...(fileStates[layerId]?.files || []), ...validFiles];
        setFileStates(prev => ({
          ...prev,
          [layerId]: {
            files: updatedFiles,
            fileUrls: [...(prev[layerId]?.fileUrls || []), ...validUrls]
          }
        }));
        setStepInputTab(prev => ({ ...prev, [layerId]: 'upload' }));
        syncFileBibliography(layerId, updatedFiles);
      }
    }
  };

  const handleFileRemove = (layerId: string, fileToRemove?: File) => {
    const fileState = fileStates[layerId];
    const removedIndex = fileToRemove ? (fileState?.files.indexOf(fileToRemove) ?? -1) : -1;
    if (fileToRemove && removedIndex < 0) return;
    const remainingFiles = fileToRemove ? fileState.files.filter(file => file !== fileToRemove) : [];
    const removedUrls = fileToRemove ? [fileState.fileUrls[removedIndex]] : (fileState?.fileUrls || []);
    removedUrls.forEach(url => { if (url) URL.revokeObjectURL(url); });
    setFileStates(prev => {
      const currentFiles = prev[layerId]?.files || [];
      return {
        ...prev,
        [layerId]: {
          files: fileToRemove ? currentFiles.filter(file => file !== fileToRemove) : [],
          fileUrls: fileToRemove
            ? (prev[layerId]?.fileUrls || []).filter((_, index) => currentFiles[index] !== fileToRemove)
            : []
        }
      };
    });
    setFilePageCounts(prev => {
      const next = { ...prev };
      if (fileToRemove) next[layerId] = (prev[layerId] || []).filter((_, index) => index !== removedIndex);
      else delete next[layerId];
      return next;
    });
    setAgent(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        layers: prev.layers.map(layer =>
          layer.id === layerId
            ? { ...layer, bibliography: (layer.bibliography || []).filter(item =>
              item.type !== 'file' || Boolean(fileToRemove && (
                fileToRemove.type !== 'application/pdf' || item.name !== fileToRemove.name ||
                remainingFiles.some(file => file.type === 'application/pdf' && file.name === item.name)
              ))
            ) }
            : layer
        )
      };
    });
  };

  const renderStepAttachments = (layerId: string) => {
    const fileState = fileStates[layerId];
    if (!fileState?.files.length) return null;

    return (
      <div role="group" aria-label="Attached files" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
        {fileState.files.map((file, index) => {
          const isImage = file.type.startsWith('image/');
          const isPdf = file.type === 'application/pdf';
          const previewUrl = fileState.fileUrls[index];
          const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
          const pages = filePageCounts[layerId]?.[index] ?? 0;
          return (
            <div
              key={previewUrl || index}
              style={{
                display: 'flex', flexDirection: 'column', gap: '2px', padding: '5px 8px',
                background: '#f0f4ff', border: '1px solid #c5d3f7', borderRadius: '6px',
                fontSize: '0.78rem', color: '#3a4a7a', maxWidth: '220px', minWidth: 0
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                {isImage && previewUrl ? (
                  <img src={previewUrl} alt={file.name} style={{ width: '22px', height: '22px', objectFit: 'cover', borderRadius: '3px', flexShrink: 0 }} />
                ) : (
                  <FaFileAlt size={13} style={{ flexShrink: 0, color: '#6c7fba' }} />
                )}
                <span title={file.name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500, minWidth: 0 }}>
                  {file.name}
                </span>
                <button
                  type="button"
                  onClick={() => handleFileRemove(layerId, file)}
                  aria-label={`Remove ${file.name} from this step`}
                  title={`Remove ${file.name} from this step`}
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: '24px', height: '24px', flexShrink: 0, padding: 0, marginLeft: 'auto',
                    border: 'none', borderRadius: '4px', background: 'transparent', color: '#dc3545', cursor: 'pointer'
                  }}
                >
                  <FaTimes size={10} />
                </button>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', paddingLeft: '19px', fontSize: '0.72rem', color: '#5568a8' }}>
                <span>{sizeMB} MB</span>
                {isPdf && pages > 0 && <span>{pages.toLocaleString()} pages</span>}
                {isPdf && pages === 0 && <span style={{ opacity: 0.6 }}>counting pages...</span>}
              </div>
            </div>
          );
        })}
        <button
          type="button"
          onClick={() => handleFileRemove(layerId)}
          style={{
            fontSize: '0.75rem', padding: '2px 6px', background: 'none', border: 'none',
            color: '#dc3545', cursor: 'pointer', textDecoration: 'underline', alignSelf: 'center'
          }}
        >
          Clear
        </button>
      </div>
    );
  };

  const downloadFileFromGoogleDrive = async (fileId: string, fileName: string, mimeType?: string): Promise<File | null> => {
    const token = session?.accessToken;

    if (!token) {
      alert('Authentication token not available. Please refresh the page and try again.');
      return null;
    }

    if (!isPickableFile(mimeType || '', fileName)) {
      alert(`File "${fileName}" has an unsupported format${mimeType ? ` (${mimeType})` : ''} and cannot be used with agents.\n\nSupported formats:\n• Images: PNG, JPG, GIF, WebP, SVG, etc.\n• PDF Documents\n• Audio: MP3, WAV, M4A, OGG, etc.\n• Video: MP4, AVI, MOV, WebM, etc.`);
      return null;
    }

    try {
      setIsImageUploading(true);

      const { getCachedFile, cacheFile, fileCacheManager } = await import('../../../lib/fileCacheManager');
      const cachedFile = await getCachedFile(fileId);

      if (cachedFile) {
        return cachedFile;
      }

      if (mimeType) {
        await fileCacheManager.cacheFileMetadata({
          id: fileId,
          name: fileName,
          mimeType });
      }

      const response = await fetch(getGoogleDriveDownloadUrl(fileId, mimeType), {
        mode: 'cors',
        headers: {
          'Authorization': `Bearer ${token}` } });

      if (!response.ok) {
        let errorMessage = `Failed to download "${fileName}"`;

        switch (response.status) {
          case 401:
            errorMessage += ': Authentication expired. Please refresh the page and try again.';
            break;
          case 403:
            errorMessage += ': Access denied. You may not have permission to download this file.';
            break;
          case 404:
            errorMessage += ': File not found. It may have been deleted or moved.';
            break;
          case 429:
            errorMessage += ': Too many requests. Please try again in a moment.';
            break;
          default:
            errorMessage += response.statusText ? `: ${response.statusText}` : ': Unknown error occurred.';
        }

        alert(errorMessage);
        console.error('Download failed:', {
          status: response.status,
          statusText: response.statusText,
          fileName,
          fileId
        });
        return null;
      }

      const blob = await response.blob();

      if (blob.size === 0) {
        alert(`File "${fileName}" appears to be empty and cannot be attached.`);
        return null;
      }

      const sizeValidation = validateFileSize(blob, fileName);
      if (!sizeValidation.isValid) {
        alert(sizeValidation.error);
        return null;
      }

      const finalMimeType = blob.type || mimeType || 'application/octet-stream';
      await cacheFile(fileId, fileName, finalMimeType, blob);

      const file = new File([blob], fileName, {
        type: finalMimeType
      });

      return file;
    } catch (error) {
      console.error('Error downloading file:', error);
      alert(`Network error while downloading "${fileName}". Please check your connection and try again.`);
      return null;
    } finally {
      setIsImageUploading(false);
    }
  };

  const attachSelectedFileToStep = async (layerId: string, selectedFile: SelectedFile) => {
    const attachKey = `${layerId}-${selectedFile.id}`;
    if (pendingFileAttachmentsRef.current.has(attachKey) ||
        fileStates[layerId]?.files.some(file => getAgentInputFileSourceId(file) === selectedFile.id)) return;
    pendingFileAttachmentsRef.current.add(attachKey);

    console.log('🔗 [PDF DEBUG] Starting file attachment:', {
      layerId,
      fileName: selectedFile.name,
      mimeType: selectedFile.mimeType,
      isPDF: selectedFile.mimeType === 'application/pdf'
    });

    try {
      setAttachingFiles(prev => ({ ...prev, [attachKey]: true }));

      const downloadedFile = await downloadFileFromGoogleDrive(selectedFile.id, selectedFile.name, selectedFile.mimeType);

      if (downloadedFile) {
        console.log('📁 [PDF DEBUG] File downloaded successfully:', {
          name: downloadedFile.name,
          type: downloadedFile.type,
          size: downloadedFile.size,
          isPDF: downloadedFile.type === 'application/pdf'
        });

        let pdfPageCount = 0;
        if (downloadedFile.type === 'application/pdf') {
          pdfPageCount = await detectPdfPageCount(downloadedFile);
          
          if (pdfPageCount > 500 && pdfPageCount <= 950) {
            console.log(`📚 [PDF RAG ADVICE] Medium-large PDF detected: ${downloadedFile.name} has ${pdfPageCount} pages`);

            const useRagInstead = window.confirm(
              `📚 RAG RECOMMENDED FOR LARGE PDF\n\n` +
              `"${downloadedFile.name}" contains ${pdfPageCount.toLocaleString()} pages.\n\n` +
              `For documents over 500 pages, we recommend using RAG (Retrieval-Augmented Generation) instead of direct file attachment.\n\n` +
              `HOW TO USE RAG:\n` +
              `1. Cancel this upload\n` +
              `2. Go to "RAG Knowledge" section above\n` +
              `3. Click "+ Add RAG" to upload the PDF to the corpus\n` +
              `4. Select the indexed file from the dropdown\n\n` +
              `Click "OK" to proceed with DIRECT UPLOAD anyway\n` +
              `Click "Cancel" to stop and use RAG instead (recommended)`
            );

            if (!useRagInstead) {
              console.log(`📚 [PDF RAG ADVICE] User chose to cancel and use RAG for ${downloadedFile.name}`);
              setAttachingFiles(prev => ({ ...prev, [attachKey]: false }));
              return;
            }

            console.log(`📄 [PDF RAG ADVICE] User chose direct upload for ${downloadedFile.name} despite RAG recommendation`);
          }
          
          if (pdfPageCount > 1000) {
            console.log(`⚠️ [PDF WARNING] Large PDF detected: ${downloadedFile.name} has ${pdfPageCount} pages`);
            alert(
              `⚠️ FILE TOO LARGE\n\n` +
              `"${downloadedFile.name}" contains ${pdfPageCount.toLocaleString()} pages.\n\n` +
              `PDFs with more than 1000 pages are currently not supported for direct attachment due to processing limits.\n\n` +
              `RECOMMENDATION: Consider splitting this PDF into smaller sections (<1000 pages each) or use RAG (Retrieval-Augmented Generation) instead.`
            );
            setAttachingFiles(prev => ({ ...prev, [attachKey]: false }));
            return;
          }
        }

        registerAgentInputFile(downloadedFile, selectedFile.id);
        const url = URL.createObjectURL(downloadedFile);
        console.log('🔗 [PDF DEBUG] Blob URL created:', url);

        setFileStates(prev => {
          const newState = {
            ...prev,
            [layerId]: {
              files: [...(prev[layerId]?.files || []), downloadedFile],
              fileUrls: [...(prev[layerId]?.fileUrls || []), url]
            }
          };

          console.log('🗂️ [PDF DEBUG] FileState updated:', {
            layerId,
            totalFiles: newState[layerId].files.length,
            fileNames: newState[layerId].files.map(f => f.name),
            fileTypes: newState[layerId].files.map(f => f.type)
          });

          return newState;
        });

        setFilePageCounts(prev => ({
          ...prev,
          [layerId]: [...(prev[layerId] || []), pdfPageCount]
        }));

        if (downloadedFile.type === 'application/pdf') {
          const pdfPath = `/PDFs/${selectedFile.name}`;
          addPdfToBibliography(layerId, selectedFile.name, pdfPath);
        }
      } else {
        console.error('❌ [PDF DEBUG] File download failed - downloadedFile is null');
      }
    } catch (error) {
      console.error('❌ [PDF DEBUG] Error attaching file:', error);
    } finally {
      pendingFileAttachmentsRef.current.delete(attachKey);
      setAttachingFiles(prev => ({ ...prev, [attachKey]: false }));
    }
  };

  const attachPaperToStep = (layerId: string, paper: SelectedPaper) => {
    const currentInput = agent?.layers.find(layer => layer.id === layerId)?.userInput || '';
    if (currentInput.includes(`**Scientific Paper: ${paper.title}**`)) {
      console.log(`[AttachAbstract] Paper "${paper.title}" already attached to layer ${layerId}`);
      return;
    }

    let abstractText = '';
    if (typeof paper.abstract === 'string') {
      abstractText = paper.abstract;
    } else if (typeof paper.abstract === 'object' && paper.abstract !== null) {
      abstractText = JSON.stringify(paper.abstract);
    } else {
      abstractText = 'No abstract available.';
    }

    const paperText = `
**Scientific Paper: ${paper.title}**

**Authors:** ${paper.authors?.join(', ')}
**Publication Date:** ${paper.pubdate}
${paper.doi ? `**DOI:** ${paper.doi}` : ''}

**Abstract:**
${abstractText}

---
`;

    const newInput = currentInput ? `${currentInput}\n\n${paperText}` : paperText;

    updateNodeField(layerId, 'userInput', newInput);
  };

  const _attachRagToStep = (layerId: string, ragItem: SelectedRag) => {
    const layer = agent?.layers.find(l => l.id === layerId);
    if (!layer) {
      console.log(`❌ [AttachRAG] Layer ${layerId} not found`);
      return;
    }

    const currentRagItems = layer.ragKnowledge || [];
    const existingItem = currentRagItems.find(r => r.id === ragItem.id);

    if (existingItem) {
      console.log(`[AttachRAG] RAG item "${ragItem.filename}" already attached to layer ${layerId}`);
      return;
    }

    const updatedRagItems = [...currentRagItems, ragItem];
    updateNodeField(layerId, 'ragKnowledge', updatedRagItems);

    console.log(`✅ [AttachRAG] Attached RAG item "${ragItem.filename}" to step ${layerId}. Total RAG items: ${updatedRagItems.length}`);
    console.log(`🔍 [AttachRAG] Updated RAG items:`, updatedRagItems.map(r => r.filename));
  };

  const _removeRagFromStep = (layerId: string, ragItemId?: string) => {
    const layer = agent?.layers.find(l => l.id === layerId);
    if (!layer) return;

    const currentRagItems = layer.ragKnowledge || [];

    if (ragItemId) {
      const updatedRagItems = currentRagItems.filter(r => r.id !== ragItemId);
      updateNodeField(layerId, 'ragKnowledge', updatedRagItems);
      console.log(`Successfully removed specific RAG item ${ragItemId} from step ${layerId}`);
    } else {
      updateNodeField(layerId, 'ragKnowledge', []);
      console.log(`Successfully removed all RAG items from step ${layerId}`);
    }
  };

  const enhanceUserPrompt = async (layerId: string) => {
    if (!agent) return;

    const layer = agent.layers.find(l => l.id === layerId);
    if (!layer || enhancingPrompts[layerId]) return;

    setEnhancingPrompts(prev => ({ ...prev, [layerId]: true }));

    try {
      const response = await fetch('/api/gemini', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{
            role: 'user',
            text: `Please enhance and improve this text to make it more effective, detailed, comprehensive and well-structured. Keep the original intent and meaning but make it clearer, more specific, and better organized:\n\n"${layer.userInstruction}"`
          }],
          model: DEFAULT_MODEL
        }) });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('API Error Response:', response.status, errorText);
        throw new Error(`Failed to enhance user instruction: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      const enhancedInstruction = data.response || layer.userInstruction + "\n\n[Enhancement failed]";
      updateNodeField(layerId, 'userInstruction', enhancedInstruction);
    } catch (error) {
      console.error('Error enhancing user instruction:', error);
      alert('Failed to enhance user instruction. Please try again.');
    } finally {
      setEnhancingPrompts(prev => ({ ...prev, [layerId]: false }));
    }
  };

  const handleExpandTextarea = (layerId: string, type: 'userInstruction' | 'userInput') => {
    const layer = agent?.layers.find(l => l.id === layerId);
    if (!layer) return;

    const content = type === 'userInstruction' ? layer.userInstruction : layer.userInput;
    setPersonaModalConfig({ layerId, type, content: content || '' });
    setPersonaModalOpen(true);
  };

  const handleSavePersonaContent = (newContent: string, personaId?: string, personaIcon?: string) => {
    if (!personaModalConfig) return;

    let finalContent = newContent;
    if (personaModalConfig.type === 'userInstruction' && personaId && personaIcon) {
      finalContent = newContent.replace(/^\[.*?\]\s*/, '');
      finalContent = `[${personaIcon}] ${finalContent}`;
      updateStep(personaModalConfig.layerId, 'selectedPersona', personaId);
      updateStep(personaModalConfig.layerId, 'selectedPersonaIcon', personaIcon);
    }

    updateStep(personaModalConfig.layerId, personaModalConfig.type, finalContent);
    setPersonaModalOpen(false);
    setPersonaModalConfig(null);
  };

  const handleClosePersonaModal = () => {
    setPersonaModalOpen(false);
    setPersonaModalConfig(null);
  };

  const handlePdfSplitConfirm = async () => {
    if (!pendingSplitPdf) return;

    try {
      setSplittingInProgress(true);
      setSplittingProgress('Analyzing PDF structure...');
      console.log(`🔄 [PDF SPLIT] Splitting PDF to create sub-30MB chunks...`);

      setSplittingProgress('Creating size-based chunks...');
      const fileSizeMB = pendingSplitPdf.file.size / (1024 * 1024);
      const pagesPerMB = pendingSplitPdf.pageCount / fileSizeMB;
      const targetPagesPerChunk = Math.floor(pagesPerMB * 25);
      const chunks = await splitPdfIntoChunks(pendingSplitPdf.file, Math.max(50, targetPagesPerChunk));
      console.log(`✅ [PDF SPLIT] Created ${chunks.length} chunks`);

      setSplittingProgress('Preparing files for upload...');
      const urls = chunks.map(chunk => URL.createObjectURL(chunk));

      setFileStates(prev => {
        const newState = {
          ...prev,
          [pendingSplitPdf.layerId]: {
            files: [...(prev[pendingSplitPdf.layerId]?.files || []), ...chunks],
            fileUrls: [...(prev[pendingSplitPdf.layerId]?.fileUrls || []), ...urls]
          }
        };

        console.log('🗂️ [PDF SPLIT] FileState updated with chunks:', {
          layerId: pendingSplitPdf.layerId,
          totalFiles: newState[pendingSplitPdf.layerId].files.length,
          chunkNames: chunks.map(c => c.name)
        });

        return newState;
      });

      setSplittingProgress('Complete!');
      const avgSizeMB = (pendingSplitPdf.file.size / (1024 * 1024)) / chunks.length;
      window.alert(`PDF Split Complete\n\nSuccessfully split "${pendingSplitPdf.file.name}" into ${chunks.length} chunks (~${avgSizeMB.toFixed(1)}MB each).`);

    } catch (error) {
      console.error('❌ [PDF SPLIT] Error splitting PDF:', error);
      window.alert(`PDF Split Failed\n\nFailed to split PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setSplittingInProgress(false);
      setSplittingProgress('');
      setExpandedPdfOptions(null);
      setPendingSplitPdf(null);
    }
  };

  const handlePdfRangeExtract = async () => {
    if (!pendingSplitPdf) return;

    try {
      setSplittingInProgress(true);
      setSplittingProgress(`Loading PDF document...`);
      console.log(`🔄 [PDF RANGE] Extracting pages ${pdfRangeStart}-${pdfRangeEnd}...`);

      const pdfLibModule = await import('pdf-lib');
      const { PDFDocument } = pdfLibModule;

      setSplittingProgress(`Reading ${pendingSplitPdf.pageCount} pages...`);
      const arrayBuffer = await pendingSplitPdf.file.arrayBuffer();
      const pdfDoc = await PDFDocument.load(arrayBuffer);

      setSplittingProgress(`Extracting pages ${pdfRangeStart}-${pdfRangeEnd}...`);
      const newPdf = await PDFDocument.create();
      const pageIndices = [];

      for (let i = pdfRangeStart - 1; i < pdfRangeEnd && i < pdfDoc.getPageCount(); i++) {
        pageIndices.push(i);
      }

      const copiedPages = await newPdf.copyPages(pdfDoc, pageIndices);
      copiedPages.forEach((page) => newPdf.addPage(page));

      setSplittingProgress('Generating new PDF file...');
      const pdfBytes = await newPdf.save();
      const extractedFile = new File([pdfBytes],
        `${pendingSplitPdf.file.name.replace('.pdf', '')}_pages_${pdfRangeStart}-${pdfRangeEnd}.pdf`,
        { type: 'application/pdf' });

      setSplittingProgress('Preparing file for upload...');
      const url = URL.createObjectURL(extractedFile);

      setFileStates(prev => {
        const newState = {
          ...prev,
          [pendingSplitPdf.layerId]: {
            files: [...(prev[pendingSplitPdf.layerId]?.files || []), extractedFile],
            fileUrls: [...(prev[pendingSplitPdf.layerId]?.fileUrls || []), url]
          }
        };

        return newState;
      });

      setSplittingProgress('Complete!');
      window.alert(`PDF Range Extracted\n\nSuccessfully extracted pages ${pdfRangeStart}-${pdfRangeEnd} from "${pendingSplitPdf.file.name}".`);

    } catch (error) {
      console.error('❌ [PDF RANGE] Error extracting PDF range:', error);
      window.alert(`PDF Range Extraction Failed\n\nFailed to extract PDF range: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setSplittingInProgress(false);
      setSplittingProgress('');
      setExpandedPdfOptions(null);
      setPendingSplitPdf(null);
    }
  };

  const handlePdfSplitCancel = () => {
    console.log('❌ [PDF SPLIT] User cancelled PDF splitting');
    setExpandedPdfOptions(null);
    setPendingSplitPdf(null);
  };

  const handlePdfSplitRequest = () => {
    if (!pendingSplitPdf) return;

    const fileSizeMB = (pendingSplitPdf.file.size / (1024 * 1024)).toFixed(1);
    const confirmed = window.confirm(
      `This PDF is ${fileSizeMB}MB and exceeds the 30MB file size limit. Would you like to split it into smaller chunks for upload?\n\nClick "Cancel" to keep the original document (upload will fail).`
    );

    if (confirmed) {
      handlePdfSplitConfirm();
    } else {
      handlePdfSplitOriginal();
    }
  };

  const handlePdfSplitOriginal = async () => {
    if (!pendingSplitPdf) return;

    try {
      console.log('📄 [PDF SPLIT] User chose to keep original PDF');

      const url = URL.createObjectURL(pendingSplitPdf.file);

      setFileStates(prev => {
        const newState = {
          ...prev,
          [pendingSplitPdf.layerId]: {
            files: [...(prev[pendingSplitPdf.layerId]?.files || []), pendingSplitPdf.file],
            fileUrls: [...(prev[pendingSplitPdf.layerId]?.fileUrls || []), url]
          }
        };

        console.log('🗂️ [PDF SPLIT] FileState updated with original:', {
          layerId: pendingSplitPdf.layerId,
          totalFiles: newState[pendingSplitPdf.layerId].files.length,
          fileName: pendingSplitPdf.file.name
        });

        return newState;
      });

    } catch (error) {
      console.error('❌ [PDF SPLIT] Error adding original PDF:', error);
      showModal('error', 'Attachment Failed',
        `Failed to attach original PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setExpandedPdfOptions(null);
      setPendingSplitPdf(null);
    }
  };

  const isTestInputDisabled = (layer: Layer): boolean => {
    return !layer.userInstruction || layer.userInstruction.trim().length < 1;
  };

  const handleVersionChange = async (version: string) => {
    if (!versionedAgentData || !version) return;
    const loadSequence = ++versionLoadRef.current;
    runVersioning.invalidate();
    runAllManager.cancelExecution();
    runAbortRef.current?.abort();
    if (sharedBatchInputsRef.current) sharedBatchInputsRef.current.cancelled = true;
    autosaveScopeRef.current = { ...autosaveScopeRef.current };
    selectedVersionRef.current = version;

    try {
      const { getVersionLayers, getAgentVersionMetadata } = await import('../../../lib/versionUtils');
      if (versionLoadRef.current !== loadSequence) return;
      const versionLayers = getVersionLayers(versionedAgentData, version);
      const targetVersion = versionedAgentData.versions.find(candidate => candidate.version === version);

      if (targetVersion) {
        const agentToLoad = {
          name: targetVersion.name || versionedAgentData.agentName,
          layers: versionLayers,
          metadata: {
            ...getAgentVersionMetadata(versionedAgentData, version),
            modified: targetVersion.timestamp,
            currentVersion: version,
            totalVersions: versionedAgentData.totalVersions
          }
        };

        const { agent: migratedAgent } = migrateAgent(agentToLoad);
        if (migratedAgent.layers) {
          migratedAgent.layers = migratedAgent.layers.map(layer => ({
            ...layer,
            collection: layer.collection || undefined
          }));
        }

        setAgent(migratedAgent);
        setAgentName(stripDateSuffixFromAgentName(migratedAgent.name));
        setSelectedVersion(version);

        const corpusIds: Record<string, string> = {};
        const docSelections: Record<string, string[]> = {};
        const inputTabs: Record<string, 'text' | 'upload' | 'bibliography' | 'files' | 'papers' | 'corpus'> = {};
        for (const layer of migratedAgent.layers) {
          const resolvedCorpusId = resolveLayerCorpusIdShared(layer) || undefined;
          if (resolvedCorpusId) {
            corpusIds[layer.id] = resolvedCorpusId;
            const raw = layer.documentSelections ?? [];
            const hasBib = layer.bibliography && layer.bibliography.length > 0;
            if (hasBib && layer.bibliography) {
              const bibNames = new Set<string>();
              for (const b of layer.bibliography) {
                const fromPath = b.path?.split(/[/\\]/).pop()?.trim();
                const fromName = b.name?.trim();
                if (fromPath) bibNames.add(fromPath);
                if (fromName) bibNames.add(fromName);
              }
              const isInBib = (n: string) =>
                Array.from(bibNames).some(bn => n === bn || n.endsWith(bn) || n.includes(bn));
              docSelections[layer.id] = raw.filter(n => isInBib(n));
            } else {
              docSelections[layer.id] = raw;
            }
            inputTabs[layer.id] = 'corpus';
          }
        }
        captureVersionBaseline(migratedAgent, corpusIds, docSelections, inputTabs);
        setStepCorpusIds(corpusIds);
        setStepDocumentSelections(docSelections);
        setStepInputTab(prev => ({ ...prev, ...inputTabs }));

        const corpusDocsCache = new Map<string, Promise<StepCorpusDoc[]>>();
        const fetchCorpusDocuments = (cid: string) => {
          const cached = corpusDocsCache.get(cid);
          if (cached) return cached;
          const pidQuery = projectFolder?.projectId ? `?projectId=${encodeURIComponent(projectFolder.projectId)}` : '';
          const pending = fetch(`/api/rag/corpora/${encodeURIComponent(cid)}/documents${pidQuery}`, { credentials: 'include' })
            .then(r => (r.ok ? r.json() : null))
            .then((data: { documents?: StepCorpusDoc[] } | null) => data?.documents || []);
          corpusDocsCache.set(cid, pending);
          return pending;
        };
        for (const layer of migratedAgent.layers) {
          const resolvedCorpusId = resolveLayerCorpusIdShared(layer) || undefined;
          if (resolvedCorpusId) {
            setStepCorpusDocumentsLoading(prev => ({ ...prev, [layer.id]: true }));
            fetchCorpusDocuments(resolvedCorpusId)
              .then((docs) => {
                if (versionLoadRef.current !== loadSequence) return;
                setStepCorpusDocuments(prev => ({ ...prev, [layer.id]: docs }));
                const hasBib = layer.bibliography && layer.bibliography.length > 0;
                const bibNames = new Set<string>();
                if (hasBib && layer.bibliography) {
                  for (const b of layer.bibliography) {
                    const fromPath = b.path?.split(/[/\\]/).pop()?.trim();
                    const fromName = b.name?.trim();
                    if (fromPath) bibNames.add(fromPath);
                    if (fromName) bibNames.add(fromName);
                  }
                }
                const isInBib = (pdfName: string) =>
                  Array.from(bibNames).some(bn => pdfName === bn || pdfName.endsWith(bn) || pdfName.includes(bn));
                const serverSelections = Array.isArray(layer.documentSelections)
                  ? layer.documentSelections.filter((n): n is string => typeof n === 'string' && n.length > 0)
                  : [];
                let initialSelection: string[];
                if (serverSelections.length > 0) {
                  const resolution = resolveCorpusPdfNames(serverSelections, docs);
                  if (resolution.unmatched.length > 0) {
                    console.warn(
                      `⚠️ [Corpus] (version switch) step "${layer.name}": ${resolution.unmatched.length} persisted doc selection(s) did not match any live corpus pdf_name after normalisation; sending them verbatim.`,
                      { unmatched: resolution.unmatched, liveDocCount: docs.length },
                    );
                  }
                  initialSelection = resolution.resolved;
                } else {
                  initialSelection = hasBib
                    ? docs.filter(d => isInBib(d.pdfName)).map(d => d.pdfName)
                    : docs.map(d => d.pdfName);
                }
                const baselineLayer = versionBaselineRef.current?.layers.find(candidate => candidate.id === layer.id);
                if (baselineLayer) baselineLayer.documentSelections = [...initialSelection];
                setStepDocumentSelections(prev => ({ ...prev, [layer.id]: initialSelection }));
              })
              .catch(() => setStepCorpusDocuments(prev => ({ ...prev, [layer.id]: [] })))
              .finally(() => setStepCorpusDocumentsLoading(prev => ({ ...prev, [layer.id]: false })));
          }
        }
      }
    } catch (error) {
      console.error('Error switching version:', error);
      alert('Failed to switch version');
    }
  };

  const handlePersonaInstructionPopupShow = (layerId: string) => {
    setPersonaInstructionPopupVisible(prev => ({ ...prev, [layerId]: true }));
  };

  const handlePersonaInstructionPopupClose = (layerId: string) => {
    setPersonaInstructionPopupVisible(prev => ({ ...prev, [layerId]: false }));
  };

  const handlePersonaInstructionSelect = (layerId: string, instruction: string) => {
    updateStep(layerId, 'systemInstruction', instruction);
    handlePersonaInstructionPopupClose(layerId);
  };

  const runStepQc = async (layerId: string, resultText?: string) => {
    const corpusId = stepCorpusIds[layerId];
    const textToVerify =
      resultText?.trim() ||
      agentRef.current?.layers.find(l => l.id === layerId)?.result?.trim();
    if (!textToVerify || !corpusId) return;

    setStepQcPhase(prev => ({ ...prev, [layerId]: 'extracting' }));
    setStepQcError(prev => ({ ...prev, [layerId]: null }));
    setStepQcExtractedClaims(prev => ({ ...prev, [layerId]: [] }));
    setStepQcSelectedClaims(prev => ({ ...prev, [layerId]: [] }));
    setStepQcRows(prev => ({ ...prev, [layerId]: [] }));

    try {
      const res = await fetch('/api/ai-agents/step-qc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'extract', corpusId, generatedText: textToVerify }) });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
      }

      const data = await res.json() as { claims: string[]; message?: string };
      const claims = data.claims ?? [];

      if (claims.length === 0) {
        setStepQcPhase(prev => ({ ...prev, [layerId]: 'done' }));
        setStepQcError(prev => ({ ...prev, [layerId]: '__no_claims__' }));
        return;
      }

      setStepQcExtractedClaims(prev => ({ ...prev, [layerId]: claims }));
      setStepQcSelectedClaims(prev => ({ ...prev, [layerId]: claims.map((_, i) => i) }));
      setStepQcPhase(prev => ({ ...prev, [layerId]: 'selecting' }));
    } catch (err) {
      setStepQcError(prev => ({
        ...prev,
        [layerId]: err instanceof Error ? err.message : 'Claim extraction failed' }));
      setStepQcPhase(prev => ({ ...prev, [layerId]: 'idle' }));
    }
  };

  const verifySelectedClaims = async (layerId: string) => {
    const corpusId = stepCorpusIds[layerId];
    const allClaims    = stepQcExtractedClaims[layerId] ?? [];
    const selectedIdxs = stepQcSelectedClaims[layerId]  ?? [];
    const claimsToVerify = selectedIdxs.map(i => allClaims[i]).filter(Boolean);

    if (!corpusId || claimsToVerify.length === 0) return;

    setStepQcPhase(prev => ({ ...prev, [layerId]: 'verifying' }));
    setStepQcRunning(prev => ({ ...prev, [layerId]: true }));
    setStepQcError(prev => ({ ...prev, [layerId]: null }));

    const pendingRows: QcRow[] = claimsToVerify.map(claim => ({
      claim,
      status: 'PENDING',
      action: '',
      ragLocation: null,
      rationale: '',
      sourceDoc: '' }));
    setStepQcRows(prev => ({ ...prev, [layerId]: pendingRows }));

    try {
      const res = await fetch('/api/ai-agents/step-qc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'verify', corpusId, claims: claimsToVerify }) });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(text || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed) as
              | { type: 'row';   row: QcRow }
              | { type: 'done' }
              | { type: 'error'; error: string };

            if (event.type === 'row') {
              setStepQcRows(prev => {
                const existing = prev[layerId] ?? [];
                const idx = existing.findIndex(
                  r => r.claim === event.row.claim && r.status === 'PENDING'
                );
                if (idx === -1) return { ...prev, [layerId]: [...existing, event.row] };
                const updated = [...existing];
                updated[idx] = event.row;
                return { ...prev, [layerId]: updated };
              });
            } else if (event.type === 'error') {
              throw new Error(event.error);
            }
          } catch {
          }
        }
      }
      setStepQcPhase(prev => ({ ...prev, [layerId]: 'done' }));
    } catch (err) {
      setStepQcError(prev => ({
        ...prev,
        [layerId]: err instanceof Error ? err.message : 'QC verification failed' }));
      setStepQcPhase(prev => ({ ...prev, [layerId]: 'selecting' }));
    } finally {
      setStepQcRunning(prev => ({ ...prev, [layerId]: false }));
    }
  };

  const executeStep = async (layerId: string, versionRun: AgentVersionRun): Promise<boolean | undefined> => {
    const currentAgent = versionRun.snapshot as AgentData;
    if (!runVersioning.isRunCurrent(versionRun)) return;

    const layer = currentAgent.layers.find(l => l.id === layerId);
    if (!layer || isStepRunning(layerId)) return;

    if (!layer.userInstruction?.trim()) {
      alert('Please enter a user instruction for this step before running it.');
      return;
    }

    if (!startExecution(layerId)) {
      alert('Another step is currently executing. Please wait for it to complete.');
      return;
    }

    const startedAt = new Date().toISOString();
    const model = isValidModel(layer.selectedModel) ? layer.selectedModel : DEFAULT_MODEL;
    const controller = new AbortController();
    runAbortRef.current = controller;
    if (layer.lastRunDiagnostics) updateEditorLayer(layerId, { lastRunDiagnostics: undefined });
    let pendingQcResponse = '';
    let succeeded = false;

    try {
      if (isGalileoModel(model)) await assertStepModelReady(model, controller.signal);
      const sharedInputs = hasAgentInputs(currentAgent.metadata) ? await prepareAgentInputSnapshot(currentAgent.metadata, controller.signal) : null;
      const activeInputTab = stepInputTab[layerId] || 'text';

      const refContext = buildReferencedStepsContext(layer.referencedSteps, {
        getName: (refId) => currentAgent.layers.find(l => l.id === refId)?.name,
        getResult: (refId) => {
          const ref = currentAgent.layers.find(l => l.id === refId);
          return typeof ref?.result === 'string' && ref.result ? ref.result : undefined;
        } });

      let currentStepContext = sharedInputs ? refContext.text : '';
      if (activeInputTab === 'text') {
        if (!sharedInputs) currentStepContext += refContext.text;
        if (layer.collection && layer.collection > 0) {
          const collectionContent = fetchCollectionContent(layer.collection);
          if (collectionContent && collectionContent !== 'Collection is empty') {
            currentStepContext += `Collection ${layer.collection} Content:\n${collectionContent}\n\n`;
          }
        }
      }

      const fileState = fileStates[layerId];
      const localInputs = getActiveStepInputs(activeInputTab, fileState?.files ?? [], stepCorpusIds[layerId], stepDocumentSelections[layerId], layer.ragKnowledge, projectFolder?.projectId);
      if (sharedInputs && localInputs.corpora.length && !(stepDocumentSelections[layerId]?.length) && stepCorpusDocuments[layerId]?.some(document => document.state !== 'FAILED')) {
        throw new Error('No documents selected in the step corpus. Select at least one document to run.');
      }

      if (preprocessingEnabled[layerId]) {
        setPreprocessingResults(prev => ({ ...prev, [layerId]: {} }));

        const hasFiles = (activeInputTab === 'upload' || activeInputTab === 'files') && fileState?.files && fileState.files.length > 0;

        if (hasFiles) {
          try {
            const preprocessingPrompt = createPreprocessingDataExtractionPrompt(layer);
            const preprocessingMessages = [{ role: 'user', text: preprocessingPrompt }];

            const preprocessingFormData = new FormData();
            fileState!.files.forEach((file, index) => {
              if (file && file.size > 0) preprocessingFormData.append(`file${index}`, file);
            });
            preprocessingFormData.append('messages', JSON.stringify(preprocessingMessages));
            preprocessingFormData.append('model', DEFAULT_MODEL);

            const preprocessingRes = await fetch('/api/gemini', {
              method: 'POST',
              body: preprocessingFormData, signal: controller.signal });

            if (preprocessingRes.ok) {
              const preprocessingData = await preprocessingRes.json();
              const extractedData = (preprocessingData.response as string)?.trim();
              if (extractedData && extractedData !== 'Extraction (by page): None') {
                setPreprocessingResults(prev => ({
                  ...prev,
                  [layerId]: { ...prev[layerId], document: extractedData } }));
                currentStepContext += `\n=== DOCUMENT STRUCTURED DATA ===\n${extractedData}\n\n`;
              }
            }
          } catch (error) {
            console.warn('Document preprocessing failed:', error);
          }
        }

        try {
          const promptSource = [
            layer.systemInstruction?.trim() && `System Instruction:\n${layer.systemInstruction.trim()}`,
            layer.userInstruction?.trim() && `User Instruction:\n${layer.userInstruction.trim()}`,
            layer.userInput?.trim() && `User Input:\n${layer.userInput.trim()}`,
          ].filter(Boolean).join('\n\n');

          if (promptSource) {
            const promptPreprocessRes = await fetch('/api/gemini', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                messages: [{ role: 'user', text: createPromptPreprocessingPrompt(promptSource) }],
                model: DEFAULT_MODEL }), signal: controller.signal });

            if (promptPreprocessRes.ok) {
              const promptPreprocessData = await promptPreprocessRes.json();
              const extractedData = (promptPreprocessData.response as string)?.trim();
              if (extractedData && extractedData !== 'Extraction: None') {
                setPreprocessingResults(prev => ({
                  ...prev,
                  [layerId]: { ...prev[layerId], prompt: extractedData } }));
                currentStepContext += `\n=== PROMPT STRUCTURED DATA ===\n${extractedData}\n\n`;
              }
            }
          }
        } catch (error) {
          console.warn('Prompt preprocessing extraction failed:', error);
        }
      }

      const agentSkillTexts = skillsLib.resolveTexts(agentRef.current?.metadata?.skillIds);
      const { messages, systemInstruction } = buildStepMessagesPayload(layer, currentStepContext, agentSkillTexts);
      const sharedBody = { model, messages, systemInstruction, projectId: projectFolder?.projectId,
        ragKnowledge: localInputs.ragKnowledge, ...getGalileoGenerationSettings(model, layer),
        includeThoughts: Boolean(stepIncludeThoughts[layerId]), thinkingLevel: stepThinkingLevel[layerId] ?? 'low', optimizeQuery: Boolean(stepOptimizeQuery[layerId]) };

      if (isImageModel(layer.selectedModel)) {
        // Base image: an uploaded image on this step, else the first generated
        // image among referenced upstream steps.
        let base: InlineImage | null = null;
        const uploadedImage = fileState?.files?.find((f) => f && f.type.startsWith('image/'));
        if (uploadedImage) {
          base = await fileToBase64(uploadedImage);
        } else {
          for (const refId of layer.referencedSteps ?? []) {
            const ref = currentAgent.layers.find((l) => l.id === refId);
            const refImage = ref ? getLayerImageUrls(ref)[0] : undefined;
            if (refImage) {
              base = dataUrlToInlineData(refImage);
              if (base) break;
            }
          }
        }
        const { imageUrls, text } = await generateStepImages({
          prompt: sharedInputs ? await prepareAgentImagePrompt(sharedInputs, sharedBody, localInputs.files, localInputs.corpora, controller.signal) : buildStepImagePrompt(messages, systemInstruction),
          model: layer.selectedModel as string,
          base,
        });
        if (controller.signal.aborted || runAbortRef.current !== controller) throw new DOMException('Step cancelled', 'AbortError');
        updateEditorLayer(layerId, { result: text ?? '', imageUrls });
        return true;
      }

      let res;

      const selectedCorpusId = stepCorpusIds[layerId];
      const useCorpus = activeInputTab === 'corpus' && selectedCorpusId;
      const useUpload = (activeInputTab === 'upload' || activeInputTab === 'bibliography' || activeInputTab === 'files') && fileState?.files != null && fileState.files.length > 0;
      const useBibliography = activeInputTab === 'bibliography' && layer.ragKnowledge && layer.ragKnowledge.length > 0;
      const useFilesOrPapers = (activeInputTab === 'files' || activeInputTab === 'papers') && layer.ragKnowledge && layer.ragKnowledge.length > 0;

      if (sharedInputs) {
        res = await fetchWithAgentInputs(sharedInputs, sharedBody, localInputs.files, localInputs.corpora, controller.signal);
      } else if (useCorpus) {
        const checkedDocs = stepDocumentSelections[layerId] || [];
        const allCorpusDocs = (stepCorpusDocuments[layerId] || []).filter(d => d.state !== 'FAILED');

        if (checkedDocs.length === 0 && allCorpusDocs.length > 0) {
          throw new Error('No documents selected in corpus. Select at least one document to run.');
        }

        // Resolve the subset filter on the stable file_id (falls back to pdf_name for
        // pre-file_id corpora). `block` = the selection matches nothing in this corpus
        // (fail fast, don't let the model loop for minutes on a dead filter).
        const subset = resolveSubsetFilter(checkedDocs, allCorpusDocs);
        if (subset.action === 'block') {
          throw new Error('Selected documents are not in this corpus (metadata mismatch). Re-select the documents, or open the RAG Knowledge Manager to Verify and self-heal this corpus.');
        }
        const metadataFilter = subset.filter;

        const ragSystemInstructionParts: string[] = [];
        if (layer.userInstruction?.trim()) ragSystemInstructionParts.push(layer.userInstruction.trim());
        if (layer.systemInstruction?.trim()) ragSystemInstructionParts.push(layer.systemInstruction.trim());
        if (refContext.text) ragSystemInstructionParts.push(refContext.text);
        const ragSystemInstruction = combineSkillsWithSystemInstruction(ragSystemInstructionParts.join('\n\n'), agentSkillTexts) || undefined;

        console.log(
          `📁 [Corpus][RunStep] step="${layer.name}" corpusId=${selectedCorpusId} ` +
          `filterAction=${subset.action} checkedDocs=${checkedDocs.length}/${allCorpusDocs.length} ` +
          `refSteps=${refContext.stepsIncluded} refBytes=${refContext.bytes} ` +
          `refTruncated=${refContext.truncated} filter=${metadataFilter ?? 'none'}`,
        );
        if (subset.filter) {
          console.log(`📁 [Corpus][RunStep] narrowed file list:`, checkedDocs);
        }

        // Send the selected corpus id first, then every other candidate the layer
        // could refer to — a stale primary id no longer 404s / hits an empty store.
        // For a cross-user corpus, also forward its exact Gemini store name (known from
        // the project link list) so the server resolves it without fuzzy name matching.
        const runStoreName = resolveStoreNameFromLinks(projectCorpusLinks, selectedCorpusId);
        const corpusIds = Array.from(new Set([
          selectedCorpusId,
          ...collectCorpusIdCandidatesFromLayer(layer),
          ...(runStoreName ? [runStoreName] : []),
        ].filter(Boolean)));
        res = await fetch(getStepEndpoint(model, true), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            corpusId: selectedCorpusId,
            corpusIds,
            // Corpus display-name hints from the layer JSON — let the server resolve a
            // corpus owned by another user (dev or project-member gated) when its id
            // isn't in the caller's own registry.
            corpusDisplayHints: collectLayerCorpusDisplayHints(layer),
            // The project this agent lives in — the server authorizes cross-user corpus
            // resolution for members of this project (verified via Drive sharing).
            projectId: projectFolder?.projectId,
            messages,
            systemInstruction: ragSystemInstruction,
            model: isValidModel(layer.selectedModel) ? layer.selectedModel : DEFAULT_MODEL,
            metadataFilter,
            // Reasoning checkbox → whether the model's reasoning trace is returned.
            // Thinking dropdown → how hard it thinks (depth). Two separate controls.
            includeThoughts: Boolean(stepIncludeThoughts[layerId]),
            ...getGalileoGenerationSettings(model, layer),
            thinkingLevel: stepThinkingLevel[layerId] ?? 'low',
            optimizeQuery: Boolean(stepOptimizeQuery[layerId]) }),
          credentials: 'include',
          signal: controller.signal });
      } else {

      if (useUpload) {
        for (const file of fileState.files) {
          if (file.type === 'application/pdf') {
            const fileSizeMB = file.size / (1024 * 1024);
            if (fileSizeMB > 30) {
              console.error(`❌ [PDF PREFLIGHT] PDF ${file.name} is ${fileSizeMB.toFixed(1)}MB (>30MB), should have been split`);
              throw new Error(`PDF "${file.name}" is ${fileSizeMB.toFixed(1)}MB and exceeds the 30MB limit. Please split the file before processing.`);
            }
          }
        }

        const formData = new FormData();

        fileState.files.forEach((file, index) => {
          if (file && file.size > 0) {
            formData.append(`file${index}`, file);
          }
        });

        const shouldReplaceExisting = fileState.files.some(file => hasReplaceExistingFlag(file));
        if (shouldReplaceExisting) {
          console.log('🔄 [Agent] Including replaceExistingRAG flag for step execution');
          formData.append('replaceExistingRAG', 'true');
        }

        formData.append('messages', JSON.stringify(messages));
        formData.append('model', isValidModel(layer.selectedModel) ? layer.selectedModel : DEFAULT_MODEL);
        for (const [key, value] of Object.entries(getGalileoGenerationSettings(model, layer))) formData.append(key, JSON.stringify(value));
        if (systemInstruction) {
          formData.append('systemInstruction', JSON.stringify(systemInstruction));
        }

        if ((useBibliography || useFilesOrPapers) && layer.ragKnowledge?.length) {
          console.log(`✅ [Agent FormData] Attaching ${layer.ragKnowledge.length} RAG items to FormData:`);
          layer.ragKnowledge.forEach((item, index) => {
            console.log(`   📄 [Agent FormData] RAG Item ${index + 1}:`, {
              id: item.id,
              filename: item.filename,
              theme: item.theme
            });
          });

          const ragJson = JSON.stringify(layer.ragKnowledge);
          console.log(`📦 [Agent FormData] RAG JSON string length: ${ragJson.length}`);
          console.log(`📦 [Agent FormData] RAG JSON preview:`, ragJson.substring(0, 200) + '...');

          formData.append('ragKnowledge', ragJson);
        }

        if (projectFolder?.projectId) {
          formData.append('projectId', projectFolder.projectId);
          console.log(`[Pre-processing] Adding current project ID to request: ${projectFolder.projectId}`);
        } else {
          console.warn('[Pre-processing] No current project ID available for RAG processing');
        }

        res = await fetch(getStepEndpoint(model), {
          method: 'POST',
          body: formData, signal: controller.signal });
      } else {
        res = await fetch(getStepEndpoint(model), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: isValidModel(layer.selectedModel) ? layer.selectedModel : DEFAULT_MODEL,
            messages,
            systemInstruction,
            ...getGalileoGenerationSettings(model, layer),
            ...(isGalileoModel(model) ? { projectId: projectFolder?.projectId } : {}),
            ragKnowledge: (useBibliography || useFilesOrPapers) ? (layer.ragKnowledge || []) : []
          }), signal: controller.signal });
      }

      }

      const data = await readStepRunResponse(res, Boolean(useCorpus) && !isGalileoModel(model), model);
      if (controller.signal.aborted || runAbortRef.current !== controller) throw new DOMException('Step cancelled', 'AbortError');
      const response = data.response?.trim() || '';

      if (useCorpus) {
        const chunks = data.groundingChunks?.length ?? 0;
        if (response.length > 0 && data.isGrounded) {
          console.log(`✅ [Step "${layer.name}"] RAG: ${response.length} chars | grounded | ${chunks} chunk(s)`);
        } else {
          console.warn(`⚠️ [Step "${layer.name}"] RAG returned empty/ungrounded response`);
          console.warn(`   isGrounded : ${data.isGrounded}`);
          console.warn(`   chunks     : ${chunks}`);
          console.warn(`   chars      : ${response.length}`);
          console.warn(`   corpusId   : ${selectedCorpusId}`);
          console.warn(`   query (first 300): "${messages[0]?.text?.substring(0, 300)}"`);
        }
      }

      const resultToStore = (useCorpus && !response)
        ? `⚠️ **No relevant content found in the corpus for this query.**\n\n` +
          `**Diagnostics:**\n` +
          `- isGrounded: ${data.isGrounded ?? 'N/A'}\n` +
          `- Grounding chunks: ${data.groundingChunks?.length ?? 0}\n\n` +
          `*Possible causes: the file search store is still indexing, the query doesn't match ` +
          `any document content, or the selected document filter is too narrow.*`
        : filterAIResponseSections(response);

      updateEditorLayer(layerId, {
        result: resultToStore,
        debugInfo: buildStepDebugInfo(data, isValidModel(layer.selectedModel) ? layer.selectedModel : DEFAULT_MODEL),
        ...(data.runDiagnostics ? { lastRunDiagnostics: data.runDiagnostics } : {}),
      });

      pendingQcResponse = (useCorpus && !response) ? '' : resultToStore;
      succeeded = true;

    } catch (error) {
      if (runAbortRef.current !== controller) return;
      const diagnostics = getStepFailureDiagnostics(error, model, startedAt);
      if (diagnostics) updateEditorLayer(layerId, { lastRunDiagnostics: diagnostics });
      // User Stop / cancel aborted the in-flight query — not a failure, no alert.
      if (error instanceof Error && error.name === 'AbortError') {
        console.log(`🛑 Step "${layer.name}" run aborted`);
        return;
      }
      console.error(`❌ Error running step ${layer.name}:`, error);

      const errorText = error instanceof Error ? error.message : 'Unknown error';

      let alertMessage = `Failed to run step "${layer.name}". Please check your settings and try again.\n\nError: ${errorText}`;

      if (errorText.includes('exceeds the supported page limit') ||
        errorText.includes('pages which exceeds') ||
        errorText.includes('page limit')) {
        const pageMatch = errorText.match(/(\d+)\s*pages.*(?:exceeds|exceed).*(?:page\s*)?limit.*?(?:of\s*)?(\d+)/) ||
          errorText.match(/document contains (\d+) pages.*exceeds.*limit.*?(\d+)/);
        const currentPages = pageMatch ? pageMatch[1] : 'Unknown';
        const maxPages = pageMatch ? pageMatch[2] : '1000';

        alertMessage = `Document Too Large\n\nYour document contains ${currentPages} pages, which exceeds the maximum limit of ${maxPages} pages.\n\nPlease split your document into smaller files or reduce the page count to continue.`;
      }
      else if (errorText.includes('INVALID_ARGUMENT') || errorText.includes('invalid format')) {
        alertMessage = `Invalid File Format\n\nThe uploaded file format is not supported.\n\nPlease ensure you are uploading a valid PDF, image, or text file.`;
      }
      else if (isStepSessionFailure(error)) {
        alertMessage = `Authentication Error\n\nYour session has expired or authentication failed.\n\nPlease refresh the page and sign in again.`;
      }
      else if (errorText.includes('429') || errorText.includes('rate limit') || errorText.includes('quota')) {
        alertMessage = `Rate Limit Exceeded\n\nToo many requests have been made recently.\n\nPlease wait a few minutes before trying again.`;
      }

      alert(alertMessage);

      failExecution(layerId, error instanceof Error ? error : new Error(errorText));
    } finally {
      if (runAbortRef.current === controller) {
        runAbortRef.current = null;
        completeExecution(layerId);
      }
    }

    await new Promise<void>(r => setTimeout(r, 0));

    if (runVersioning.isRunCurrent(versionRun) && pendingQcResponse && stepQcEnabled[layerId] && stepCorpusIds[layerId]) {
      runStepQc(layerId, pendingQcResponse);
    }
    return succeeded;
  };

  const runStep = async (layerId: string) => {
    if (savingRef.current) return;
    const versionRun = runVersioning.beginRun([layerId]);
    if (!versionRun) return;
    let succeeded = false;
    try {
      succeeded = await executeStep(layerId, versionRun) === true;
    } finally {
      await runVersioning.completeRun(versionRun, {
        successful: succeeded ? [layerId] : [],
        failed: [],
        cancelled: !runVersioning.isRunCurrent(versionRun),
      });
    }
  };

  const handleRunAllSteps = async () => {
    if (savingRef.current) return;
    if (!agent || !agent.layers.length) {
      alert('No steps to run. Please add some steps first.');
      return;
    }

    if (isAnyStepRunning || runAllManager.isRunning) {
      alert('Cannot start run all while another step is running. Please wait for it to complete.');
      return;
    }

    const versionRun = runVersioning.beginRun(agent.layers.map(layer => layer.id));
    if (!versionRun) return;
    runAllVersionRef.current = versionRun;
    setShowRunAllProgress(true);
    const batchInputs = { metadata: snapshotAgentInputMetadata(versionRun.snapshot.metadata), cancelled: false };
    sharedBatchInputsRef.current = batchInputs;

    try {
      const outcome = await runAllManager.runAllSteps(versionRun.snapshot.layers as Layer[]);
      await runVersioning.completeRun(versionRun, outcome);
    } catch (error) {
      await runVersioning.completeRun(versionRun, { successful: [], failed: [], cancelled: true });
      console.error('Run all steps error:', error);
    } finally {
      if (runAllVersionRef.current === versionRun) {
        runAllVersionRef.current = null;
        setShowRunAllProgress(false);
      }
      if (sharedBatchInputsRef.current === batchInputs) sharedBatchInputsRef.current = null;
    }
  };

  const runAllAutoFiredRef = useRef(false);
  useEffect(() => {
    if (!runAllOnLoad) return;
    if (runAllAutoFiredRef.current) return;
    if (!agent || !agent.layers || agent.layers.length === 0) return;
    if (isAnyStepRunning || runAllManager.isRunning) return;
    runAllAutoFiredRef.current = true;
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('runAll');
      router.replace(url.pathname + (url.search ? url.search : '') + url.hash);
    }
    void handleRunAllSteps();
  }, [runAllOnLoad, agent, isAnyStepRunning, runAllManager.isRunning]);

  const createIntrospectionPrompt = (layer: Layer, fileNames: string[], previousStepSummary: string = 'N/A'): string => {
    return `You are an expert AI evaluator. Critically analyze this AI agent step execution:

## STEP CONTEXT
- **Step Name**: ${layer.name}
- **Step Type**: ${layer.type}
- **User Instruction**: ${layer.userInstruction}
- **System Instruction**: ${layer.systemInstruction || 'None'}
- **User Input**: ${layer.userInput || 'None'}
- **Files Provided**: ${fileNames.length > 0 ? fileNames.join(', ') : 'None'}
- **Output Type**: ${layer.outputType || 'basic'}
- **AI Model**: ${isValidModel(layer.selectedModel) ? layer.selectedModel : DEFAULT_MODEL}
- **Previous Step**: ${previousStepSummary}

## ACTUAL OUTPUT
${layer.result}

## ANALYSIS REQUIRED
Provide a structured critical analysis:

**1. QUALITY ASSESSMENT (Score 1-10)**

- **Relevance to Prompt**: How well does the output address the given prompt?
- **Completeness**: Is the response complete and comprehensive?
- **Accuracy**: Is the information factually correct and reliable?
- **Format Compliance**: Does it match the declared output type (${layer.outputType || 'basic'})?
- **Overall Quality Score**: /10

**2. STRENGTHS**

- What was executed well in this response?
- Effective elements and good practices identified

**3. WEAKNESSES**

- Missing information or incomplete aspects
- Potential errors, inaccuracies, or inconsistencies
- Areas that could be improved

**4. INPUT USAGE EVALUATION**

- **System Instruction**: ${layer.systemInstruction ? 'Was it followed properly?' : 'None provided'}
- **User Input**: ${layer.userInput ? 'Was it used appropriately?' : 'None provided'}
- **Files**: ${fileNames.length > 0 ? 'Were the provided files properly referenced?' : 'None provided'}

**5. RECOMMENDATIONS**

- **Prompt Refinement**: Specific suggestions to improve the prompt
- **Input Optimization**: How to better structure user inputs
- **System Instruction**: Improvements for system-level guidance
- **Expected Improvements**: What better outcomes to expect

**6. OVERALL VERDICT**
**Is this output satisfactory for its intended purpose?** Provide a clear yes/no with brief reasoning.

Be critical but constructive. Focus on actionable insights that will help improve future iterations.

**IMPORTANT: Provide only your analysis. Do not repeat or reference this prompt in your response.**`;
  };

  const createDeepIntrospectionPrompt = (layer: Layer, fileNames: string[]): string => {
    return `You are conducting an independent, deeply critical introspection of this AI agent step execution.

## STEP CONTEXT
- **Step Name**: ${layer.name}
- **Step Type**: ${layer.type}
- **User Instruction**: ${layer.userInstruction}
- **System Instruction**: ${layer.systemInstruction || 'None'}
- **User Input**: ${layer.userInput || 'None'}
- **Files Provided**: ${fileNames.length > 0 ? fileNames.join(', ') : 'None'}
- **AI Model**: ${isValidModel(layer.selectedModel) ? layer.selectedModel : DEFAULT_MODEL}

## ACTUAL OUTPUT
${layer.result}

## DEEP INTROSPECTION METHODOLOGY

**Introspection Philosophy**

My previous failure stemmed from a rush to judgment and a lack of skepticism towards my own solutions. I saw a result that partially confirmed my hypothesis and failed to question why it wasn't a complete success. This demonstrates a clear confirmation bias. Going forward, I will treat every backtest result—especially mixed ones—as a new puzzle, not as a validation. The process must be: Hypothesize -> Implement -> Test -> Critically Analyze All Outcomes -> Refine. This structured approach is essential for building a truly robust system.

**REQUIRED ANALYSIS STEPS**

**[ ] RE-READ WHAT YOU WROTE**

- Carefully re-examine your initial assessment of this output
- What assumptions did I make?
- What biases influenced my evaluation?

**[ ] IDENTIFY THE MISTAKES (Bullet Points)**

- List specific errors or oversights in your analysis approach
- Point out confirmation bias instances
- Highlight areas where criticism was insufficient

**[ ] PROPOSE SOLUTION**

- Based on identified mistakes, what should be done differently?
- How can the evaluation process be improved?
- What additional criteria should be considered?

**[ ] BE CRITICAL OF YOUR PROPOSED SOLUTION**

- What are the weaknesses of your proposed solution?
- What could go wrong with this approach?
- What am I potentially missing again?

**[ ] REFINE THE SOLUTION BASED ON CRITICISM**

- Address the criticisms of your solution
- Create a more robust, comprehensive approach
- Consider edge cases and failure modes

**[ ] INTROSPECTION STEP**

- Reflect on this entire second analysis process
- How has your understanding evolved?
- What patterns of thinking need to change?

**[ ] FINAL ANSWER**
- Provide the refined, critically-examined assessment
- Include specific, actionable recommendations
- State confidence level and remaining uncertainties

Be ruthlessly self-critical. Question every assumption. Challenge every conclusion.

**IMPORTANT: Provide only your deep introspection analysis. Do not repeat or reference this prompt in your response. Start directly with your analysis.**`;
  };

  const createUserRequestReinterpretationPrompt = (layer: Layer, fileNames: string[]): string => {
    return `## ${layer.name || 'Unnamed Step'} — USER REQUEST RE-INTERPRETATION (Non-Interactive)

System Instruction: ${layer.systemInstruction || 'None'}

Self-reflection:
- I am a fallible, biased, and overly agreeable model that can overfit to common patterns and cut corners. I will slow down, surface assumptions, and deliberately consider plausible edge cases before finalizing the interpretation.

Do not answer the question yet. Perform an introspective understanding check.

Instructions:
- Restate the user's request in one plain, neutral sentence without adding new facts.
- Avoid "most common" interpretations only; consider edge/outlier but plausible meanings.
- Identify assumptions and how you reduced bias.
- Give an understanding confidence (0–100%).

## USER'S ORIGINAL REQUEST
${layer.userInstruction}

## USER INPUT PROVIDED
${layer.userInput || 'None'}

## FILES PROVIDED
${fileNames.length > 0 ? fileNames.join(', ') : 'None'}

Output exactly in this format:

The user wants: <one-sentence restatement>

Plausible alternatives (incl. outliers):
- <alt 1>
- <alt 2> (optional)

Assumptions I might be making: <list or "none">
How I mitigated them: <brief note>
Understanding confidence: <0–100%>

**IMPORTANT: Follow the exact format above. Do not add explanations or repeat this prompt.**`;
  };

  const createDataExtractionPrompt = (layer: Layer, fileNames: string[]): string => {
    return `## ${layer.name || 'Unnamed Step'} — PAGE-ORGANIZED DATA/TABLE/FIGURE EXTRACTION (Non-Interactive)

System Instruction: ${layer.systemInstruction || 'None'}

Goal:
- Extract all **data**, **tables**, and **figures** strictly **by page**.
- Scientific rigor: **preserve as printed** — exact decimal positions, trailing zeros, decimal separators (dot/comma), units, inequality signs (<, ≤, >, ≥), ranges, approximate symbols (~, ≈), uncertainties (±), confidence intervals, sample sizes (n), p-values, and scientific notation ("×10^n", "e" notation). **Do not round, normalize, convert units, or infer missing values.**

Instructions:
- Process the document sequentially by page number.
- For each page, list tables, figures, and key data points. If none, write "None".
- Tables: include a brief description; reproduce in Markdown keeping original headers, order, units, footnotes, and numeric precision (including trailing zeros and exponent notation).
- Figures: capture caption/label and a one-sentence description; include any legend/notes verbatim if present.
- Key Data Points: transcribe variable name, value **exactly as printed**, and unit; include a short source snippet in quotes when available.
- If a table/figure spans pages, note "(continues on page X)" and keep under the starting page with a cross-reference.
- Do not ask questions or provide analysis or conclusions.

## USER'S ORIGINAL REQUEST
${layer.userInstruction}

## USER INPUT PROVIDED
${layer.userInput || 'None'}

## FILES PROVIDED
${fileNames.length > 0 ? fileNames.join(', ') : 'None'}

Output exactly in this schema:

Extraction (by page):
- Page <number>:
  - Tables:
    - [Label or "Table <n>" if unlabeled]: <1-sentence description>
      - Markdown:
        | Column 1 | Column 2 | ... |
        |---|---|---|
        | ... | ... | ... |
      - Footnotes/Notes: <verbatim or "None">
  - Figures:
    - [Caption or "Figure <n>" if unlabeled]: <1-sentence description>
      - Notes/Legend: <verbatim or "None">
  - Key Data Points:
    - <metric/variable>: <value exactly as printed> <unit> (source: "…")
    - <metric/variable>: <value exactly as printed> <unit> (source: "…")

- Page <number>:
  - Tables:
    - ...
  - Figures:
    - ...
  - Key Data Points:
    - ...

If no page-indexed artifacts are available:
Extraction (by page): None

**IMPORTANT: Follow the exact schema above. Preserve all numerical precision exactly as printed. Do not repeat this prompt.**`;
  };

  const createPreprocessingDataExtractionPrompt = (layer: Layer): string => {
    return `## ${layer.name || 'Unnamed Step'} — PAGE-ORGANIZED DATA/TABLE/FIGURE EXTRACTION (Non-Interactive)

System Instruction: ${layer.systemInstruction || 'None'}

Goal:
- Extract all **data**, **tables**, and **figures** strictly **by page**.
- Scientific rigor: **preserve as printed** — exact decimal positions, trailing zeros, decimal separators (dot/comma), units, inequality signs (<, ≤, >, ≥), ranges, approximate symbols (~, ≈), uncertainties (±), confidence intervals, sample sizes (n), p-values, and scientific notation ("×10^n", "e" notation). **Do not round, normalize, convert units, or infer missing values.**

Instructions:
- Process the document sequentially by page number.
- For each page, list tables, figures, and key data points. If none, write "None".
- Tables: include a brief description; reproduce in Markdown keeping original headers, order, units, footnotes, and numeric precision (including trailing zeros and exponent notation).
- Figures: capture caption/label and a one-sentence description; include any legend/notes verbatim if present.
- Key Data Points: transcribe variable name, value **exactly as printed**, and unit; include a short source snippet in quotes when available.
- If a table/figure spans pages, note "(continues on page X)" and keep under the starting page with a cross-reference.
- Do not ask questions or provide analysis or conclusions.

Output exactly in this schema:

Extraction (by page):
- Page <number>:
  - Tables:
    - [Label or "Table <n>" if unlabeled]: <1-sentence description>
      - Markdown:
        | Column 1 | Column 2 | ... |
        |---|---|---|
        | ... | ... | ... |
      - Footnotes/Notes: <verbatim or "None">
  - Figures:
    - [Caption or "Figure <n>" if unlabeled]: <1-sentence description>
      - Notes/Legend: <verbatim or "None">
  - Key Data Points:
    - <metric/variable>: <value exactly as printed> <unit> (source: "…")
    - <metric/variable>: <value exactly as printed> <unit> (source: "…")

- Page <number>:
  - Tables:
    - ...
  - Figures:
    - ...
  - Key Data Points:
    - ...

If no page-indexed artifacts are available:
Extraction (by page): None

**IMPORTANT: Follow the exact schema above. Preserve all numerical precision exactly as printed. This extraction will be used as context for the main task.**`;
  };

  const createPromptPreprocessingPrompt = (promptSource: string): string => {
    return `You are a precise data and requirement extractor. Your task is to extract all key parameters, numerical values, claims, constraints, and requirements from the following step instruction or prompt text.

Rules:
- Preserve exact values, units, ranges, and thresholds as written.
- Do not infer, expand, or fabricate.
- If no structured data is found, output exactly: Extraction: None

Output format — produce a Markdown table for each category found:

### Key Parameters / Values
| Parameter | Value | Unit | Context |
|---|---|---|---|
| ... | ... | ... | ... |

### Requirements / Constraints
| Requirement | Detail |
|---|---|
| ... | ... |

### Claims / Assertions
| Claim | Source snippet |
|---|---|
| ... | ... |

---
Prompt / Instruction text to extract from:

${promptSource.slice(0, 20_000)}`;
  };

  const createIntelligentReExecutionPrompt = (layer: Layer, fileNames: string[], firstAnalysis: string, reinterpretationResult: string, extractionResult: string, secondAnalysis: string): string => {
    return `You are an AI agent optimizer. Using the analysis insights below, re-execute the original task with significant improvements.

## ORIGINAL TASK CONTEXT
- **Step Name**: ${layer.name}
- **Step Type**: ${layer.type}
- **Original User Instruction**: ${layer.userInstruction}
- **System Instruction**: ${layer.systemInstruction || 'None'}
- **User Input**: ${layer.userInput || 'None'}
- **Files Provided**: ${fileNames.length > 0 ? fileNames.join(', ') : 'None'}
- **AI Model**: ${isValidModel(layer.selectedModel) ? layer.selectedModel : DEFAULT_MODEL}

## ORIGINAL OUTPUT (TO IMPROVE)
${layer.result}

## ANALYSIS INSIGHTS

**Initial Assessment**

${firstAnalysis}

**User Request Re-interpretation**

${reinterpretationResult}

**Data/Table/Figure Extraction**

${extractionResult}

**Deep Introspection**

${secondAnalysis}

## YOUR TASK
Using the analysis insights above, re-execute the original task with these improvements:

1. **Address Identified Weaknesses**: Fix specific issues found in the analysis
2. **Incorporate Recommendations**: Apply the suggested improvements
3. **Enhance Quality**: Improve relevance, completeness, and accuracy
4. **Optimize Structure**: Better organize and present the information
5. **Add Missing Elements**: Include anything that was overlooked

## OUTPUT FORMAT
Provide your improved response in this format:

**🚀 IMPROVED RESULT**

[Your enhanced response to the original task]

**📊 KEY IMPROVEMENTS MADE**

- **Issue Fixed**: [Specific problem addressed]
- **Enhancement**: [How it was improved]
- **Added Value**: [New elements included]

**🎯 CONFIDENCE LEVEL**

[Rate your confidence 1-10 that this improved version better fulfills the original task requirements]

**IMPORTANT: Focus on delivering a genuinely improved result, not just explaining what could be better. Show actual improvement through enhanced output quality.**`;
  };

  const analyzeStepOutput = async (layerId: string) => {
    if (!agent) return;

    const layer = agent.layers.find(l => l.id === layerId);
    if (!layer || !layer.result?.trim() || analyzingSteps[layerId]) return;

    setAnalyzingSteps(prev => ({ ...prev, [layerId]: true }));
    setCurrentAnalysisStep(prev => ({ ...prev, [layerId]: 'Step 1: Quality Analysis' }));

    try {
      const fileState = fileStates[layerId];
      const files = fileState?.files || [];
      const fileNames = files.map(f => f.name);

      const currentStepIndex = agent?.layers.findIndex(l => l.id === layerId) || 0;
      const previousStep = currentStepIndex > 0 ? agent?.layers[currentStepIndex - 1] : null;
      const previousStepSummary = previousStep ? `${previousStep.name}: ${previousStep.result?.substring(0, 100)}...` : 'N/A';

      const introspectionPrompt = createIntrospectionPrompt(layer, fileNames, previousStepSummary);

      const messages = [{
        role: 'user',
        text: introspectionPrompt }];

      let res;

      if (files.length > 0) {
        const formData = new FormData();

        files.forEach((file, index) => {
          if (file && file.size > 0) {
            formData.append(`file${index}`, file);
          }
        });

        formData.append('messages', JSON.stringify(messages));
        formData.append('model', DEFAULT_MODEL);

        if (projectFolder?.projectId) {
          formData.append('projectId', projectFolder.projectId);
          console.log(`[Brain Analysis] Adding current project ID to request: ${projectFolder.projectId}`);
        } else {
          console.warn('[Brain Analysis] No current project ID available for RAG processing');
        }

        res = await fetch('/api/gemini', {
          method: 'POST',
          body: formData });
      } else {
        res = await fetch('/api/gemini', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: DEFAULT_MODEL,
            messages
          })
        });
      }

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(`Analysis failed: ${res.status} - ${errorData.message || res.statusText}`);
      }

      const data = await res.json();
      const firstAnalysis = data.response?.trim() || 'No analysis received.';

      setIntrospectionResults(prev => ({
        ...prev,
        [layerId]: { first: firstAnalysis }
      }));

      setCurrentAnalysisStep(prev => ({ ...prev, [layerId]: 'Step 2: Request Re-interpretation' }));
      const reinterpretationPrompt = createUserRequestReinterpretationPrompt(layer, fileNames);

      const secondMessages = [{
        role: 'user',
        text: reinterpretationPrompt }];

      let secondRes;

      if (files.length > 0) {
        const secondFormData = new FormData();

        files.forEach((file, index) => {
          if (file && file.size > 0) {
            secondFormData.append(`file${index}`, file);
          }
        });

        secondFormData.append('messages', JSON.stringify(secondMessages));
        secondFormData.append('model', DEFAULT_MODEL);

        if (projectFolder?.projectId) {
          secondFormData.append('projectId', projectFolder.projectId);
          console.log(`[Re-interpretation] Adding current project ID to request: ${projectFolder.projectId}`);
        } else {
          console.warn('[Re-interpretation] No current project ID available for RAG processing');
        }

        secondRes = await fetch('/api/gemini', {
          method: 'POST',
          body: secondFormData });
      } else {
        secondRes = await fetch('/api/gemini', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: DEFAULT_MODEL,
            messages: secondMessages
          })
        });
      }

      if (!secondRes.ok) {
        const errorData = await secondRes.json().catch(() => ({ message: secondRes.statusText }));
        throw new Error(`Re-interpretation failed: ${secondRes.status} - ${errorData.message || secondRes.statusText}`);
      }

      const secondData = await secondRes.json();
      const reinterpretationResult = secondData.response?.trim() || 'No re-interpretation result received.';

      setIntrospectionResults(prev => ({
        ...prev,
        [layerId]: {
          ...prev[layerId],
          second: reinterpretationResult
        }
      }));

      setCurrentAnalysisStep(prev => ({ ...prev, [layerId]: 'Step 3: Data Extraction' }));
      const dataExtractionPrompt = createDataExtractionPrompt(layer, fileNames);

      const extractionMessages = [{
        role: 'user',
        text: dataExtractionPrompt }];

      let extractionRes;

      if (files.length > 0) {
        const extractionFormData = new FormData();

        files.forEach((file, index) => {
          if (file && file.size > 0) {
            extractionFormData.append(`file${index}`, file);
          }
        });

        extractionFormData.append('messages', JSON.stringify(extractionMessages));
        extractionFormData.append('model', DEFAULT_MODEL);

        if (projectFolder?.projectId) {
          extractionFormData.append('projectId', projectFolder.projectId);
          console.log(`[Data Extraction] Adding current project ID to request: ${projectFolder.projectId}`);
        } else {
          console.warn('[Data Extraction] No current project ID available for RAG processing');
        }

        extractionRes = await fetch('/api/gemini', {
          method: 'POST',
          body: extractionFormData });
      } else {
        extractionRes = await fetch('/api/gemini', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: isValidModel(layer.selectedModel) ? layer.selectedModel : DEFAULT_MODEL,
            messages: extractionMessages
          })
        });
      }

      if (!extractionRes.ok) {
        const errorData = await extractionRes.json().catch(() => ({ message: extractionRes.statusText }));
        throw new Error(`Data extraction failed: ${extractionRes.status} - ${errorData.message || extractionRes.statusText}`);
      }

      const extractionData = await extractionRes.json();
      const extractionResult = extractionData.response?.trim() || 'No data extraction result received.';

      setIntrospectionResults(prev => ({
        ...prev,
        [layerId]: {
          ...prev[layerId],
          extraction: extractionResult
        }
      }));

      setCurrentAnalysisStep(prev => ({ ...prev, [layerId]: 'Step 4: Deep Introspection' }));
      const deepIntrospectionPrompt = createDeepIntrospectionPrompt(layer, fileNames);

      const fourthMessages = [{
        role: 'user',
        text: deepIntrospectionPrompt }];

      let fourthRes;

      if (files.length > 0) {
        const fourthFormData = new FormData();

        files.forEach((file, index) => {
          if (file && file.size > 0) {
            fourthFormData.append(`file${index}`, file);
          }
        });

        fourthFormData.append('messages', JSON.stringify(fourthMessages));
        fourthFormData.append('model', isValidModel(layer.selectedModel) ? layer.selectedModel : DEFAULT_MODEL);

        if (projectFolder?.projectId) {
          fourthFormData.append('projectId', projectFolder.projectId);
          console.log(`[Deep Introspection] Adding current project ID to request: ${projectFolder.projectId}`);
        } else {
          console.warn('[Deep Introspection] No current project ID available for RAG processing');
        }

        fourthRes = await fetch('/api/gemini', {
          method: 'POST',
          body: fourthFormData });
      } else {
        fourthRes = await fetch('/api/gemini', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: isValidModel(layer.selectedModel) ? layer.selectedModel : DEFAULT_MODEL,
            messages: fourthMessages
          })
        });
      }

      if (!fourthRes.ok) {
        const errorData = await fourthRes.json().catch(() => ({ message: fourthRes.statusText }));
        throw new Error(`Deep introspection failed: ${fourthRes.status} - ${errorData.message || fourthRes.statusText}`);
      }

      const fourthData = await fourthRes.json();
      const secondAnalysis = fourthData.response?.trim() || 'No deep introspection result received.';

      setIntrospectionResults(prev => ({
        ...prev,
        [layerId]: {
          ...prev[layerId],
          reinterpretation: secondAnalysis
        }
      }));

      setCurrentAnalysisStep(prev => ({ ...prev, [layerId]: 'Step 5: Intelligent Re-execution' }));
      const reExecutionPrompt = createIntelligentReExecutionPrompt(layer, fileNames, firstAnalysis, reinterpretationResult, extractionResult, secondAnalysis);

      const fifthMessages = [{
        role: 'user',
        text: reExecutionPrompt }];

      let fifthRes;

      if (files.length > 0) {
        const fifthFormData = new FormData();

        files.forEach((file, index) => {
          if (file && file.size > 0) {
            fifthFormData.append(`file${index}`, file);
          }
        });

        fifthFormData.append('messages', JSON.stringify(fifthMessages));
        fifthFormData.append('model', isValidModel(layer.selectedModel) ? layer.selectedModel : DEFAULT_MODEL);

        if (projectFolder?.projectId) {
          fifthFormData.append('projectId', projectFolder.projectId);
          console.log(`[Re-execution] Adding current project ID to request: ${projectFolder.projectId}`);
        } else {
          console.warn('[Re-execution] No current project ID available for RAG processing');
        }

        fifthRes = await fetch('/api/gemini', {
          method: 'POST',
          body: fifthFormData });
      } else {
        fifthRes = await fetch('/api/gemini', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: isValidModel(layer.selectedModel) ? layer.selectedModel : DEFAULT_MODEL,
            messages: fifthMessages
          })
        });
      }

      if (!fifthRes.ok) {
        const errorData = await fifthRes.json().catch(() => ({ message: fifthRes.statusText }));
        throw new Error(`Re-execution failed: ${fifthRes.status} - ${errorData.message || fifthRes.statusText}`);
      }

      const fifthData = await fifthRes.json();
      const reExecutionResult = fifthData.response?.trim() || 'No re-execution result received.';

      setIntrospectionResults(prev => ({
        ...prev,
        [layerId]: {
          ...prev[layerId],
          reexecution: reExecutionResult
        }
      }));

    } catch (error) {
      console.error(`❌ Error analyzing step ${layer.name}:`, error);
      alert(`Failed to improve step "${layer.name}". Please check your connection and try again.\n\nError: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setAnalyzingSteps(prev => ({ ...prev, [layerId]: false }));
      setCurrentAnalysisStep(prev => ({ ...prev, [layerId]: '' }));
    }
  };

  const formatPreprocessingMarkdown = (layerId: string): string => {
    const results = preprocessingResults[layerId];
    const layer = agent?.layers.find(l => l.id === layerId);

    if ((!results?.document && !results?.prompt) || !layer) return '';

    const timestamp = new Date().toLocaleString();

    let markdown = `# Pre-process Output Report\n\n`;
    markdown += `**Step Name:** ${layer.name || 'Unnamed Step'}\n`;
    markdown += `**Generated:** ${timestamp}\n`;
    markdown += `**Agent:** ${agent?.name || 'Unnamed Agent'}\n\n`;

    markdown += `## Step Context\n`;
    markdown += `**System Instruction:** ${layer.systemInstruction || 'None'}\n`;
    markdown += `**User Input:** ${layer.userInput || 'None'}\n\n`;

    if (results?.document) {
      markdown += `## 📄 Document Extraction\n\n${results.document}\n\n`;
    }
    if (results?.prompt) {
      markdown += `## ✏️ Prompt Data\n\n${results.prompt}\n\n`;
    }

    if (layer.result) {
      markdown += `## 📝 Final Step Result\n\n${layer.result}\n\n`;
    }

    markdown += `---\n*Generated by ALMA AI Agent Pre-processing System*`;

    return markdown;
  };

  const downloadPreprocessingResults = (layerId: string) => {
    const markdown = formatPreprocessingMarkdown(layerId);
    if (!markdown) {
      alert('No preprocessing results to download.');
      return;
    }

    const layer = agent?.layers.find(l => l.id === layerId);
    const filename = `PREPROCESS_${layer?.name || 'step'}_output_${new Date().toISOString().split('T')[0]}.md`;

    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const exportPreprocessingToGoogleDrive = async (layerId: string) => {
    try {
      if (!projectFolder?.projectId) {
        alert('No project selected. Please select a project first.');
        return;
      }

      const markdown = formatPreprocessingMarkdown(layerId);
      if (!markdown) {
        alert('No preprocessing results to export.');
        return;
      }

      const layer = agent?.layers.find(l => l.id === layerId);
      const layerIndex = agent?.layers.findIndex(l => l.id === layerId) ?? -1;
      const stepNumber = layerIndex >= 0 ? layerIndex + 1 : 0;

      const agentName = (agent?.name || 'agent').replace(/[^a-zA-Z0-9_-]+/g, '_');
      const version = agent?.version || selectedVersion || '1';
      const date = new Date().toISOString().split('T')[0];
      const filename = `${agentName}-step_${stepNumber}_preprocessing-${version}-${date}.md`;

      const title = `Pre-process Output: ${layer?.name || 'Step'}`;

      console.log('📄 Preprocessing Export - Using simple API like canvas');

      const response = await fetch('/api/canvas/save-project', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: projectFolder.projectId,
          filename: filename,
          title: title,
          content: markdown,
          isNewVersion: false
        }),
        credentials: 'include'
      });

      if (response.ok) {
        await response.json();
        alert(`✅ Preprocessing results exported to Google Drive as "${filename}"`);
      } else {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        console.error('Export failed:', errorData);
        alert(`❌ Failed to export to Google Drive: ${errorData.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Preprocessing export error:', error);
      alert('❌ Failed to export preprocessing results to Google Drive. Please try again.');
    }
  };

  const exportPreprocessingToGoogleDocs = async (layerId: string) => {
    try {
      const markdown = formatPreprocessingMarkdown(layerId);

      if (!markdown.trim()) {
        alert('No preprocessing results to export. Please run preprocessing first.');
        return;
      }

      const layer = agent?.layers.find(l => l.id === layerId);
      const title = `Pre-process Output: ${layer?.name || 'Step'} - ${new Date().toLocaleDateString()}`;

      console.log('Starting Google Doc export...');
      console.log('Content length:', markdown.length);
      console.log('Title:', title);

      console.log('Making fetch request to:', '/api/docs/create');

      const response = await fetch('/api/docs/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          content: markdown
        }),
        credentials: 'include'
      });

      console.log('Fetch response received:', response);
      console.log('Response status:', response.status);
      console.log('Response ok:', response.ok);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        console.error('API error response:', errorData);

        if (response.status === 503 && errorData.error === 'Google Docs API Setup Required') {
          alert(`🔧 ${errorData.error}\n\n${errorData.details}\n\n📋 Action: ${errorData.action}\n\n💡 Alternative: ${errorData.fallback}`);
        } else if (response.status === 401 && errorData.error === 'Authentication Error') {
          alert(`🔐 ${errorData.error}\n\n${errorData.details}\n\n📋 Action: ${errorData.action}\n\n💡 Alternative: ${errorData.fallback}`);
        } else {
          alert(`❌ Failed to create Google Doc: ${errorData.error || 'Unknown error'}\n\n💡 Alternative: ${errorData.fallback || 'Try the Download or Google Drive export options.'}`);
        }
        return;
      }

      const result = await response.json();
      console.log('Export result:', result);

      if (result.webViewLink) {
        const openDoc = confirm(`✅ Preprocessing results exported successfully!\n\nDocument: "${result.title}"\n\nWould you like to open it now?`);
        if (openDoc) {
          window.open(result.webViewLink, '_blank');
        }
      } else {
        alert('✅ Preprocessing results exported to Google Docs successfully!');
      }
    } catch (error) {
      console.error('Preprocessing export error:', error);
      alert('❌ Failed to export preprocessing results to Google Docs. Please try again.');
    }
  };

  const toggleResultVisibility = (layerId: string) => {
    setResultsVisible(prev => ({
      ...prev,
      [layerId]: !prev[layerId]
    }));
  };

  const togglePreprocessingVisibility = (layerId: string) => {
    setPreprocessingVisible(prev => ({
      ...prev,
      [layerId]: !prev[layerId]
    }));
  };

  const toggleIntrospectionVisibility = (layerId: string) => {
    setIntrospectionVisible(prev => ({
      ...prev,
      [layerId]: !prev[layerId]
    }));
  };

  const layerIdsSignature = useMemo(
    () => agent?.layers?.map((layer) => layer.id).sort().join('|') ?? '',
    [agent?.layers],
  );

  const mergeDefaultVisibility = useCallback(
    (prev: Record<string, boolean>, layerIds: string[]): Record<string, boolean> => {
      let changed = false;
      const next = { ...prev };
      for (const layerId of layerIds) {
        if (!(layerId in next)) {
          next[layerId] = true;
          changed = true;
        }
      }
      return changed ? next : prev;
    },
    [],
  );

  useEffect(() => {
    if (!layerIdsSignature) return;
    const layerIds = layerIdsSignature.split('|');
    setResultsVisible((prev) => mergeDefaultVisibility(prev, layerIds));
    setPreprocessingVisible((prev) => mergeDefaultVisibility(prev, layerIds));
    setIntrospectionVisible((prev) => mergeDefaultVisibility(prev, layerIds));
  }, [layerIdsSignature, mergeDefaultVisibility]);

  const formatIntrospectionMarkdown = (layerId: string): string => {
    const results = introspectionResults[layerId];
    const layer = agent?.layers.find(l => l.id === layerId);

    if (!results || !layer) return '';

    const timestamp = new Date().toLocaleString();

    let markdown = `# Introspection Analysis Report\n\n`;
    markdown += `**Step Name:** ${layer.name || 'Unnamed Step'}\n`;
    markdown += `**Generated:** ${timestamp}\n`;
    markdown += `**Agent:** ${agent?.name || 'Unnamed Agent'}\n\n`;

    markdown += `## Step Context\n`;
    markdown += `**System Instruction:** ${layer.systemInstruction || 'None'}\n`;
    markdown += `**User Input:** ${layer.userInput || 'None'}\n\n`;

    if (results.first) {
      markdown += `## 🔍 Standard Analysis\n\n${results.first}\n\n`;
    }

    if (results.second) {
      markdown += `## 🎯 User Request Re-interpretation\n\n${results.second}\n\n`;
    }

    if (results.extraction) {
      markdown += `## 📊 Data/Table/Figure Extraction\n\n${results.extraction}\n\n`;
    }

    if (results.reinterpretation) {
      markdown += `## 🧠 Deep Introspection\n\n${results.reinterpretation}\n\n`;
    }

    if (results.reexecution) {
      markdown += `## 🚀 Improved Result with AI Insights\n\n${results.reexecution}\n\n`;
    }

    if (layer.result) {
      markdown += `## 📝 Original Step Result\n\n${layer.result}\n\n`;
    }

    markdown += `---\n*Generated by ALMA AI Agent Introspection System*`;

    return markdown;
  };

  const downloadIntrospectionResults = (layerId: string) => {
    const markdown = formatIntrospectionMarkdown(layerId);
    if (!markdown) {
      alert('No introspection results to download.');
      return;
    }

    const layer = agent?.layers.find(l => l.id === layerId);
    const filename = `BRAIN_${layer?.name || 'step'}_introspection_${new Date().toISOString().split('T')[0]}.md`;

    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const exportToGoogleDrive = async (layerId: string) => {
    try {
      if (!projectFolder?.projectId) {
        alert('No project selected. Please select a project first.');
        return;
      }

      const markdown = formatIntrospectionMarkdown(layerId);
      if (!markdown) {
        alert('No introspection results to export.');
        return;
      }

      const layer = agent?.layers.find(l => l.id === layerId);
      const layerIndex = agent?.layers.findIndex(l => l.id === layerId) ?? -1;
      const stepNumber = layerIndex >= 0 ? layerIndex + 1 : 0;

      const agentName = (agent?.name || 'agent').replace(/[^a-zA-Z0-9_-]+/g, '_');
      const version = agent?.version || selectedVersion || '1';
      const date = new Date().toISOString().split('T')[0];
      const filename = `${agentName}-step_${stepNumber}_introspection-${version}-${date}.md`;

      const title = `Brain Analysis: ${layer?.name || 'Step'}`;

      console.log('🧠 Brain Export - Using simple API like canvas');

      const response = await fetch('/api/ai-agents/export', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          content: markdown,
          projectId: projectFolder.projectId,
          folderName: 'Analysis',
          fileName: filename
        }),
        credentials: 'include'
      });

      if (response.ok) {
        const result = await response.json();
        alert(`✅ Introspection analysis exported to Google Drive!\n\nFile: ${result.fileName}\nFolder: ${result.folderName}/`);
      } else {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Export failed');
      }
    } catch (error) {
      console.error('Export to Drive error:', error);
      alert(`Failed to export to Google Drive:\n${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const exportToGoogleDocs = async (layerId: string) => {
    try {
      const markdown = formatIntrospectionMarkdown(layerId);

      if (!markdown.trim()) {
        alert('No introspection results to export. Please run the brain analysis first.');
        return;
      }

      const layer = agent?.layers.find(l => l.id === layerId);
      const title = `BRAIN Analysis: ${layer?.name || 'Step'} - ${new Date().toLocaleDateString()}`;

      console.log('Starting Google Doc export...');
      console.log('Content length:', markdown.length);
      console.log('Title:', title);

      console.log('Making fetch request to:', '/api/docs/create');

      const response = await fetch('/api/docs/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          content: markdown
        }),
        credentials: 'include'
      });

      console.log('Fetch response received:', response);
      console.log('Response status:', response.status);
      console.log('Response ok:', response.ok);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        console.error('API error response:', errorData);

        if (response.status === 503 && errorData.error === 'Google Docs API Setup Required') {
          alert(`🔧 ${errorData.error}\n\n${errorData.details}\n\n📋 Action: ${errorData.action}\n\n💡 Alternative: ${errorData.fallback}`);
        } else if (response.status === 401 && errorData.error === 'Authentication Error') {
          alert(`🔐 ${errorData.error}\n\n${errorData.details}\n\n📋 Action: ${errorData.action}\n\n💡 Alternative: ${errorData.fallback}`);
        } else {
          alert(`❌ Failed to create Google Doc: ${errorData.error || 'Unknown error'}\n\n💡 Alternative: ${errorData.fallback || 'Try the Download or Google Drive export options.'}`);
        }
        return;
      }

      const result = await response.json();
      console.log('Success! API response:', result);

      window.open(result.document.webViewLink, '_blank');

    } catch (error) {
      console.error('Detailed error information:', {
        error: error,
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : 'No stack trace',
        type: typeof error,
        name: error instanceof Error ? error.name : 'Unknown'
      });

      if (error instanceof TypeError && error.message.includes('fetch')) {
        console.error('This appears to be a network/fetch error');
        alert(`Network Error: Could not connect to the server. Please check if the development server is running. Error: ${error.message}`);
      } else {
        alert(`Failed to create Google Doc: ${error instanceof Error ? error.message : 'Unknown error'}\n\n💡 Alternative: Try the Download or Google Drive export options.`);
      }
    }
  };

  const formatStepResultMarkdown = (layerId: string): string => {
    const layer = agent?.layers.find(l => l.id === layerId);

    if (!layer?.result) return '';

    const timestamp = new Date().toLocaleString();

    let markdown = `# Step Result Report\n\n`;
    markdown += `**Step Name:** ${layer.name || 'Unnamed Step'}\n`;
    markdown += `**Generated:** ${timestamp}\n`;
    markdown += `**Agent:** ${agent?.name || 'Unnamed Agent'}\n\n`;

    markdown += `## Step Configuration\n`;
    markdown += `**System Instruction:** ${layer.systemInstruction || 'None'}\n`;
    markdown += `**User Input:** ${layer.userInput || 'None'}\n\n`;

    markdown += `## 📝 Step Result\n\n${layer.result}\n\n`;

    markdown += `---\n*Generated by ALMA AI Agent System*`;

    return markdown;
  };

  const exportStepResultToGoogleDrive = async (layerId: string) => {
    try {
      console.log('🔍 Drive Export Debug - Project folder:', projectFolder);

      if (!projectFolder?.projectId) {
        console.error('❌ Drive Export - No project ID found');
        alert('No project selected. Please select a project first.');
        return;
      }

      console.log('✅ Drive Export - Using project ID:', projectFolder.projectId);

      const markdown = formatStepResultMarkdown(layerId);
      if (!markdown) {
        console.error('❌ Drive Export - No markdown content');
        alert('No step result to export.');
        return;
      }

      console.log('✅ Drive Export - Markdown length:', markdown.length);

      const layer = agent?.layers.find(l => l.id === layerId);
      const layerIndex = agent?.layers.findIndex(l => l.id === layerId) ?? -1;
      const stepNumber = layerIndex >= 0 ? layerIndex + 1 : 0;

      const agentName = (agent?.name || 'agent').replace(/[^a-zA-Z0-9_-]+/g, '_');
      const version = agent?.version || selectedVersion || '1';
      const date = new Date().toISOString().split('T')[0];
      const filename = `${agentName}-step_${stepNumber}-${version}-${date}.md`;

      const title = layer?.name || 'Step Result';

      console.log('✅ Drive Export - Using simple API like canvas');
      console.log('🚀 Drive Export - Making API request to:', '/api/ai-agents/export');

      const response = await fetch('/api/ai-agents/export', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          content: markdown,
          projectId: projectFolder.projectId,
          folderName: 'Analysis',
          fileName: filename
        }),
        credentials: 'include'
      });

      console.log('📡 Drive Export - Response status:', response.status, response.statusText);

      if (response.ok) {
        const result = await response.json();
        console.log('✅ Drive Export - Success:', result);
        alert(`✅ Step result exported to Google Drive!\n\nFile: ${result.fileName}\nFolder: ${result.folderName}/`);
      } else {
        const errorData = await response.json().catch(() => ({ error: 'Failed to parse error response' }));
        console.error('❌ Drive Export - API Error:', response.status, errorData);
        throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      console.error('❌ Drive Export - Full error details:', {
        error: error,
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : 'No stack trace',
        type: typeof error,
        name: error instanceof Error ? error.name : 'Unknown'
      });

      if (error instanceof TypeError && error.message.includes('fetch')) {
        alert(`Network Error: Could not connect to the server. Please check if the development server is running.\n\nError: ${error.message}`);
      } else {
        alert(`Failed to export to Google Drive:\n${error instanceof Error ? error.message : 'Unknown error'}\n\n💡 Check the browser console for detailed logs.`);
      }
    }
  };

  const exportStepResultToGoogleDocs = async (layerId: string) => {
    try {
      const markdown = formatStepResultMarkdown(layerId);

      if (!markdown.trim()) {
        alert('No step result to export. Please run the step first.');
        return;
      }

      const layer = agent?.layers.find(l => l.id === layerId);
      const title = `STEP Result: ${layer?.name || 'Step'} - ${new Date().toLocaleDateString()}`;

      console.log('Starting Google Doc export for step result...');
      console.log('Content length:', markdown.length);
      console.log('Title:', title);

      console.log('Making fetch request to:', '/api/docs/create');

      const response = await fetch('/api/docs/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          content: markdown
        }),
        credentials: 'include'
      });

      console.log('Fetch response received:', response);
      console.log('Response status:', response.status);
      console.log('Response ok:', response.ok);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        console.error('API error response:', errorData);

        if (response.status === 503 && errorData.error === 'Google Docs API Setup Required') {
          alert(`🔧 ${errorData.error}\n\n${errorData.details}\n\n📋 Action: ${errorData.action}\n\n💡 Alternative: ${errorData.fallback}`);
        } else if (response.status === 401 && errorData.error === 'Authentication Error') {
          alert(`🔐 ${errorData.error}\n\n${errorData.details}\n\n📋 Action: ${errorData.action}\n\n💡 Alternative: ${errorData.fallback}`);
        } else {
          alert(`❌ Failed to create Google Doc: ${errorData.error || 'Unknown error'}\n\n💡 Alternative: ${errorData.fallback || 'Try the Download or Google Drive export options.'}`);
        }
        return;
      }

      const result = await response.json();
      console.log('Success! API response:', result);

      window.open(result.document.webViewLink, '_blank');

    } catch (error) {
      console.error('Detailed error information:', {
        error: error,
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : 'No stack trace',
        type: typeof error,
        name: error instanceof Error ? error.name : 'Unknown'
      });

      if (error instanceof TypeError && error.message.includes('fetch')) {
        console.error('This appears to be a network/fetch error');
        alert(`Network Error: Could not connect to the server. Please check if the development server is running. Error: ${error.message}`);
      } else {
        alert(`Failed to create Google Doc: ${error instanceof Error ? error.message : 'Unknown error'}\n\n💡 Alternative: Try the Download or Google Drive export options.`);
      }
    }
  };

  if (isLoading) {
    return (
      <>
        <div className="edit-agent-page" style={{ minHeight: 'var(--app-height)' }} aria-hidden />
        <div
          className="edit-agent-loading-overlay"
          role="status"
          aria-live="polite"
          aria-label="Loading agent documentation and layout"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            gap: '1rem',
            backgroundColor: 'rgba(0, 0, 0, 0.45)',
            backdropFilter: 'blur(4px)' }}
        >
          <div
            style={{
              width: '32px',
              height: '32px',
              border: '2px solid rgba(255,255,255,0.3)',
              borderTop: '2px solid #fff',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite' }}
          />
          <p style={{ color: 'rgba(255,255,255,0.95)', fontSize: '1.125rem', fontWeight: 500, margin: 0 }}>
            Loading info
          </p>
        </div>
      </>
    );
  }

  if (error || !agent) {
    return (
      <div className="edit-agent-page">
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          height: 'var(--app-height)',
          gap: '1.5rem',
          padding: '2rem',
          textAlign: 'center'
        }}>
          <div style={{ fontSize: '3rem' }}>⚠️</div>
          <h2 style={{ margin: 0, color: '#dc2626' }}>Unable to Load Agent</h2>
          <p style={{
            margin: 0,
            color: '#6b7280',
            maxWidth: '500px',
            lineHeight: '1.5'
          }}>
            {error || 'The requested agent could not be found or loaded.'}
          </p>
          <button
            onClick={() => router.push('/ai-agents')}
            style={{
              padding: '0.75rem 1.5rem',
              backgroundColor: '#11074A',
              color: 'white',
              border: 'none',
              borderRadius: '0.5rem',
              fontSize: '1rem',
              cursor: 'pointer',
              transition: 'background-color 0.2s'
            }}
            onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#1a0f5c'}
            onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#11074A'}
          >
            ← Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  // Full step list for the reference picker. The graph view lets a step
  // reference any other step (incl. later ones) and the run engine executes
  // those refs, so the form must show the same scope — otherwise a forward
  // reference created in the graph is invisible/unremovable in the form.
  const allStepsForRefs: Step[] = (agent?.layers ?? []).map((l) => ({ id: l.id, name: l.name, tag: l.tag }));

  return (
    <>
      {}
      {quickTooltip && (
        <div
          role="tooltip"
          aria-live="polite"
          style={{
            position: 'fixed',
            left: quickTooltip.x + 12,
            top: quickTooltip.y + 12,
            maxWidth: 380,
            padding: '10px 12px',
            background: '#1a1a2e',
            color: '#e8e8e8',
            fontSize: '12px',
            lineHeight: 1.45,
            whiteSpace: 'pre-wrap',
            borderRadius: 8,
            boxShadow: '0 4px 20px rgba(0,0,0,0.35)',
            zIndex: 25000,
            pointerEvents: 'none' }}
        >
          {quickTooltip.content}
        </div>
      )}
      <MathJaxContext {...mathConfig}>
        {}
        {(isSaving || isSavingNote) && (
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            zIndex: 20000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'column',
            color: 'white',
            fontSize: '1.2rem',
            fontWeight: '500'
          }}>
            <FaSpinner style={{
              animation: 'spin 1s linear infinite',
              fontSize: '3rem',
              marginBottom: '1rem'
            }} />
            <div>{isSaving ? 'Creating New Version...' : 'Saving Note...'}</div>
            <div style={{ fontSize: '0.9rem', marginTop: '0.5rem', opacity: 0.8 }}>
              Please wait, do not close this page
            </div>
          </div>
        )}

        {}
        {notesPanelOpen && (
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.3)',
            backdropFilter: 'blur(4px)',
            zIndex: 10090,
            pointerEvents: 'none'
          }} />
        )}

        <style jsx>{`
        .version-select-dropdown {
          position: relative !important;
        }
        
        .version-select-dropdown select {
          position: relative !important;
        }
        
        .version-select-dropdown select option {
          position: relative !important;
          top: auto !important;
          bottom: auto !important;
        }
        
        /* Force dropdown to open downward */
        select.version-select {
          transform-origin: top !important;
          direction: ltr !important;
        }
        
        /* Ensure dropdown appears below the select */
        .version-selector {
          overflow: visible !important;
        }
        
        /* Additional CSS to force downward dropdown */
        .version-select-dropdown select:focus {
          position: relative !important;
          z-index: 9999 !important;
        }
        
        /* Force the dropdown list to appear below */
        .version-select-dropdown select option {
          direction: ltr !important;
        }

        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>

        {tooltip && (
          <div
            className="tooltip"
            style={{
              position: 'fixed',
              left: tooltip.x,
              top: tooltip.y,
              background: 'rgba(0, 0, 0, 0.8)',
              color: 'white',
              padding: '4px 8px',
              borderRadius: '4px',
              fontSize: '12px',
              zIndex: 10002,
              pointerEvents: 'none',
              maxWidth: '300px',
              wordWrap: 'break-word'
            }}
          >
            {tooltip.text}
          </div>
        )}


        <div className="edit-agent-page">
          {}
          <div className="edit-header">
            <button
              className="back-button"
              onClick={handleBackToDashboard}
              onMouseEnter={e => handleMouseEnter(e, 'Back to Agents Dashboard')}
              onMouseLeave={handleMouseLeave}
              aria-label="Back to Agents"
            >
              <FaArrowLeft />
            </button>

            <div className="header-title">
              <input
                type="text"
                className="agent-name-input"
                value={agentName}
                readOnly
                placeholder="Agent Name"
                onMouseEnter={e => handleMouseEnter(e, agentName || 'Agent Name')}
                onMouseLeave={handleMouseLeave}
              />
            </div>

            <div className="header-actions" aria-label="Agent header actions">
              {}
              <button
                className="notes-button"
                onClick={() => setNotesPanelOpen(!notesPanelOpen)}
                onMouseEnter={e => handleMouseEnter(e, 'Open development notes')}
                onMouseLeave={handleMouseLeave}
              >
                <FaPen />
              </button>

              {}
              {versionedAgentData && (
                <div className="version-selector">
                  <div className="agent-version-dropdown">
                    <button
                      onClick={() => setShowVersionDropdown(!showVersionDropdown)}
                      className="agent-version-dropdown-button"
                      onMouseEnter={e => handleMouseEnter(e, 'Switch between different versions of this agent')}
                      onMouseLeave={handleMouseLeave}
                    >
                      <span className="agent-version-dropdown-label">
                        {selectedVersion}{' '}
                        <span className="agent-version-dropdown-date">
                          ({new Date(versionedAgentData.versions.find(v => v.version === selectedVersion)?.timestamp || '').toLocaleString()})
                        </span>
                      </span>
                    </button>

                    {}
                    {showVersionDropdown && (
                      <div className="agent-version-dropdown-menu">
                        {versionedAgentData.versions.map((version) => (
                          <button
                            key={version.version}
                            onClick={() => {
                              handleVersionChange(version.version);
                              setShowVersionDropdown(false);
                            }}
                            className={`agent-version-dropdown-item ${selectedVersion === version.version ? 'active' : ''}`}
                          >
                            {version.version} ({new Date(version.timestamp).toLocaleString()})
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                </div>
              )}

              {}
              <div id="form-export-button-portal-target" />

              <div className="save-button-group">
                <button
                  className="save-button"
                  onClick={() => handleSaveAgent()}
                  disabled={isSaving}
                  onMouseEnter={e => handleMouseEnter(e, 'Create new version with current changes')}
                  onMouseLeave={handleMouseLeave}
                >
                  <FaSave /> {isSaving ? 'Saving...' : 'New Ver.'}
                </button>

                {}
                {lastSaveTimestamp && (
                  <div className="autosave-indicator">
                    <span className="autosave-icon">
                      {isAutosaving ? '💾' : '✓'}
                    </span>
                    <span className="autosave-text">
                      {isAutosaving ? 'Saving...' : `Saved ${formatRelativeTime(lastSaveTimestamp)}`}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {agent && (
            <div className="edit-skills-bar" style={{ padding: '8px 16px' }}>
              <SkillsPanel
                lib={skillsLib}
                attachedIds={attachedSkillIds}
                onChange={updateSkillIds}
              />
              <AgentFilesPanel
                key={`${agentId}:${projectFolder?.projectId}:${session?.user?.email}`}
                metadata={agent.metadata}
                onChange={updateInputs}
                projectId={projectFolder?.projectId}
                projectCorpora={projectCorpusLinks}
                disabled={isAnyStepRunning || runAllManager.isRunning || showRunAllProgress}
              />
            </div>
          )}

          {}
          <div className="edit-content">
            {}
            <div className="edit-sidebar" style={{ display: 'none' }}>
              <ListExtracts
                onContextUpdate={setMasterContextString}
                onAgentFilesUpdate={setSelectedAgentFiles}
                onAgentPapersUpdate={setSelectedAgentPapers}
                onAgentRagUpdate={setSelectedAgentRag}
                hiddenTabs={['files', 'papers']}
              />
            </div>

            {}
            <div className="edit-main">
              <div className="agent-editor-header">
                <div className="agent-editor-header__lead">
                  <h2>({agent?.layers?.length || 0} steps)</h2>
                  <input
                    type="search"
                    className="step-search-input"
                    placeholder="Search steps by name…"
                    value={stepSearch}
                    onChange={e => setStepSearch(e.target.value)}
                  />
                  {(distinctStepTags.length > 0 || hasUntaggedSteps) && (
                    <div className="step-tag-filter" ref={stepTagMenuRef}>
                      <button
                        type="button"
                        className={`step-tag-filter__trigger${stepFilterTags.length > 0 ? ' step-tag-filter__trigger--active' : ''}`}
                        onClick={() => setStepTagMenuOpen(open => !open)}
                        aria-haspopup="menu"
                        aria-expanded={stepTagMenuOpen}
                        title="Filter steps by collection tag"
                      >
                        Tags{stepFilterTags.length > 0 ? ` (${stepFilterTags.length})` : ''}
                        <span className="step-tag-filter__caret" aria-hidden>▾</span>
                      </button>
                      {stepTagMenuOpen && (
                        <div className="step-tag-filter__panel" role="menu" aria-label="Filter steps by tag">
                          {hasUntaggedSteps && (
                            <button
                              type="button"
                              role="menuitemcheckbox"
                              aria-checked={stepFilterTags.includes(STEP_FILTER_UNTAGGED)}
                              className={`step-tag-filter__item${stepFilterTags.includes(STEP_FILTER_UNTAGGED) ? ' step-tag-filter__item--on' : ''}`}
                              onClick={() => {
                                setStepFilterTags(prev =>
                                  prev.includes(STEP_FILTER_UNTAGGED)
                                    ? prev.filter(x => x !== STEP_FILTER_UNTAGGED)
                                    : [...prev, STEP_FILTER_UNTAGGED].sort((a, b) => a.localeCompare(b)),
                                );
                              }}
                            >
                              <span className="step-tag-filter__swatch step-tag-filter__swatch--untagged" aria-hidden />
                              <span className="step-tag-filter__label">Untagged</span>
                            </button>
                          )}
                          {distinctStepTags.map(tag => {
                            const col = getTagColor(tag);
                            const on = stepFilterTags.includes(tag);
                            return (
                              <button
                                key={tag}
                                type="button"
                                role="menuitemcheckbox"
                                aria-checked={on}
                                className={`step-tag-filter__item${on ? ' step-tag-filter__item--on' : ''}`}
                                onClick={() => {
                                  setStepFilterTags(prev =>
                                    prev.includes(tag)
                                      ? prev.filter(x => x !== tag)
                                      : [...prev, tag].sort((a, b) => a.localeCompare(b)),
                                  );
                                }}
                              >
                                <span
                                  className="step-tag-filter__swatch"
                                  aria-hidden
                                  style={{ background: col.border }}
                                />
                                <span className="step-tag-filter__label">{tag}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                  {stepFilterActive && (
                    <button
                      type="button"
                      className="step-filter-clear"
                      onClick={() => {
                        setStepSearch('');
                        setStepFilterTags([]);
                        setStepTagMenuOpen(false);
                      }}
                    >
                      Clear
                    </button>
                  )}
                </div>

                {}
                <div className="run-all-controls">
                  {!showRunAllProgress && !runAllManager.isRunning && (() => {
                    const anyCorpusEmpty = (agent?.layers || []).some(l => {
                      const tab = stepInputTab[l.id] || 'text';
                      if (tab !== 'corpus') return false;
                      if (!stepCorpusIds[l.id]) return false;
                      const docs = (stepCorpusDocuments[l.id] || []).filter((d: { state: string }) => d.state !== 'FAILED');
                      if (docs.length === 0) return false;
                      return (stepDocumentSelections[l.id] || []).length === 0;
                    });
                    const runAllTitle = anyCorpusEmpty
                      ? 'One or more steps have no corpus documents selected'
                      : 'Run all steps sequentially';
                    return (
                    <button
                      onClick={() => {
                        const allMissing: string[] = [];
                        for (const l of (agent?.layers || [])) {
                          const cId = stepCorpusIds[l.id];
                          if (!cId) continue;
                          const bibCorpus = (l.bibliography || []).filter(b => b.type === 'corpus');
                          if (bibCorpus.length === 0) continue;
                          const allDocs = (stepCorpusDocuments[l.id] || []).filter(d => d.state !== 'FAILED');
                          const liveNames = new Set(allDocs.map(d => d.pdfName));
                          const missing = bibCorpus.filter(b => !liveNames.has(b.name));
                          allMissing.push(...missing.map(b => {
                            const label = b.source ? `${b.name} (${b.source})` : b.name;
                            return `[${l.name}] ${label}`;
                          }));
                        }
                        const stepCount = agent?.layers?.length ?? 0;
                        const warningLines = allMissing.length > 0
                          ? `\n\n⚠️ Bibliography references document(s) not in corpus:\n• ${allMissing.join('\n• ')}`
                          : '';
                        if (!confirm(`▶ Run All Steps (${stepCount} step${stepCount !== 1 ? 's' : ''})${warningLines}\n\nAre you sure you want to continue?`)) return;
                        handleRunAllSteps();
                      }}
                      disabled={!agent?.layers?.length || isAnyStepRunning || anyCorpusEmpty}
                      className="run-all-button"
                      title={runAllTitle}
                    >
                      ▶ Run All Steps
                    </button>
                    );
                  })()}

                  {(showRunAllProgress || runAllManager.isRunning) && (
                    <div className="run-all-progress">
                      <div className="progress-info">
                        <span>Running: {runAllManager.progress.current}/{runAllManager.progress.total}</span>
                        {runAllManager.progress.currentStepName && (
                          <span className="current-step">
                            → {runAllManager.progress.currentStepName}
                          </span>
                        )}
                      </div>
                      <div className="progress-bar">
                        <div
                          className="progress-fill"
                          style={{
                            width: `${(runAllManager.progress.current / runAllManager.progress.total) * 100}%`
                          }}
                        />
                      </div>
                      <button
                        onClick={() => {
                          if (sharedBatchInputsRef.current) sharedBatchInputsRef.current.cancelled = true;
                          runAllManager.cancelExecution();
                          runAbortRef.current?.abort();
                          setShowRunAllProgress(false);
                        }}
                        className="cancel-button"
                        title="Cancel execution"
                      >
                        ✕ Cancel
                      </button>
                    </div>
                  )}
                  {chainLength > 0 && (
                    <button
                      onClick={() => setShowIntegrityModal(true)}
                      className="integrity-chain-button"
                      title="View cryptographic integrity chain for this session"
                    >
                      Cryptographic Chain ({chainLength})
                    </button>
                  )}
                </div>
              </div>

              {showIntegrityModal && (
                <IntegrityChainModal
                  chain={getChain()}
                  operationId={agentId}
                  operationName={agent?.name ?? ''}
                  onClose={() => setShowIntegrityModal(false)}
                  onSave={(opts) => saveChain({ ...opts, operationType: 'agent-steps', projectId: projectFolder?.projectId })}
                  onList={listChains}
                  onLoad={loadChain}
                />
              )}

              <div className="agent-steps">
                {agent?.layers?.map((layer, index) => {
                  if (!stepMatchesFilter(layer)) return null;

                  const areInputsVisible = inputsVisible[layer.id] ?? false;
                  const isResultVisible = resultsVisible[layer.id] ?? true;
                  const isPreprocessingVisible = preprocessingVisible[layer.id] ?? true;
                  const isIntrospectionVisible = introspectionVisible[layer.id] ?? true;

                  return (
                    <div
                      key={layer.id}
                      id={`agent-step-${layer.id}`}
                      ref={setStepNodeRef(layer.id)}
                      className={`node-wrapper ${areInputsVisible ? 'has-right-tab' : ''} ${isSearching ? 'agent-step-loading' : ''} ${enhancingPrompts[layer.id] || enhancingUserInputs[layer.id] ? 'enhancing-active' : ''} ${draggingStepId === layer.id ? 'is-dragging' : ''} ${dragOverStepId === layer.id && draggingStepId !== layer.id ? 'is-drag-over' : ''} ${justDroppedStepId === layer.id ? 'just-dropped' : ''}`}
                      style={{ position: 'relative', overflow: 'visible' }}
                      onDragOver={(e) => handleStepDragOver(e, layer.id)}
                      onDrop={(e) => handleStepDrop(e, layer.id)}
                    >
                      {isSearching && (
                        <div className="agent-step-loading-overlay">
                          <div className="cube-spinner">
                            <div className="cube">
                              <div className="cube-face front"></div>
                              <div className="cube-face back"></div>
                              <div className="cube-face right"></div>
                              <div className="cube-face left"></div>
                              <div className="cube-face top"></div>
                              <div className="cube-face bottom"></div>
                            </div>
                          </div>
                        </div>
                      )}

                      {}
                      <div className="node-summary">
                        <div className="step-header-left">
                          {editingStep === layer.id ? (
                            <input
                              className="step-name-input"
                              value={layer.name}
                              onChange={e => updateNodeField(layer.id, 'name', e.target.value)}
                              onBlur={() => setEditingStep(null)}
                              onKeyDown={e => e.key === 'Enter' && setEditingStep(null)}
                              autoFocus
                            />
                          ) : (
                            <span
                              className="editable-step-name"
                              title={layer.name}
                              onClick={() => setEditingStep(layer.id)}
                              onMouseEnter={e => handleMouseEnter(e, 'Click to edit step name')}
                              onMouseLeave={handleMouseLeave}
                            >
                              {layer.name}
                            </span>
                          )}
                          <AgentFilesIndicator metadata={agent?.metadata} />
                        </div>

                        {}
                        <div className="step-tag-area" style={{ position: 'relative' }}>
                          {editingTag === layer.id ? (
                            <input
                              className="step-tag-inline-input"
                              value={tagDraft}
                              autoFocus
                              placeholder="collection name…"
                              onChange={(e) => setTagDraft(e.target.value)}
                              onBlur={() => {
                                const val = tagDraft.trim();
                                updateStep(layer.id, 'tag', val || undefined);
                                setEditingTag(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  const val = tagDraft.trim();
                                  updateStep(layer.id, 'tag', val || undefined);
                                  setEditingTag(null);
                                } else if (e.key === 'Escape') {
                                  setEditingTag(null);
                                }
                              }}
                            />
                          ) : showTagPicker === layer.id ? (
                            (() => {
                              const existingTags = Array.from(
                                new Set((agent?.layers || []).filter(l => l.id !== layer.id && l.tag).map(l => l.tag as string))
                              );
                              return (
                                <div className="step-tag-picker" onMouseDown={(e) => e.preventDefault()}>
                                  {existingTags.map(tag => (
                                    <button
                                      key={tag}
                                      className="step-tag-picker-option"
                                      style={{
                                        backgroundColor: getTagColor(tag).bg,
                                        borderColor: getTagColor(tag).border,
                                        color: getTagColor(tag).text }}
                                      onMouseDown={() => {
                                        updateStep(layer.id, 'tag', tag);
                                        setShowTagPicker(null);
                                      }}
                                    >
                                      {tag}
                                    </button>
                                  ))}
                                  <button
                                    className="step-tag-picker-new"
                                    onMouseDown={() => {
                                      setShowTagPicker(null);
                                      setTagDraft('');
                                      setEditingTag(layer.id);
                                    }}
                                  >
                                    + new collection…
                                  </button>
                                </div>
                              );
                            })()
                          ) : layer.tag ? (
                            <span
                              className="step-tag-pill"
                              style={{
                                backgroundColor: getTagColor(layer.tag).bg,
                                borderColor: getTagColor(layer.tag).border,
                                color: getTagColor(layer.tag).text }}
                              onClick={() => { setTagDraft(layer.tag ?? ''); setEditingTag(layer.id); }}
                              title="Click to edit collection tag"
                            >
                              {layer.tag}
                            </span>
                          ) : (
                            <button
                              className="step-tag-add-btn"
                              onClick={() => {
                                const existingTags = (agent?.layers || []).filter(l => l.id !== layer.id && l.tag);
                                if (existingTags.length > 0) {
                                  setShowTagPicker(layer.id);
                                } else {
                                  setTagDraft('');
                                  setEditingTag(layer.id);
                                }
                              }}
                              onBlur={() => setShowTagPicker(null)}
                              title="Add to a collection"
                            >
                              + collection
                            </button>
                          )}
                        </div>

                        <div className="agent-step-controls">
                          <div className="agent-step-run-area">
                          {(() => {
                            const activeTab = stepInputTab[layer.id] || 'text';
                            const isCorpusTab = activeTab === 'corpus' && Boolean(stepCorpusIds[layer.id]);
                            const corpusDocsLoading = isCorpusTab && Boolean(stepCorpusDocumentsLoading[layer.id]);
                            const corpusDocs = (stepCorpusDocuments[layer.id] || []).filter((d: { state: string }) => d.state !== 'FAILED');
                            const isCorpusEmpty = isCorpusTab
                              && !corpusDocsLoading
                              && corpusDocs.length > 0
                              && (stepDocumentSelections[layer.id] || []).length === 0;
                            const isDisabled = Boolean(runningSteps[layer.id]) || isAnyStepRunning || isCorpusEmpty || corpusDocsLoading;
                            const runTitle = corpusDocsLoading
                              ? 'Loading corpus documents…'
                              : isCorpusEmpty
                                ? 'Select at least one document in the corpus'
                                : runningSteps[layer.id]
                                  ? 'Step is running...'
                                  : 'Run this step';
                            return (
                          <button
                            className="icon-btn run-btn"
                            title={runTitle}
                            onClick={() => {
                              const bibCorpus = (layer.bibliography || []).filter(b => b.type === 'corpus');
                              if (bibCorpus.length > 0 && stepCorpusIds[layer.id]) {
                                const allCorpusDocs = (stepCorpusDocuments[layer.id] || []).filter(d => d.state !== 'FAILED');
                                const liveDocNames = new Set(allCorpusDocs.map(d => d.pdfName));
                                const missingFromCorpus = bibCorpus.filter(b => !liveDocNames.has(b.name));
                                if (missingFromCorpus.length > 0) {
                                  const names = missingFromCorpus.map(b => b.source ? `${b.name} (${b.source})` : b.name);
                                  if (!confirm(`⚠️ Bibliography references document(s) not in this corpus:\n\n• ${names.join('\n• ')}\n\nAre you sure you want to continue?`)) return;
                                }
                              }
                              runStep(layer.id);
                            }}
                            disabled={isDisabled}
                            onMouseEnter={e => handleMouseEnter(e, runTitle)}
                            onMouseLeave={handleMouseLeave}
                          >
                            {runningSteps[layer.id] ? <FaSpinner className="spinning" /> : <FaPlay />}
                          </button>
                            );
                          })()}

                          <div className="agent-step-actions" aria-label="Step options">
                            <button
                              className="icon-btn duplicate-btn"
                              title="Duplicate this step"
                              onClick={() => duplicateStep(layer.id)}
                              onMouseEnter={e => handleMouseEnter(e, 'Duplicate this step with all settings')}
                              onMouseLeave={handleMouseLeave}
                            >
                              <FaClone />
                            </button>

                            <select
                              className="detail-select"
                              value={isValidModel(layer.selectedModel) ? layer.selectedModel : DEFAULT_MODEL}
                              onChange={(e) => {
                                if (canSelectStepModel(e.target.value, models)) updateStep(layer.id, 'selectedModel', e.target.value);
                              }}
                              title="Model"
                            >
                              <StepModelOptions models={modelOptions} selectedModel={isValidModel(layer.selectedModel) ? layer.selectedModel : DEFAULT_MODEL} />
                            </select>

                            <select
                              className="detail-select"
                              value={stepThinkingLevel[layer.id] ?? 'low'}
                              onChange={(e) => setStepThinkingLevel(prev => ({ ...prev, [layer.id]: e.target.value as 'minimal' | 'low' | 'medium' | 'high' }))}
                              title="Thinking depth: how hard the model reasons before answering. Minimal is fastest (recommended for corpus fact-retrieval and heavy models like gemini-3.5-flash); High is deepest but slowest."
                            >
                              <option value="minimal">Thinking: Minimal</option>
                              <option value="low">Thinking: Low</option>
                              <option value="medium">Thinking: Medium</option>
                              <option value="high">Thinking: High</option>
                            </select>

                            <label
                              className="preprocess-toggle"
                              title={`Pre-process: extract structured data before the step runs and send it to the LLM as context.

• Document Extraction (when Upload tab has files): extracts tables, figures, and key data points by page from your PDFs; preserves exact numbers, units, and precision.

• Prompt Data (always when enabled): extracts key parameters, numerical values, requirements, constraints, and claims from this step's System Instruction, User Instruction, and User Input text.

All extracted data is appended to the "Context" section of the prompt sent to the model, so the final answer is generated with this structured summary in addition to your instructions. Results appear above the step answer in two labelled sections: Document Extraction and Prompt Data.`}
                              onMouseEnter={quickTooltipEnter}
                              onMouseLeave={quickTooltipLeave}
                              onMouseMove={moveQuickTooltip}
                            >
                              <input
                                type="checkbox"
                                checked={preprocessingEnabled[layer.id] || false}
                                onChange={(e) => setPreprocessingEnabled(prev => ({
                                  ...prev,
                                  [layer.id]: e.target.checked
                                }))}
                              />
                              Pre-process
                            </label>

                            <label
                              className="preprocess-toggle"
                              title={stepCorpusIds[layer.id]
                                ? 'QC (Quality Control): after the step runs, extract claims from the answer and verify them against the corpus linked to this step. Results appear in a table below the answer (Supported / Partial / Mismatch / Not found). Does not block running other steps.'
                                : 'Link a corpus to this step to enable QC. When enabled, after the step runs the answer is checked against the corpus and a claims table is shown below.'}
                              style={{ opacity: stepCorpusIds[layer.id] ? 1 : 0.45, cursor: stepCorpusIds[layer.id] ? 'pointer' : 'not-allowed' }}
                              onMouseEnter={quickTooltipEnter}
                              onMouseLeave={quickTooltipLeave}
                              onMouseMove={moveQuickTooltip}
                            >
                              {stepQcRunning[layer.id] ? (
                                <FaSpinner className="fa-spin" style={{ fontSize: '0.75rem', marginRight: '4px' }} />
                              ) : (
                                <input
                                  type="checkbox"
                                  checked={Boolean(stepQcEnabled[layer.id])}
                                  disabled={!stepCorpusIds[layer.id]}
                                  onChange={e => {
                                    const enabled = e.target.checked;
                                    setStepQcEnabled(prev => ({ ...prev, [layer.id]: enabled }));
                                    if (!enabled) {
                                      setStepQcRows(prev => ({ ...prev, [layer.id]: [] }));
                                      setStepQcError(prev => ({ ...prev, [layer.id]: null }));
                                    }
                                  }}
                                />
                              )}
                              QC
                            </label>

                            <label
                              className="preprocess-toggle"
                              title="Show reasoning: when ON, the model's reasoning trace is returned alongside the answer (for inspection). Use the Thinking dropdown to control how hard the model thinks. Off by default; traces are not returned during Run All."
                              onMouseEnter={quickTooltipEnter}
                              onMouseLeave={quickTooltipLeave}
                              onMouseMove={moveQuickTooltip}
                            >
                              <input
                                type="checkbox"
                                checked={Boolean(stepIncludeThoughts[layer.id])}
                                onChange={e => setStepIncludeThoughts(prev => ({ ...prev, [layer.id]: e.target.checked }))}
                              />
                              Reasoning
                            </label>

                            <label
                              className="preprocess-toggle"
                              title="Optimize query: before searching the corpus, an extra AI call rewrites this step's query into a compact retrieval query (keeps identifiers like study IDs, drops boilerplate). Off by default; adds a small delay. Falls back to the original query if it fails."
                              onMouseEnter={quickTooltipEnter}
                              onMouseLeave={quickTooltipLeave}
                              onMouseMove={moveQuickTooltip}
                            >
                              <input
                                type="checkbox"
                                checked={Boolean(stepOptimizeQuery[layer.id])}
                                onChange={e => setStepOptimizeQuery(prev => ({ ...prev, [layer.id]: e.target.checked }))}
                              />
                              Optimize query
                            </label>

                            {index > 0 && (
                              <button
                                className="icon-btn delete-btn"
                                title="Delete this step"
                                onClick={() => removeStep(layer.id)}
                                onMouseEnter={e => handleMouseEnter(e, 'Delete this step')}
                                onMouseLeave={handleMouseLeave}
                              >
                                <FaTimes />
                              </button>
                            )}
                          </div>
                          </div>
                        </div>

                        <span
                          className={`step-drag-handle edge ${draggingStepId === layer.id ? 'dragging' : ''}`}
                          draggable
                          role="button"
                          tabIndex={0}
                          aria-label="Drag to reorder step"
                          title="Drag to reorder step"
                          onDragStart={(e) => handleStepDragStart(e, layer.id)}
                          onDragEnd={handleStepDragEnd}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </div>

                      {}
                      <div className="node-details" style={{ overflow: 'visible' }}>
                        <GalileoCatalogStatus catalog={catalog} refreshing={refreshing} onRefresh={refreshCatalog} />
                        <StepRunStatus diagnostics={layer.lastRunDiagnostics} />
                        {}
                        <StepReferenceSelector
                          allSteps={allStepsForRefs.slice(0, index)}
                          selected={layer.referencedSteps || []}
                          onChange={(steps) => updateStep(layer.id, 'referencedSteps', steps)}
                        />

                        {}
                        <label htmlFor={`user-instruction-${layer.id}`}>User instruction:</label>
                        <div style={{ position: 'relative' }}>
                          <textarea
                            id={`user-instruction-${layer.id}`}
                            className="detail-prompt"
                            value={layer.userInstruction || ''}
                            onChange={(e) => {
                              const newInstruction = e.target.value;
                              updateStep(layer.id, 'userInstruction', newInstruction);
                            }}
                            placeholder="This is the user instruction which will be sent to the model for this step. It can be a question, a task description, or any other instruction you want the model to follow."
                            rows={4}
                          />

                          {}
                          {}
                        </div>

                        <div
                          className={`test-input-heading ${isTestInputDisabled(layer) ? 'disabled' : ''}`}
                          onClick={() => !isTestInputDisabled(layer) && toggleInputsVisibility(layer.id)}
                          style={{ cursor: isTestInputDisabled(layer) ? 'not-allowed' : 'pointer' }}
                          title={isTestInputDisabled(layer) ? 'Add your prompt first' : 'Click to toggle user inputs section'}
                        >
                          <FaFileAlt size={16} />
                          Attach Data
                          {isTestInputDisabled(layer) ? (
                            <span style={{ color: '#999', fontSize: '0.9em' }}> (add your prompt first)</span>
                          ) : (
                            areInputsVisible ? <FaChevronUp /> : <FaChevronDown />
                          )}
                        </div>

                        {}
                        {areInputsVisible && (
                          <div className={`inputs-container ${isTestInputDisabled(layer) ? 'disabled' : ''}`} style={{ overflow: 'visible' }}>
                            {}
                            <div className="input-group" style={{ overflow: 'visible' }}>
                              <div style={{ display: 'flex', gap: '4px', marginBottom: '8px', borderBottom: '1px solid #e9ecef', flexWrap: 'wrap' }}>
                                {(['text', 'upload', 'bibliography', 'files', 'papers', 'corpus'] as const).map((tab) => {
                                  const isActive = (stepInputTab[layer.id] || 'text') === tab;
                                  const Icon = tab === 'text' ? FaPen : tab === 'upload' ? FaImage : tab === 'bibliography' ? FaBookOpen : tab === 'files' ? FaFileAlt : tab === 'papers' ? FaNewspaper : FaFolder;
                                  const label = tab === 'text' ? 'Input Text' : tab === 'upload' ? 'Upload' : tab === 'bibliography' ? 'Bibliography' : tab === 'files' ? 'Files' : tab === 'papers' ? 'Papers' : 'Corpus';

                                  return (
                                    <button
                                      key={tab}
                                      type="button"
                                      onClick={() => setStepInputTab(prev => ({ ...prev, [layer.id]: tab }))}
                                      style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '6px',
                                        padding: '8px 12px',
                                        fontSize: '0.8rem',
                                        border: 'none',
                                        borderBottom: isActive ? '2px solid #11074A' : '2px solid transparent',
                                        background: 'none',
                                        cursor: 'pointer',
                                        color: isActive ? '#11074A' : '#adb5bd',
                                        fontWeight: isActive ? 600 : 400,
                                        opacity: 1
                                      }}
                                      title={isActive ? label : `Switch to ${label}`}
                                      className={isActive ? 'input-tab-active' : 'input-tab-inactive'}
                                    >
                                      <Icon size={14} />
                                      {label}
                                    </button>
                                  );
                                })}
                              </div>
                              {}
                              {(stepInputTab[layer.id] || 'text') === 'text' && (
                                <div className={isDataTypeDisabled(layer, 'input') ? 'disabled-section' : ''}>
                                  <textarea
                                    id={`userinput-${layer.id}`}
                                    className="detail-prompt"
                                    value={layer.userInput || ''}
                                    disabled={isDataTypeDisabled(layer, 'input') || false}
                                    style={{
                                      opacity: isDataTypeDisabled(layer, 'input') ? 0.5 : 1,
                                      cursor: isDataTypeDisabled(layer, 'input') ? 'not-allowed' : 'text',
                                      backgroundColor: isDataTypeDisabled(layer, 'input') ? '#f8f9fa' : 'inherit'
                                    }}
                                    onChange={e => !isDataTypeDisabled(layer, 'input') && updateNodeField(layer.id, 'userInput', e.target.value)}
                                    placeholder={isDataTypeDisabled(layer, 'input') ? 'Clear other data first' : 'Enter text you want to analyze or process in this step.'}
                                    rows={4}
                                  />
                                </div>
                              )}
                              {(stepInputTab[layer.id] || 'text') === 'upload' && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                  <div
                                    role="button"
                                    tabIndex={0}
                                    className="image-paste-container"
                                    onClick={() => document.getElementById(`file-input-${layer.id}`)?.click()}
                                    onKeyDown={(e) => e.key === 'Enter' && document.getElementById(`file-input-${layer.id}`)?.click()}
                                    onPaste={(e) => handlePaste(e, layer.id)}
                                    ref={imageContainerRef}
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: '6px',
                                      padding: '6px 12px',
                                      fontSize: '0.8rem',
                                      border: '1px solid #ccc',
                                      borderRadius: '6px',
                                      cursor: 'pointer',
                                      background: '#f8f9fa',
                                      color: '#495057'
                                    }}
                                  >
                                    <FaImage size={14} />
                                    {isImageUploading ? 'Uploading…' : 'Upload Files'}
                                  </div>
                                  <input
                                    id={`file-input-${layer.id}`}
                                    type="file"
                                    accept="image/*,application/pdf,audio/*,video/*"
                                    multiple
                                    style={{ display: 'none' }}
                                    onChange={e => handleFileInputChange(e, layer.id)}
                                  />
                                  </div>
                                  {renderStepAttachments(layer.id)}
                                </div>
                              )}
                              {(stepInputTab[layer.id] || 'text') === 'bibliography' && (() => {
                                const corpusDocsForBib = (stepCorpusDocuments[layer.id] || []).filter(d => d.state !== 'FAILED');
                                const hasCorpus = Boolean(stepCorpusIds[layer.id]) && corpusDocsForBib.length > 0;
                                const bibCorpusNames = new Set(
                                  (layer.bibliography || []).filter(b => b.type === 'corpus').map(b => b.name)
                                );
                                const currentCorpusName = availableCorpora.find(c => c.id === stepCorpusIds[layer.id])?.displayName
                                  || layer.corpusDisplayName
                                  || projectCorpusLinks.find(l => l.corpusId === stepCorpusIds[layer.id])?.displayName
                                  || stepCorpusIds[layer.id] || 'Corpus';
                                const toggleCorpusBibItem = (pdfName: string) => {
                                  const corpusSource = currentCorpusName;
                                  const layerId = layer.id;
                                  setAgent(prev => {
                                    if (!prev) return prev;
                                    const next = {
                                      ...prev,
                                      layers: prev.layers.map(l => {
                                        if (l.id !== layerId) return l;
                                        const current = l.bibliography || [];
                                        const alreadyIn = current.some(b => b.type === 'corpus' && b.name === pdfName);
                                        const updated = alreadyIn
                                          ? current.filter(b => !(b.type === 'corpus' && b.name === pdfName))
                                          : [...current, { name: pdfName, path: pdfName, type: 'corpus' as const, source: corpusSource }];
                                        return { ...l, bibliography: updated };
                                      })
                                    };
                                    agentRef.current = next;
                                    return next;
                                  });
                                  triggerBibSave();
                                };
                                return (
                                <div style={{
                                  border: '1px solid #e9ecef',
                                  borderRadius: '4px',
                                  padding: '8px',
                                  minHeight: '60px',
                                  background: '#f8f9fa',
                                  fontSize: '0.85rem',
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: '8px'
                                }}>
                                  {}
                                  {layer.bibliography && layer.bibliography.length > 0 ? (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                      {layer.bibliography.map((item, index) => (
                                        <div
                                          key={index}
                                          style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'space-between',
                                            padding: '5px 8px',
                                            background: '#fff',
                                            border: `1px solid ${item.type === 'corpus' ? '#c3e6cb' : '#e3f2fd'}`,
                                            borderRadius: '4px',
                                            gap: '6px'
                                          }}
                                        >
                                          <span style={{ flex: 1, wordBreak: 'break-word', minWidth: 0 }}>
                                            <span style={{ color: item.type === 'corpus' ? '#155724' : '#1976d2', fontWeight: 500 }}>
                                              {item.type === 'corpus' ? '🗂️' : '📚'} {item.name}
                                            </span>
                                            {item.source && (
                                              <span style={{ display: 'inline-block', marginLeft: '6px', fontSize: '0.7rem', color: '#6c757d', background: '#e9ecef', borderRadius: '3px', padding: '1px 5px', verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
                                                {item.source}
                                              </span>
                                            )}
                                          </span>
                                          <button
                                            type="button"
                                            onClick={() => {
                                              const layerId = layer.id;
                                              const itemIndex = index;
                                              setAgent(prev => {
                                                if (!prev) return prev;
                                                const next = {
                                                  ...prev,
                                                  layers: prev.layers.map(l => {
                                                    if (l.id !== layerId) return l;
                                                    return { ...l, bibliography: (l.bibliography || []).filter((_, i) => i !== itemIndex) };
                                                  })
                                                };
                                                agentRef.current = next;
                                                return next;
                                              });
                                              triggerBibSave();
                                            }}
                                            style={{ background: 'none', border: 'none', color: '#dc3545', cursor: 'pointer', fontSize: '0.9rem', padding: '2px 6px', flexShrink: 0 }}
                                            title={`Remove ${item.name}`}
                                          >×</button>
                                        </div>
                                      ))}
                                    </div>
                                  ) : !hasCorpus ? (
                                    <span style={{ color: '#6c757d', fontStyle: 'italic' }}>
                                      No bibliography items. Upload a PDF or add corpus documents below.
                                    </span>
                                  ) : null}

                                  {}
                                  {hasCorpus && (() => {
                                    const unadded = corpusDocsForBib.filter(d => !bibCorpusNames.has(d.pdfName));
                                    if (unadded.length === 0) return null;
                                    return (
                                      <div style={{ flexShrink: 0 }}>
                                        <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#495057', marginBottom: '4px' }}>
                                          Add from corpus:
                                        </div>
                                        <div className="corpus-bib-list" style={{ maxHeight: '160px', overflowY: 'auto', border: '1px solid #dee2e6', borderRadius: '3px', padding: '4px', background: '#fff' }}>
                                          {unadded.map(d => (
                                            <div
                                              key={d.pdfName}
                                              onClick={() => toggleCorpusBibItem(d.pdfName)}
                                              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', padding: '4px 8px', borderRadius: '3px', fontSize: '0.8rem', cursor: 'pointer', marginBottom: '2px', border: '1px solid #e9ecef', background: '#f8f9fa' }}
                                              title="Click to add to bibliography"
                                            >
                                              <span style={{ wordBreak: 'break-word', minWidth: 0, flex: 1, color: '#212529' }}>{d.pdfName}</span>
                                              <span style={{ fontSize: '0.7rem', color: '#6c757d', background: '#e9ecef', borderRadius: '3px', padding: '1px 5px', whiteSpace: 'nowrap', flexShrink: 0 }}>{currentCorpusName}</span>
                                              <span style={{ color: '#28a745', fontWeight: 700, fontSize: '1rem', flexShrink: 0, lineHeight: 1 }}>+</span>
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    );
                                  })()}
                                </div>
                                );
                              })()}
                              {(stepInputTab[layer.id] || 'text') === 'files' && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', minHeight: '80px' }}>
                                  <ProjectFilePicker
                                    onFilesSelected={setSelectedAgentFiles}
                                    selectedFiles={selectedAgentFiles || []}
                                  />
                                  {selectedAgentFiles && selectedAgentFiles.length > 0 && (
                                    <div>
                                      <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#495057', marginBottom: '6px', display: 'block' }}>Attach to this step</span>
                                      {selectedAgentFiles.map((file) => {
                                        const attachKey = `${layer.id}-${file.id}`;
                                        const isAttaching = attachingFiles[attachKey];
                                        const isAttached = fileStates[layer.id]?.files.some(attached => getAgentInputFileSourceId(attached) === file.id) ?? false;
                                        const isTooLarge = file.size !== undefined && file.size > MAX_FILE_SIZE_BYTES;
                                        const isPdf = file.mimeType === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
                                        const buttonDisabled = isAttaching || isTooLarge || isAttached;
                                        
                                        return (
                                          <div key={file.id} className="selected-file-item" style={{
                                            display: 'flex',
                                            flexWrap: 'wrap',
                                            gap: '8px',
                                            alignItems: 'center',
                                            justifyContent: 'space-between',
                                            padding: '8px 12px',
                                            border: isTooLarge ? '1px solid #f5c6cb' : '1px solid #e9ecef',
                                            borderRadius: '6px',
                                            marginBottom: '8px',
                                            background: isTooLarge ? '#f8d7da' : '#f8f9fa'
                                          }}>
                                            <div style={{ flex: '1 1 180px', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                                              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', overflowWrap: 'anywhere' }}>
                                                <span className="file-name" style={{ maxWidth: '100%', fontWeight: '500', color: isTooLarge ? '#721c24' : 'inherit' }}>{file.name}</span>
                                                <span className="file-folder" style={{ maxWidth: '100%', color: isTooLarge ? '#721c24' : '#6c757d', opacity: 0.8 }}>({file.folderName})</span>
                                              </div>
                                              <div style={{ fontSize: '0.8rem', marginTop: '4px', display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center' }}>
                                                <span style={{ color: isTooLarge ? '#721c24' : '#28a745', fontWeight: '500' }}>
                                                  {file.size ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` : 'Unknown size'}
                                                </span>
                                                {isPdf && (
                                                  <span style={{ color: isTooLarge ? '#721c24' : '#6c757d', opacity: 0.8 }}>Pages calculated on attach</span>
                                                )}
                                                {isTooLarge && (
                                                  <span style={{ color: '#dc3545', display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 'bold' }}>
                                                    <FaExclamationTriangle size={12} /> Exceeds 30MB limit
                                                  </span>
                                                )}
                                              </div>
                                            </div>
                                            <button
                                              type="button"
                                              className={`attach-file-btn ${isAttaching ? 'loading' : ''}`}
                                              onClick={() => attachSelectedFileToStep(layer.id, file)}
                                              disabled={buttonDisabled}
                                              title={isAttached ? `${file.name} is attached to this step` : isTooLarge ? 'File is too large' : (isAttaching ? 'Downloading...' : `Attach ${file.name} to this step`)}
                                              style={{
                                                width: '150px',
                                                minHeight: '32px',
                                                flexShrink: 0,
                                                padding: '6px 12px',
                                                fontSize: '0.8rem',
                                                border: isAttached ? '1px solid #c3e6cb' : buttonDisabled ? '1px solid #6c757d' : '1px solid #007bff',
                                                borderRadius: '4px',
                                                background: isAttached ? '#e9f7ef' : buttonDisabled ? '#6c757d' : '#007bff',
                                                color: isAttached ? '#155724' : 'white',
                                                cursor: buttonDisabled ? 'not-allowed' : 'pointer'
                                              }}
                                            >
                                              {isAttaching ? (
                                                <>
                                                  <FaSpinner className="spinning" size={12} style={{ marginRight: '6px' }} />
                                                  Downloading...
                                                </>
                                              ) : (
                                                isAttached ? 'Attached' : 'Attach to Step'
                                              )}
                                            </button>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                  {renderStepAttachments(layer.id)}
                                </div>
                              )}
                              {(stepInputTab[layer.id] || 'text') === 'papers' && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', minHeight: '80px' }}>
                                  <ScientificPaperSearch
                                    onPapersSelected={setSelectedAgentPapers}
                                    selectedPapers={selectedAgentPapers || []}
                                  />
                                  {selectedAgentPapers && selectedAgentPapers.length > 0 && (
                                    <div>
                                      <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#495057', marginBottom: '6px', display: 'block' }}>Attach to this step</span>
                                      {selectedAgentPapers.map((paper) => (
                                        <div key={paper.id} className="selected-file-item" style={{
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'space-between',
                                          padding: '12px',
                                          border: '1px solid #e9ecef',
                                          borderRadius: '6px',
                                          marginBottom: '8px',
                                          background: '#f8f9fa'
                                        }}>
                                          <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                                            <span className="file-name" style={{ fontWeight: '600', marginBottom: '4px' }}>{paper.title}</span>
                                            <span className="file-folder" style={{ fontSize: '0.85rem', color: '#6b7280' }}>
                                              {paper.authors?.join(', ')} ({paper.pubdate})
                                            </span>
                                            {paper.doi && (
                                              <span style={{ fontSize: '0.8rem', color: '#9ca3af', marginTop: '2px' }}>DOI: {paper.doi}</span>
                                            )}
                                          </div>
                                          <button
                                            className="attach-file-btn"
                                            onClick={() => attachPaperToStep(layer.id, paper)}
                                            title={`Attach abstract of "${paper.title}" to this step`}
                                            style={{
                                              padding: '6px 12px',
                                              fontSize: '0.8rem',
                                              border: '1px solid #28a745',
                                              borderRadius: '4px',
                                              background: '#28a745',
                                              color: 'white',
                                              cursor: 'pointer'
                                            }}
                                          >
                                            Attach Abstract
                                          </button>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                              {(stepInputTab[layer.id] || 'text') === 'corpus' && (
                                <div>
                                  {availableCorpora.length === 0 && !stepCorpusIds[layer.id] ? (
                                    <span style={{ fontSize: '0.85rem', color: '#6c757d', fontStyle: 'italic' }}>
                                      No corpora available. Create a corpus in RAG settings first.
                                    </span>
                                  ) : (
                                  <>
                                  <CorpusPickerDropdown
                                    items={buildCorpusPickerItems(
                                      stepCorpusIds[layer.id] || '',
                                      layer.corpusDisplayName,
                                      layer.corpusOwnerEmail,
                                    )}
                                    value={stepCorpusIds[layer.id] || ''}
                                    searchable={canSearchCorpora}
                                    placeholder="None"
                                    searchPlaceholder="Search corpora by name…"
                                    createdByLabel={(name) => `by ${name}`}
                                    onChange={(newCorpusId) => {
                                      attachCorpusToStep(layer.id, newCorpusId);
                                      if (newCorpusId) {
                                        setStepInputTab(prev => ({ ...prev, [layer.id]: 'corpus' }));
                                        setStepCorpusDocumentsLoading(prev => ({ ...prev, [layer.id]: true }));
                                        fetch(`/api/rag/corpora/${encodeURIComponent(newCorpusId)}/documents${projectFolder?.projectId ? `?projectId=${encodeURIComponent(projectFolder.projectId)}` : ''}`, { credentials: 'include' })
                                          .then(r => r.ok ? r.json() : null)
                                          .then(data => {
                                            const docs = data?.documents || [];
                                            setStepCorpusDocuments(prev => ({ ...prev, [layer.id]: docs }));
                                            const hasBib = layer.bibliography && layer.bibliography.length > 0;
                                            const bibNames = new Set<string>();
                                            if (hasBib && layer.bibliography) {
                                              for (const b of layer.bibliography) {
                                                const fromPath = b.path?.split(/[/\\]/).pop()?.trim();
                                                const fromName = b.name?.trim();
                                                if (fromPath) bibNames.add(fromPath);
                                                if (fromName) bibNames.add(fromName);
                                              }
                                            }
                                            const isInBib = (pdfName: string) =>
                                              Array.from(bibNames).some(bn => pdfName === bn || pdfName.endsWith(bn) || pdfName.includes(bn));
                                            const initialSelection = hasBib
                                              ? docs.filter((d: { pdfName: string }) => isInBib(d.pdfName)).map((d: { pdfName: string }) => d.pdfName)
                                              : docs.map((d: { pdfName: string }) => d.pdfName);
                                            setStepDocumentSelections(prev => ({ ...prev, [layer.id]: initialSelection }));
                                          })
                                          .catch(() => { setStepCorpusDocuments(prev => ({ ...prev, [layer.id]: [] })); })
                                          .finally(() => { setStepCorpusDocumentsLoading(prev => ({ ...prev, [layer.id]: false })); });
                                      }
                                    }}
                                  />
                                  {stepCorpusIds[layer.id] && (() => {
                                    const isLoading = stepCorpusDocumentsLoading[layer.id];
                                    const liveDocs = (stepCorpusDocuments[layer.id] || []).filter(d => d.state !== 'FAILED');
                                    // Gate docs still indexing (PROCESSING) — but only when the corpus has
                                    // at least one ACTIVE doc, so a corpus that reports no states at all
                                    // (Gemini can omit them) never becomes fully unselectable.
                                    const hasActiveDoc = liveDocs.some(d => d.state === 'ACTIVE');
                                    const isIndexing = (d: StepCorpusDoc) => hasActiveDoc && d.state === 'PROCESSING';
                                    const selectableDocs = liveDocs.filter(d => !isIndexing(d));
                                    const checked = stepDocumentSelections[layer.id] || [];
                                    const toggle = (name: string) => {
                                      setStepDocumentSelections(prev => {
                                        const cur = prev[layer.id] || [];
                                        if (cur.includes(name)) {
                                          return { ...prev, [layer.id]: cur.filter(n => n !== name) };
                                        }
                                        return { ...prev, [layer.id]: [...cur, name] };
                                      });
                                    };

                                    const hasBibliography = layer.bibliography && layer.bibliography.length > 0;
                                    const bibPdfNames = new Set<string>();
                                    if (hasBibliography && layer.bibliography) {
                                      for (const b of layer.bibliography) {
                                        const fromPath = b.path?.split(/[/\\]/).pop()?.trim();
                                        const fromName = b.name?.trim();
                                        if (fromPath) bibPdfNames.add(fromPath);
                                        if (fromName) bibPdfNames.add(fromName);
                                      }
                                    }
                                    const isInBibliography = (pdfName: string) =>
                                      Array.from(bibPdfNames).some(
                                        (bibName) =>
                                          pdfName === bibName || pdfName.endsWith(bibName) || pdfName.includes(bibName)
                                      );

                                    if (isLoading) {
                                      return (
                                        <div style={{ marginTop: '6px', fontSize: '0.78rem', color: '#6c757d' }}>Loading documents…</div>
                                      );
                                    }
                                    if (liveDocs.length === 0) {
                                      const cid = stepCorpusIds[layer.id];
                                      const isSharedCorpus = !availableCorpora.some(c => c.id === cid || c.corpusId === cid);
                                      return (
                                        <div style={{ marginTop: '6px', fontSize: '0.78rem', color: '#495057', background: '#f1f3f9', border: '1px solid #dfe3f0', borderRadius: '6px', padding: '8px 10px', lineHeight: 1.45 }}>
                                          {isSharedCorpus ? (
                                            <>
                                              <strong style={{ color: '#11074A' }}>Shared corpus — file list not synced yet.</strong><br />
                                              The individual files sync automatically the first time the corpus&apos;s owner opens this project. Until then this step still works — it searches the <strong>whole corpus</strong> — you just can&apos;t pick specific documents yet.
                                            </>
                                          ) : (
                                            <>
                                              <strong style={{ color: '#11074A' }}>No documents to list yet.</strong><br />
                                              This corpus may still be indexing. You can still run this step now — it searches the <strong>whole corpus</strong>.
                                            </>
                                          )}
                                        </div>
                                      );
                                    }
                                    return (
                                      <div style={{ marginTop: '6px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
                                          <span style={{ fontSize: '0.75rem', color: '#6c757d' }}>
                                            Documents ({checked.length === 0 ? 'none' : checked.length === selectableDocs.length ? 'all' : `${checked.length} of ${selectableDocs.length}`}):
                                          </span>
                                          {checked.length < selectableDocs.length && (
                                            <button
                                              type="button"
                                              onClick={() => setStepDocumentSelections(prev => ({ ...prev, [layer.id]: selectableDocs.map(d => d.pdfName) }))}
                                              style={{ fontSize: '0.72rem', background: 'none', border: 'none', color: '#11074A', cursor: 'pointer', padding: '0', textDecoration: 'underline' }}
                                            >
                                              Select All
                                            </button>
                                          )}
                                          {checked.length > 0 && (
                                            <button
                                              type="button"
                                              onClick={() => setStepDocumentSelections(prev => ({ ...prev, [layer.id]: [] }))}
                                              style={{ fontSize: '0.72rem', background: 'none', border: 'none', color: '#6c757d', cursor: 'pointer', padding: '0', textDecoration: 'underline' }}
                                            >
                                              Deselect All
                                            </button>
                                          )}
                                        </div>
                                        <div className="documents-checkbox-list" style={{ maxHeight: '140px', overflowY: 'auto', border: '1px solid #e9ecef', borderRadius: '4px', padding: '4px', textAlign: 'left' }}>
                                          {liveDocs.map(d => {
                                            const indexing = isIndexing(d);
                                            const inBib = isInBibliography(d.pdfName);
                                            const isChecked = checked.includes(d.pdfName);
                                            const warnOutOfBib = isChecked && !inBib;
                                            const warnInBibNotSelected = inBib && !isChecked;
                                            return (
                                              <label
                                                key={d.pdfName}
                                                style={{
                                                  display: 'flex',
                                                  alignItems: 'flex-start',
                                                  justifyContent: 'flex-start',
                                                  gap: '8px',
                                                  padding: '4px 6px',
                                                  cursor: indexing ? 'not-allowed' : 'pointer',
                                                  borderRadius: '3px',
                                                  fontSize: '0.8rem',
                                                  width: '100%',
                                                  textAlign: 'left',
                                                  ...(indexing ? { opacity: 0.55 } : {}),
                                                  ...(inBib && isChecked ? { backgroundColor: '#e8f4fd', border: '1px solid #b8daff' } : {}),
                                                  ...(warnOutOfBib ? { backgroundColor: '#fff8e1', border: '1px solid #ffe082' } : {}),
                                                  ...(warnInBibNotSelected ? { backgroundColor: '#fff5f5', border: '1px solid #f8d7da' } : {})
                                                }}
                                              >
                                                <input
                                                  type="checkbox"
                                                  checked={isChecked}
                                                  disabled={indexing}
                                                  onChange={() => { if (!indexing) toggle(d.pdfName); }}
                                                  style={{ marginTop: '2px', flexShrink: 0, width: 'auto', minWidth: '1rem' }}
                                                />
                                                <span
                                                  style={{
                                                    flex: 1,
                                                    overflow: 'visible',
                                                    textOverflow: 'unset',
                                                    whiteSpace: 'normal',
                                                    wordBreak: 'break-word',
                                                    lineHeight: 1.2,
                                                    textAlign: 'left',
                                                    ...(inBib && isChecked ? { fontWeight: 600 as const, color: '#0d6efd' } : {}),
                                                    ...(warnInBibNotSelected ? { fontWeight: 600 as const, color: '#dc3545' } : {})
                                                  }}
                                                  title={d.pdfName}
                                                >
                                                  {d.pdfName}
                                                </span>
                                                {indexing && (
                                                  <span
                                                    title="This document is still indexing and can't be queried yet."
                                                    style={{ flexShrink: 0, fontSize: '0.68rem', color: '#b45309', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: '3px', padding: '0 5px', lineHeight: 1.6 }}
                                                  >indexing…</span>
                                                )}
                                                {warnOutOfBib && (
                                                  <span
                                                    title="This document is not in your bibliography — it may not relate to your uploaded files"
                                                    style={{ flexShrink: 0, fontSize: '0.75rem', color: '#f59e0b', lineHeight: 1.2 }}
                                                  >⚠️</span>
                                                )}
                                                {warnInBibNotSelected && (
                                                  <span
                                                    title="This bibliography document is not selected — it won't be queried in this run"
                                                    style={{ flexShrink: 0, fontSize: '0.75rem', color: '#dc3545', lineHeight: 1.2 }}
                                                  >❗</span>
                                                )}
                                              </label>
                                            );
                                          })}
                                        </div>
                                        {checked.some(n => !isInBibliography(n)) && (
                                          <span style={{ fontSize: '0.7rem', color: '#b45309', display: 'block', marginTop: '3px' }}>
                                            ⚠️ Some selected documents are not in your bibliography.
                                          </span>
                                        )}
                                        {liveDocs.some(d => isInBibliography(d.pdfName) && !checked.includes(d.pdfName)) && (
                                          <span style={{ fontSize: '0.7rem', color: '#dc3545', display: 'block', marginTop: '3px' }}>
                                            ❗ Some bibliography documents are not selected — they won't be queried in this run.
                                          </span>
                                        )}
                                        {(() => {
                                          const liveDocNames = new Set(liveDocs.map(d => d.pdfName));
                                          const missingFromCorpus = (layer.bibliography || [])
                                            .filter(b => b.type === 'corpus' && !liveDocNames.has(b.name));
                                          if (missingFromCorpus.length === 0) return null;
                                          return (
                                            <div style={{ fontSize: '0.7rem', color: '#dc3545', marginTop: '3px' }}>
                                              <div style={{ marginBottom: '2px' }}>⚠️ Bibliography references document(s) not in this corpus:</div>
                                              <ul style={{ margin: '2px 0 0 16px', paddingLeft: '4px' }}>
                                                {missingFromCorpus.map(b => (
                                                  <li key={b.name} style={{ marginBottom: '1px' }}>{b.name}{b.source ? ` (${b.source})` : ''}</li>
                                                ))}
                                              </ul>
                                            </div>
                                          );
                                        })()}
                                        <span style={{ fontSize: '0.7rem', color: checked.length === 0 ? '#dc3545' : '#adb5bd' }}>
                                          {checked.length === 0
                                            ? 'No documents selected — run is disabled. Select at least one.'
                                            : 'All documents searched when all are selected.'}
                                        </span>
                                      </div>
                                    );
                                  })()}
                                  </>
                                  )}
                                </div>
                              )}
                            </div>

                            {}
                            {!stepCorpusIds[layer.id] && expandedPdfOptions === layer.id && pendingSplitPdf && (
                              <div style={{
                                marginTop: '16px',
                                padding: '16px',
                                border: '2px solid #e5e7eb',
                                borderRadius: '8px',
                                backgroundColor: '#f8f9fa',
                                animation: 'slideDown 0.3s ease-out'
                              }}>
                                <div style={{ display: 'flex', alignItems: 'center', marginBottom: '12px' }}>
                                  <FaExclamationTriangle style={{ color: '#6b7280', marginRight: '8px' }} />
                                  <h4 style={{ margin: 0, color: '#374151', fontSize: '16px', fontWeight: '600' }}>
                                    Large PDF Detected
                                  </h4>
                                </div>

                                <p style={{ margin: '0 0 16px 0', color: '#374151', fontSize: '14px', lineHeight: '1.5' }}>
                                  <strong>{pendingSplitPdf.file.name}</strong> has <strong>{pendingSplitPdf.pageCount} pages</strong>.
                                  Are you sure you need all the pages? More pages, less precision.
                                </p>

                                <div style={{ marginBottom: '16px' }}>
                                  <h5 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: '600', color: '#6b7280' }}>
                                    Choose an option:
                                  </h5>

                                  {}
                                  <div style={{
                                    padding: '12px',
                                    backgroundColor: '#fff',
                                    borderRadius: '6px',
                                    border: '1px solid #e5e7eb',
                                    marginBottom: '12px'
                                  }}>
                                    <label style={{ display: 'block', marginBottom: '8px', fontSize: '13px', fontWeight: '500', color: '#374151' }}>
                                      Extract specific page range:
                                    </label>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                      <span style={{ fontSize: '13px' }}>From page:</span>
                                      <input
                                        type="number"
                                        min="1"
                                        max={pendingSplitPdf.pageCount}
                                        value={pdfRangeStart}
                                        onChange={(e) => setPdfRangeStart(Math.max(1, parseInt(e.target.value) || 1))}
                                        style={{
                                          width: '70px',
                                          padding: '4px 8px',
                                          border: '1px solid #ddd',
                                          borderRadius: '4px',
                                          fontSize: '13px'
                                        }}
                                      />
                                      <span style={{ fontSize: '13px' }}>to page:</span>
                                      <input
                                        type="number"
                                        min={pdfRangeStart}
                                        max={pendingSplitPdf.pageCount}
                                        value={pdfRangeEnd}
                                        onChange={(e) => setPdfRangeEnd(Math.min(pendingSplitPdf.pageCount, parseInt(e.target.value) || pdfRangeStart))}
                                        style={{
                                          width: '70px',
                                          padding: '4px 8px',
                                          border: '1px solid #ddd',
                                          borderRadius: '4px',
                                          fontSize: '13px'
                                        }}
                                      />
                                      <button
                                        onClick={handlePdfRangeExtract}
                                        disabled={splittingInProgress}
                                        style={{
                                          padding: '6px 12px',
                                          fontSize: '13px',
                                          backgroundColor: splittingInProgress ? '#9ca3af' : '#11074A',
                                          color: 'white',
                                          border: 'none',
                                          borderRadius: '4px',
                                          cursor: splittingInProgress ? 'not-allowed' : 'pointer'
                                        }}
                                      >
                                        {splittingInProgress ? 'Extracting...' : 'Extract Range'}
                                      </button>
                                    </div>
                                  </div>

                                  {}
                                  {splittingInProgress && (
                                    <div style={{
                                      marginBottom: '12px',
                                      padding: '12px',
                                      backgroundColor: '#f8f9fa',
                                      borderRadius: '6px',
                                      border: '1px solid #e5e7eb'
                                    }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <div style={{
                                          width: '16px',
                                          height: '16px',
                                          border: '2px solid #11074A',
                                          borderTop: '2px solid transparent',
                                          borderRadius: '50%',
                                          animation: 'spin 1s linear infinite'
                                        }}></div>
                                        <span style={{ fontSize: '13px', fontWeight: '500', color: '#374151' }}>
                                          {splittingProgress || 'Processing...'}
                                        </span>
                                      </div>
                                    </div>
                                  )}

                                  {}
                                  <div style={{
                                    display: 'flex',
                                    gap: '8px',
                                    flexWrap: 'wrap',
                                    justifyContent: 'flex-start'
                                  }}>
                                    <button
                                      onClick={handlePdfSplitRequest}
                                      disabled={splittingInProgress}
                                      style={{
                                        padding: '8px 16px',
                                        fontSize: '13px',
                                        backgroundColor: splittingInProgress ? '#9ca3af' : '#11074A',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '4px',
                                        cursor: splittingInProgress ? 'not-allowed' : 'pointer'
                                      }}
                                    >
                                      {splittingInProgress ? 'Splitting...' : 'Split by size (30MB chunks)'}
                                    </button>

                                    <button
                                      onClick={handlePdfSplitOriginal}
                                      disabled={splittingInProgress}
                                      style={{
                                        padding: '8px 16px',
                                        fontSize: '13px',
                                        backgroundColor: splittingInProgress ? '#9ca3af' : '#6c757d',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '4px',
                                        cursor: splittingInProgress ? 'not-allowed' : 'pointer'
                                      }}
                                    >
                                      Keep original (may be slow)
                                    </button>

                                    <button
                                      onClick={handlePdfSplitCancel}
                                      disabled={splittingInProgress}
                                      style={{
                                        padding: '8px 16px',
                                        fontSize: '13px',
                                        backgroundColor: splittingInProgress ? '#9ca3af' : '#6c757d',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '4px',
                                        cursor: splittingInProgress ? 'not-allowed' : 'pointer'
                                      }}
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              </div>
                            )}

                            {}
                            {(runningSteps[layer.id] || executionErrors[layer.id] ||
                              (layer.result != null && String(layer.result).trim().length > 0) ||
                              (layer.outputHistory?.length ?? 0) > 0 ||
                              getLayerImageUrls(layer).length > 0 ||
                              preprocessingResults[layer.id]?.document ||
                              preprocessingResults[layer.id]?.prompt) && (
                              <div className="input-group">
                                <label>Result</label>
                                <OutputFrame layer={layer} running={Boolean(runningSteps[layer.id])} error={executionErrors[layer.id]}>
                                <div className="chain-result">
                                  <div style={{
                                    background: '#f8f9fa',
                                    padding: '8px 16px',
                                    borderBottom: '1px solid #e9ecef',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'flex-end'
                                  }}>
                                    <div className="result-actions" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', maxWidth: '100%', gap: '8px' }}>
                                      {isResultVisible && layer.result?.trim() && (
                                        <>
                                          <div style={{ position: 'relative', display: 'inline-block' }}>
                                            <button
                                              className="icon-btn"
                                              disabled={analyzingSteps[layer.id]}
                                              onClick={() => analyzeStepOutput(layer.id)}
                                              title={analyzingSteps[layer.id] ? 'Processing...' : 'AI Introspection'}
                                              style={{
                                                padding: '4px 8px',
                                                border: '1px solid #dee2e6',
                                                borderRadius: '4px',
                                                background: analyzingSteps[layer.id] ? '#f8f9fa' : '#ffffff',
                                                cursor: analyzingSteps[layer.id] ? 'not-allowed' : 'pointer',
                                                opacity: analyzingSteps[layer.id] ? 0.8 : 1
                                              }}
                                            >
                                              {analyzingSteps[layer.id] ? <FaSpinner className="fa-spin" /> : <FaBrain />}
                                            </button>
                                            {analyzingSteps[layer.id] && currentAnalysisStep[layer.id] && (
                                              <div style={{
                                                position: 'absolute',
                                                left: '-140px',
                                                top: '50%',
                                                transform: 'translateY(-50%)',
                                                background: 'linear-gradient(135deg, #f8fafe 0%, #f1f6fe 100%)',
                                                color: '#5e72e4',
                                                fontSize: '0.7rem',
                                                padding: '3px 8px',
                                                borderRadius: '12px',
                                                border: '1px solid #e8eef7',
                                                whiteSpace: 'nowrap',
                                                boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
                                                zIndex: 10
                                              }}>
                                                {currentAnalysisStep[layer.id]}
                                              </div>
                                            )}
                                          </div>
                                          <button
                                            className="icon-btn"
                                            onClick={() => copyToClipboard(layer.result!)}
                                            onMouseEnter={e => handleMouseEnter(e, 'Copy entire result')}
                                            onMouseLeave={handleMouseLeave}
                                            title="Copy"
                                            style={{
                                              padding: '4px 8px',
                                              border: '1px solid #dee2e6',
                                              borderRadius: '4px',
                                              background: '#ffffff',
                                              cursor: 'pointer'
                                            }}
                                          >
                                            <FaCopy />
                                          </button>
                                          <button
                                            className="icon-btn"
                                            onClick={() => downloadAsText(layer.result!, layer.name)}
                                            onMouseEnter={e => handleMouseEnter(e, 'Download result')}
                                            onMouseLeave={handleMouseLeave}
                                            title="Download"
                                            style={{
                                              padding: '4px 8px',
                                              border: '1px solid #dee2e6',
                                              borderRadius: '4px',
                                              background: '#ffffff',
                                              cursor: 'pointer'
                                            }}
                                          >
                                            <FaDownload />
                                          </button>
                                          <button
                                            className="icon-btn"
                                            onClick={() => exportStepResultToGoogleDrive(layer.id)}
                                            title="Export to Google Drive"
                                            style={{
                                              padding: '4px 8px',
                                              border: '1px solid #dee2e6',
                                              borderRadius: '4px',
                                              background: '#ffffff',
                                              cursor: 'pointer'
                                            }}
                                          >
                                            <FaGoogleDrive />
                                          </button>
                                          <button
                                            className="icon-btn"
                                            onClick={() => exportStepResultToGoogleDocs(layer.id)}
                                            title="Export to Google Docs"
                                            style={{
                                              padding: '4px 8px',
                                              border: '1px solid #dee2e6',
                                              borderRadius: '4px',
                                              background: '#ffffff',
                                              cursor: 'pointer'
                                            }}
                                          >
                                            <FaFileAlt />
                                          </button>
                                          <button
                                            className="icon-btn"
                                            onClick={() => setDebugPanelLayerId(layer.id)}
                                            onMouseEnter={e => handleMouseEnter(e, 'How this answer was crafted')}
                                            onMouseLeave={handleMouseLeave}
                                            title="How this answer was crafted"
                                            style={{
                                              padding: '4px 8px',
                                              border: '1px solid #dee2e6',
                                              borderRadius: '4px',
                                              background: layer.debugInfo ? '#ffffff' : '#f8f9fa',
                                              cursor: 'pointer'
                                            }}
                                          >
                                            <FaBug />
                                          </button>
                                          {(() => {
                                            const hasCorpus = Boolean(stepCorpusIds[layer.id]);
                                            const qcBusy =
                                              stepQcRunning[layer.id] ||
                                              stepQcPhase[layer.id] === 'extracting' ||
                                              stepQcPhase[layer.id] === 'verifying';
                                            return (
                                              <button
                                                className="icon-btn"
                                                disabled={!hasCorpus || qcBusy}
                                                onClick={() => {
                                                  setStepQcEnabled(prev => ({ ...prev, [layer.id]: true }));
                                                  runStepQc(layer.id, layer.result);
                                                }}
                                                onMouseEnter={e => handleMouseEnter(e, hasCorpus ? 'Run QC — verify this answer against the linked corpus' : 'Link a corpus to this step to run QC')}
                                                onMouseLeave={handleMouseLeave}
                                                title={hasCorpus ? 'Run QC' : 'Link a corpus to run QC'}
                                                style={{
                                                  padding: '4px 8px',
                                                  border: '1px solid #dee2e6',
                                                  borderRadius: '4px',
                                                  background: '#ffffff',
                                                  cursor: !hasCorpus || qcBusy ? 'not-allowed' : 'pointer',
                                                  color: '#5e72e4',
                                                  opacity: hasCorpus ? 1 : 0.45
                                                }}
                                              >
                                                {qcBusy ? <FaSpinner className="fa-spin" /> : <FaShieldAlt />}
                                              </button>
                                            );
                                          })()}
                                        </>
                                      )}
                                      <button
                                        className="icon-btn"
                                        onClick={() => toggleResultVisibility(layer.id)}
                                        onMouseEnter={e => handleMouseEnter(e, isResultVisible ? 'Hide result' : 'Show result')}
                                        onMouseLeave={handleMouseLeave}
                                        title={isResultVisible ? 'Hide result' : 'Show result'}
                                        style={{
                                          padding: '4px 8px',
                                          border: '1px solid #dee2e6',
                                          borderRadius: '4px',
                                          background: '#ffffff',
                                          cursor: 'pointer'
                                        }}
                                      >
                                        {isResultVisible ? <FaEyeSlash /> : <FaEye />}
                                      </button>
                                    </div>
                                  </div>
                                  {isResultVisible && (
                                    <div style={{ padding: '16px' }}>

                                      {}
                                      {(preprocessingResults[layer.id]?.document || preprocessingResults[layer.id]?.prompt) && (
                                        <div style={{
                                          marginBottom: '24px',
                                          padding: '16px',
                                          background: 'linear-gradient(135deg, #11074A 0%, #4A4453 100%)',
                                          borderRadius: '12px',
                                          border: '1px solid #AFA8BA'
                                        }}>
                                          <div style={{
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            alignItems: 'center',
                                            marginBottom: '12px'
                                          }}>
                                            <h4
                                              onClick={() => togglePreprocessingVisibility(layer.id)}
                                              style={{
                                                margin: '0',
                                                color: 'white',
                                                fontSize: '1.1rem',
                                                fontWeight: '600',
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '8px',
                                                cursor: 'pointer',
                                                userSelect: 'none',
                                                transition: 'all 0.2s ease',
                                                borderRadius: '6px',
                                                padding: '4px 8px'
                                              }}
                                              title={`Pre-process Output — the structured data that was sent to the LLM as context for this step.

• Document Extraction (if present): tables, figures, and key data extracted from uploaded files, by page; sent as "DOCUMENT STRUCTURED DATA" in the prompt.

• Prompt Data (if present): parameters, requirements, and claims extracted from the step's instruction and input text; sent as "PROMPT STRUCTURED DATA" in the prompt.

This block appears above the step answer. Click to expand/collapse. You can download or export to Drive/Docs.`}
                                              onMouseEnter={(e) => {
                                                e.currentTarget.style.background = 'rgba(255,255,255,0.1)';
                                                quickTooltipEnter(e);
                                              }}
                                              onMouseLeave={(e) => {
                                                e.currentTarget.style.background = 'transparent';
                                                quickTooltipLeave(e);
                                              }}
                                              onMouseMove={moveQuickTooltip}
                                            >
                                              <FaFileAlt style={{ fontSize: '1rem' }} />
                                              Pre-process Output
                                              {isPreprocessingVisible ?
                                                <FaChevronUp style={{ fontSize: '0.8rem', marginLeft: '4px' }} /> :
                                                <FaChevronDown style={{ fontSize: '0.8rem', marginLeft: '4px' }} />
                                              }
                                            </h4>

                                            {}
                                            <div style={{ display: 'flex', gap: '6px' }}>
                                              <button
                                                onClick={() => togglePreprocessingVisibility(layer.id)}
                                                title={isPreprocessingVisible ? 'Hide preprocessing output' : 'Show preprocessing output'}
                                                style={{
                                                  padding: '6px 8px',
                                                  border: '1px solid rgba(255,255,255,0.3)',
                                                  borderRadius: '6px',
                                                  background: 'rgba(255,255,255,0.1)',
                                                  color: 'white',
                                                  cursor: 'pointer',
                                                  fontSize: '0.85rem',
                                                  display: 'flex',
                                                  alignItems: 'center',
                                                  gap: '4px'
                                                }}
                                              >
                                                {isPreprocessingVisible ? <FaEyeSlash style={{ fontSize: '0.8rem' }} /> : <FaEye style={{ fontSize: '0.8rem' }} />}
                                              </button>
                                              <button
                                                onClick={() => downloadPreprocessingResults(layer.id)}
                                                title="Download as Markdown"
                                                style={{
                                                  padding: '6px 8px',
                                                  border: '1px solid rgba(255,255,255,0.3)',
                                                  borderRadius: '6px',
                                                  background: 'rgba(255,255,255,0.1)',
                                                  color: 'white',
                                                  cursor: 'pointer',
                                                  fontSize: '0.85rem',
                                                  display: 'flex',
                                                  alignItems: 'center',
                                                  gap: '4px'
                                                }}
                                              >
                                                <FaDownload style={{ fontSize: '0.8rem' }} />
                                                Download
                                              </button>
                                              <button
                                                onClick={() => exportPreprocessingToGoogleDrive(layer.id)}
                                                title="Export to Google Drive"
                                                style={{
                                                  padding: '6px 8px',
                                                  border: '1px solid rgba(255,255,255,0.3)',
                                                  borderRadius: '6px',
                                                  background: 'rgba(255,255,255,0.1)',
                                                  color: 'white',
                                                  cursor: 'pointer',
                                                  fontSize: '0.85rem',
                                                  display: 'flex',
                                                  alignItems: 'center',
                                                  gap: '4px'
                                                }}
                                              >
                                                <FaGoogleDrive style={{ fontSize: '0.8rem' }} />
                                                Drive
                                              </button>
                                              <button
                                                onClick={() => exportPreprocessingToGoogleDocs(layer.id)}
                                                title="Export to Google Docs"
                                                style={{
                                                  padding: '6px 8px',
                                                  border: '1px solid rgba(255,255,255,0.3)',
                                                  borderRadius: '6px',
                                                  background: 'rgba(255,255,255,0.1)',
                                                  color: 'white',
                                                  cursor: 'pointer',
                                                  fontSize: '0.85rem',
                                                  display: 'flex',
                                                  alignItems: 'center',
                                                  gap: '4px'
                                                }}
                                              >
                                                <FaFileAlt style={{ fontSize: '0.8rem' }} />
                                                Docs
                                              </button>
                                            </div>
                                          </div>
                                          {isPreprocessingVisible && (
                                            <div style={{
                                              background: 'rgba(255,255,255,0.9)',
                                              borderRadius: '8px',
                                              padding: '12px',
                                              color: '#333',
                                              fontSize: '0.9rem',
                                              lineHeight: '1.5' }}>
                                              {}
                                              {preprocessingResults[layer.id]?.document && (
                                                <div style={{ marginBottom: preprocessingResults[layer.id]?.prompt ? '16px' : 0 }}>
                                                  <div style={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: '6px',
                                                    fontSize: '0.75rem',
                                                    fontWeight: 700,
                                                    textTransform: 'uppercase',
                                                    letterSpacing: '0.08em',
                                                    color: '#5e72e4',
                                                    marginBottom: '8px',
                                                    paddingBottom: '4px',
                                                    borderBottom: '1px solid #dee2e6' }}
                                                    title="Extracted from uploaded PDFs/files on the Upload tab. Contains tables, figures, and key data points by page (exact values, units, precision). Sent to the LLM as Context: === DOCUMENT STRUCTURED DATA === before the final answer is generated."
                                                    onMouseEnter={quickTooltipEnter}
                                                    onMouseLeave={quickTooltipLeave}
                                                    onMouseMove={moveQuickTooltip}
                                                  >
                                                    <FaFileAlt style={{ fontSize: '0.7rem' }} />
                                                    Document Extraction
                                                  </div>
                                                  <MarkdownWithMath content={preprocessingResults[layer.id]!.document!} />
                                                </div>
                                              )}

                                              {}
                                              {preprocessingResults[layer.id]?.document && preprocessingResults[layer.id]?.prompt && (
                                                <hr style={{ border: 'none', borderTop: '2px dashed #dee2e6', margin: '12px 0' }} />
                                              )}

                                              {}
                                              {preprocessingResults[layer.id]?.prompt && (
                                                <div>
                                                  <div style={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: '6px',
                                                    fontSize: '0.75rem',
                                                    fontWeight: 700,
                                                    textTransform: 'uppercase',
                                                    letterSpacing: '0.08em',
                                                    color: '#e67e22',
                                                    marginBottom: '8px',
                                                    paddingBottom: '4px',
                                                    borderBottom: '1px solid #dee2e6' }}
                                                    title="Extracted from this step's System Instruction, User Instruction, and User Input text. Contains key parameters/values, requirements/constraints, and claims in table form. Sent to the LLM as Context: === PROMPT STRUCTURED DATA === before the final answer is generated."
                                                    onMouseEnter={quickTooltipEnter}
                                                    onMouseLeave={quickTooltipLeave}
                                                    onMouseMove={moveQuickTooltip}
                                                  >
                                                    <FaPen style={{ fontSize: '0.7rem' }} />
                                                    Prompt Data
                                                  </div>
                                                  <MarkdownWithMath content={preprocessingResults[layer.id]!.prompt!} />
                                                </div>
                                              )}
                                            </div>
                                          )}
                                        </div>
                                      )}

                                      <MarkdownWithMath content={layer.result} />

                                      {getLayerImageUrls(layer).length > 0 && (
                                        <div className="agent-step-images">
                                          {getLayerImageUrls(layer).map((url, i) => (

                                            <img key={i} src={url} alt="Generated image" />
                                          ))}
                                        </div>
                                      )}

                                      {}
                                      {stepQcEnabled[layer.id] && (() => {
                                        const phase     = stepQcPhase[layer.id] ?? 'idle';
                                        const extracted = stepQcExtractedClaims[layer.id] ?? [];
                                        const selected  = stepQcSelectedClaims[layer.id]  ?? [];
                                        const qcRows    = stepQcRows[layer.id] ?? [];
                                        const qcError   = stepQcError[layer.id];

                                        return (
                                          <div style={{ marginTop: '20px' }}>

                                            {}
                                            {phase === 'idle' && !qcError && (
                                              <div style={{ color: '#adb5bd', fontSize: '0.78rem', fontStyle: 'italic' }}>
                                                QC enabled — claims will be extracted after the step runs.
                                              </div>
                                            )}

                                            {}
                                            {(phase === 'extracting' || phase === 'verifying') && (() => {
                                              const QC_GATES = [
                                                {
                                                  id: 'extract',
                                                  label: 'Extract',
                                                  description: phase === 'extracting'
                                                    ? 'Reading the step answer and identifying every verifiable claim, fact, or numerical value using Gemini…'
                                                    : 'Claims extracted from the step answer.' },
                                                {
                                                  id: 'select',
                                                  label: 'Select',
                                                  description: phase === 'verifying'
                                                    ? 'Claims selected for corpus verification.'
                                                    : 'You will choose which claims to verify against the corpus.' },
                                                {
                                                  id: 'retrieve',
                                                  label: 'Retrieve',
                                                  description: phase === 'verifying'
                                                    ? 'Querying the corpus (RAG) for each claim — searching indexed documents for matching passages…'
                                                    : 'The corpus will be searched for evidence matching each claim.' },
                                                {
                                                  id: 'validate',
                                                  label: 'Validate',
                                                  description: phase === 'verifying'
                                                    ? 'Running Gemini to compare each claim against retrieved evidence and produce a MATCHING / CONTRADICTED verdict…'
                                                    : 'Gemini will compare each claim to the retrieved passages and return a verdict.' },
                                                {
                                                  id: 'done',
                                                  label: 'Done',
                                                  description: 'All claims verified — results table ready.' },
                                              ] as const;
                                              type QcGateId = (typeof QC_GATES)[number]['id'];

                                              const currentGate: QcGateId = phase === 'extracting' ? 'extract' : 'retrieve';
                                              const currentIdx = QC_GATES.findIndex(g => g.id === currentGate);
                                              const activeGate = QC_GATES[currentIdx];

                                              return (
                                                <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm space-y-3 mt-1">
                                                  {}
                                                  <div className="flex items-center gap-2">
                                                    <svg className="animate-spin h-4 w-4 text-indigo-500 shrink-0" fill="none" viewBox="0 0 24 24">
                                                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                                                    </svg>
                                                    <span className="text-sm font-semibold text-gray-800">
                                                      {phase === 'extracting' ? 'Extracting claims…' : 'Verifying claims…'}
                                                    </span>
                                                    <span className="ml-auto text-xs font-medium px-2.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700">
                                                      Running
                                                    </span>
                                                  </div>

                                                  {}
                                                  <div className="flex items-center gap-0">
                                                    {QC_GATES.map((gate, i) => {
                                                      const gIdx = QC_GATES.findIndex(g => g.id === gate.id);
                                                      const isDone    = gIdx < currentIdx;
                                                      const isCurrent = gate.id === currentGate;
                                                      return (
                                                        <div key={gate.id} className="flex items-center flex-1 min-w-0">
                                                          <div className={`flex flex-col items-center gap-1 flex-1 min-w-0 ${isDone ? 'text-green-600' : isCurrent ? 'text-indigo-600' : 'text-gray-300'}`}>
                                                            <span className={`relative flex h-7 w-7 items-center justify-center rounded-full border-2 shrink-0 transition-colors ${isDone ? 'border-green-500 bg-green-50' : isCurrent ? 'border-indigo-500 bg-indigo-50 ring-2 ring-indigo-200' : 'border-gray-200 bg-white'}`}>
                                                              {isDone ? (
                                                                <svg className="h-3.5 w-3.5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                                                                </svg>
                                                              ) : isCurrent ? (
                                                                <span className="h-2 w-2 rounded-full bg-indigo-500 animate-pulse" />
                                                              ) : (
                                                                <span className="text-[10px] font-medium text-gray-400">{gIdx + 1}</span>
                                                              )}
                                                            </span>
                                                            <span className="text-[10px] font-medium truncate w-full text-center max-w-[3.5rem]">
                                                              {gate.label}
                                                            </span>
                                                          </div>
                                                          {i < QC_GATES.length - 1 && (
                                                            <div className={`w-3 h-0.5 shrink-0 rounded ${gIdx < currentIdx ? 'bg-green-400' : 'bg-gray-200'}`} aria-hidden />
                                                          )}
                                                        </div>
                                                      );
                                                    })}
                                                  </div>

                                                  {}
                                                  <div className="rounded-lg bg-indigo-50 border border-indigo-100 px-3 py-2 text-xs text-indigo-800 leading-relaxed">
                                                    <span className="font-semibold">{activeGate.label}: </span>
                                                    {activeGate.description}
                                                  </div>

                                                  {}
                                                  <div className="w-full rounded-full bg-gray-100 h-1.5 overflow-hidden">
                                                    <div className="h-1.5 rounded-full bg-indigo-400 animate-pulse" style={{ width: phase === 'extracting' ? '35%' : '70%', transition: 'width 0.8s ease' }} />
                                                  </div>
                                                </div>
                                              );
                                            })()}

                                            {}
                                            {qcError === '__no_claims__' && phase === 'done' && (
                                              <div style={{ color: '#6c757d', fontSize: '0.78rem', fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: 8 }}>
                                                No verifiable claims found in this answer.
                                                <button
                                                  onClick={() => runStepQc(layer.id)}
                                                  style={{ fontSize: '0.72rem', padding: '2px 8px', border: '1px solid #dee2e6', borderRadius: 4, background: '#fff', cursor: 'pointer', color: '#495057', fontStyle: 'normal' }}
                                                >Retry</button>
                                              </div>
                                            )}

                                            {}
                                            {qcError && qcError !== '__no_claims__' && phase !== 'verifying' && (
                                              <div style={{ color: '#dc3545', fontSize: '0.82rem', padding: '8px', background: '#fff5f5', borderRadius: '6px', border: '1px solid #f5c6cb', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                                <span>QC error: {qcError}</span>
                                                <button
                                                  onClick={() => runStepQc(layer.id)}
                                                  style={{ fontSize: '0.72rem', padding: '2px 8px', border: '1px solid #f5c6cb', borderRadius: 4, background: '#fff', cursor: 'pointer', color: '#721c24', whiteSpace: 'nowrap' }}
                                                >Retry</button>
                                              </div>
                                            )}

                                            {}
                                            {phase === 'selecting' && extracted.length > 0 && (
                                              <div style={{ border: '1px solid #dee2e6', borderRadius: '8px', overflow: 'hidden' }}>
                                                <div style={{ background: '#f8f9fa', padding: '8px 12px', borderBottom: '1px solid #dee2e6', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                                                  <div style={{ fontSize: '0.82rem', fontWeight: 600, color: '#495057', display: 'flex', alignItems: 'center', gap: 6 }}>
                                                    <span style={{ background: '#e8eaf6', color: '#5e72e4', borderRadius: 10, padding: '1px 7px', fontSize: '0.75rem' }}>{extracted.length}</span>
                                                    Claims identified — select which to verify
                                                  </div>
                                                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                                    <button
                                                      onClick={() => setStepQcSelectedClaims(prev => ({ ...prev, [layer.id]: extracted.map((_, i) => i) }))}
                                                      style={{ fontSize: '0.72rem', padding: '2px 8px', border: '1px solid #dee2e6', borderRadius: 4, background: '#fff', cursor: 'pointer', color: '#495057' }}
                                                    >All</button>
                                                    <button
                                                      onClick={() => setStepQcSelectedClaims(prev => ({ ...prev, [layer.id]: [] }))}
                                                      style={{ fontSize: '0.72rem', padding: '2px 8px', border: '1px solid #dee2e6', borderRadius: 4, background: '#fff', cursor: 'pointer', color: '#495057' }}
                                                    >None</button>
                                                    <button
                                                      disabled={selected.length === 0}
                                                      onClick={() => verifySelectedClaims(layer.id)}
                                                      style={{ fontSize: '0.78rem', padding: '4px 12px', border: 'none', borderRadius: 5, background: selected.length === 0 ? '#ced4da' : '#5e72e4', color: 'white', cursor: selected.length === 0 ? 'not-allowed' : 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5 }}
                                                    >
                                                      Verify selected ({selected.length})
                                                    </button>
                                                  </div>
                                                </div>
                                                <div style={{ overflowX: 'auto' }}>
                                                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
                                                    <tbody>
                                                      {extracted.map((claim, i) => (
                                                        <tr key={i} style={{ borderBottom: '1px solid #f0f0f0', verticalAlign: 'top' }}>
                                                          <td style={{ padding: '6px 10px', width: 32 }}>
                                                            <input
                                                              type="checkbox"
                                                              checked={selected.includes(i)}
                                                              onChange={e => {
                                                                setStepQcSelectedClaims(prev => {
                                                                  const cur = prev[layer.id] ?? [];
                                                                  const next = e.target.checked
                                                                    ? [...cur, i]
                                                                    : cur.filter(x => x !== i);
                                                                  return { ...prev, [layer.id]: next };
                                                                });
                                                              }}
                                                              style={{ cursor: 'pointer' }}
                                                            />
                                                          </td>
                                                          <td style={{ padding: '6px 10px', color: '#333' }}>{claim}</td>
                                                        </tr>
                                                      ))}
                                                    </tbody>
                                                  </table>
                                                </div>
                                              </div>
                                            )}

                                            {}
                                            {(phase === 'verifying' || phase === 'done') && qcRows.length > 0 && (() => {
                                              const pendingCount       = qcRows.filter(r => r.status === 'PENDING').length;
                                              const verifiedCount      = qcRows.length - pendingCount;
                                              const isVerifying        = phase === 'verifying' && pendingCount > 0;
                                              const countMatching      = qcRows.filter(r => r.status === 'MATCHING').length;
                                              const countPartial       = qcRows.filter(r => r.status === 'PARTIALLY_MATCHING').length;
                                              const countContradicted  = qcRows.filter(r => r.status === 'NOT_MATCHING').length;
                                              const countNoEvidence    = qcRows.filter(r => r.status === 'SOURCE_NOT_FOUND').length;
                                              const expandedRow        = stepQcExpandedRow[layer.id] ?? null;
                                              const toggleRow          = (i: number) => setStepQcExpandedRow(prev => ({ ...prev, [layer.id]: prev[layer.id] === i ? null : i }));

                                              const statusLabel = (status: QcRow['status']) =>
                                                status === 'MATCHING'           ? 'MATCHING'
                                                : status === 'PARTIALLY_MATCHING' ? 'PARTIALLY MATCHING'
                                                : status === 'NOT_MATCHING'      ? 'CONTRADICTED'
                                                : status === 'SOURCE_NOT_FOUND'  ? 'NO EVIDENCE'
                                                : 'VERIFYING…';

                                              const statusChipClass = (status: QcRow['status']) =>
                                                status === 'MATCHING'             ? 'bg-green-100 text-green-800 border-green-200'
                                                : status === 'PARTIALLY_MATCHING' ? 'bg-blue-100 text-blue-800 border-blue-200'
                                                : status === 'NOT_MATCHING'       ? 'bg-red-100 text-red-800 border-red-200'
                                                : status === 'SOURCE_NOT_FOUND'   ? 'bg-orange-100 text-orange-700 border-orange-200'
                                                : 'bg-indigo-50 text-indigo-600 border-indigo-100';

                                              return (
                                                <div className="space-y-3 mt-4">
                                                  {}
                                                  <div className="flex items-center gap-2 flex-wrap"
                                                    title="Quality Control: claims extracted from the step answer were verified against the corpus linked to this step."
                                                    onMouseEnter={quickTooltipEnter}
                                                    onMouseLeave={quickTooltipLeave}
                                                    onMouseMove={moveQuickTooltip}
                                                  >
                                                    {isVerifying && <FaSpinner className="fa-spin text-indigo-500" style={{ fontSize: 12 }} />}
                                                    <span className={`text-sm font-semibold ${isVerifying ? 'text-indigo-500' : countMatching === qcRows.length - pendingCount ? 'text-green-700' : 'text-orange-600'}`}>
                                                      {isVerifying ? `Verifying ${verifiedCount} / ${qcRows.length} claims…` : `Corpus QC — ${countMatching} / ${qcRows.length} claims supported`}
                                                    </span>
                                                    {phase === 'done' && (
                                                      <button
                                                        onClick={() => setStepQcPhase(prev => ({ ...prev, [layer.id]: 'selecting' }))}
                                                        className="ml-auto text-xs px-2 py-0.5 rounded border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 cursor-pointer"
                                                      >
                                                        Re-select claims
                                                      </button>
                                                    )}
                                                  </div>

                                                  {}
                                                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                                                    {[
                                                      { label: 'Total',       value: qcRows.length,     color: 'bg-gray-50 text-gray-700'     },
                                                      { label: 'Supported',   value: countMatching,     color: 'bg-green-50 text-green-700'   },
                                                      { label: 'Partial',     value: countPartial,      color: 'bg-blue-50 text-blue-700'     },
                                                      { label: 'Contradicted',value: countContradicted, color: 'bg-red-50 text-red-700'       },
                                                      { label: 'No Evidence', value: countNoEvidence,   color: 'bg-orange-50 text-orange-700' },
                                                      { label: 'Pending',     value: pendingCount,      color: 'bg-indigo-50 text-indigo-600' },
                                                    ].map(({ label, value, color }) => (
                                                      <div key={label} className={`rounded-xl p-2 text-center ${color} border border-gray-100`}>
                                                        <div className="text-xl font-bold">{value}</div>
                                                        <div className="text-xs mt-0.5 font-medium">{label}</div>
                                                      </div>
                                                    ))}
                                                  </div>

                                                  {}
                                                  <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
                                                    <table className="w-full text-sm">
                                                      <thead>
                                                        <tr className="bg-gray-50 border-b border-gray-200">
                                                          <th className="px-3 py-2 w-8" />
                                                          <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-8">#</th>
                                                          <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide min-w-[10rem]"
                                                            title="Atomic claim or numerical value extracted from the step answer"
                                                            onMouseEnter={quickTooltipEnter} onMouseLeave={quickTooltipLeave} onMouseMove={moveQuickTooltip}
                                                          >Claim Text</th>
                                                          <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-36"
                                                            title="Whether the corpus supports this claim"
                                                            onMouseEnter={quickTooltipEnter} onMouseLeave={quickTooltipLeave} onMouseMove={moveQuickTooltip}
                                                          >Status</th>
                                                          <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide min-w-[6rem]"
                                                            title="Document and page in the corpus where evidence was found"
                                                            onMouseEnter={quickTooltipEnter} onMouseLeave={quickTooltipLeave} onMouseMove={moveQuickTooltip}
                                                          >Reference</th>
                                                        </tr>
                                                      </thead>
                                                      <tbody className="divide-y divide-gray-100">
                                                        {qcRows.map((row, i) => {
                                                          const isPending  = row.status === 'PENDING';
                                                          const isExpanded = expandedRow === i;
                                                          return (
                                                            <React.Fragment key={i}>
                                                              <tr
                                                                className={`cursor-pointer hover:bg-gray-50 transition-colors ${isPending ? 'opacity-60' : ''}`}
                                                                onClick={() => !isPending && toggleRow(i)}
                                                              >
                                                                {}
                                                                <td className="px-3 py-2 text-gray-400">
                                                                  {isPending
                                                                    ? <FaSpinner className="fa-spin w-3 h-3 text-indigo-400" />
                                                                    : (
                                                                      <svg className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                                                      </svg>
                                                                    )
                                                                  }
                                                                </td>
                                                                {}
                                                                <td className="px-3 py-2 text-xs font-medium text-gray-400 tabular-nums">{i + 1}</td>
                                                                {}
                                                                <td className="px-3 py-2 text-gray-800 max-w-xs">
                                                                  <span className="line-clamp-2">{row.claim}</span>
                                                                </td>
                                                                {}
                                                                <td className="px-3 py-2">
                                                                  <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-medium ${isPending ? 'bg-indigo-50 text-indigo-600 border-indigo-100' : statusChipClass(row.status)}`}>
                                                                    {isPending && <FaSpinner className="fa-spin" style={{ fontSize: 9 }} />}
                                                                    {statusLabel(row.status)}
                                                                  </span>
                                                                </td>
                                                                {}
                                                                <td className="px-3 py-2 text-xs text-gray-500">
                                                                  {isPending ? '—' : (row.ragLocation || row.sourceDoc || '—')}
                                                                </td>
                                                              </tr>

                                                              {}
                                                              {isExpanded && !isPending && (
                                                                <tr>
                                                                  <td colSpan={5} className="px-4 py-3 bg-gray-50 border-b border-gray-200">
                                                                    <div className="space-y-3 max-w-3xl">
                                                                      {row.rationale && (
                                                                        <div>
                                                                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Explanation</p>
                                                                          <p className="text-sm text-gray-700 leading-relaxed">{row.rationale}</p>
                                                                        </div>
                                                                      )}
                                                                      {(row.sourceDoc || row.ragLocation) && (
                                                                        <div className="rounded-lg border border-gray-200 bg-white px-3 py-2">
                                                                          {row.sourceDoc && <p className="text-xs text-indigo-600 font-medium">{row.sourceDoc}</p>}
                                                                          {row.ragLocation && <p className="text-xs text-gray-500 mt-0.5">Location: {row.ragLocation}</p>}
                                                                        </div>
                                                                      )}
                                                                      {row.action && row.action !== 'NO_ACTION_NEEDED' && (
                                                                        <div>
                                                                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Recommended Action</p>
                                                                          <span className="text-xs bg-yellow-50 text-yellow-800 border border-yellow-200 rounded px-2 py-0.5">{row.action.replace(/_/g, ' ')}</span>
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
                                                </div>
                                              );
                                            })()}

                                          </div>
                                        );
                                      })()}

                                      {}
                                      {introspectionResults[layer.id] && (
                                        <div style={{
                                          marginTop: '24px',
                                          padding: '16px',
                                          background: 'linear-gradient(135deg, #4A4453 0%, #AFA8BA 100%)',
                                          borderRadius: '12px',
                                          border: '1px solid #11074A'
                                        }}>
                                          <div style={{
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            alignItems: 'center',
                                            marginBottom: '12px'
                                          }}>
                                            <h4 style={{
                                              margin: '0',
                                              color: 'white',
                                              fontSize: '1.1rem',
                                              fontWeight: '600',
                                              display: 'flex',
                                              alignItems: 'center',
                                              gap: '8px'
                                            }}>
                                              <FaBrain style={{ fontSize: '1rem' }} />
                                              Introspection Analysis
                                            </h4>

                                            {}
                                            <div style={{ display: 'flex', gap: '6px' }}>
                                              <button
                                                onClick={() => toggleIntrospectionVisibility(layer.id)}
                                                title={isIntrospectionVisible ? 'Hide introspection analysis' : 'Show introspection analysis'}
                                                style={{
                                                  padding: '6px 8px',
                                                  border: '1px solid rgba(255,255,255,0.3)',
                                                  borderRadius: '6px',
                                                  background: 'rgba(255,255,255,0.1)',
                                                  color: 'white',
                                                  cursor: 'pointer',
                                                  fontSize: '0.85rem',
                                                  display: 'flex',
                                                  alignItems: 'center',
                                                  gap: '4px'
                                                }}
                                              >
                                                {isIntrospectionVisible ? <FaEyeSlash style={{ fontSize: '0.8rem' }} /> : <FaEye style={{ fontSize: '0.8rem' }} />}
                                              </button>
                                              <button
                                                onClick={() => downloadIntrospectionResults(layer.id)}
                                                title="Download as Markdown"
                                                style={{
                                                  padding: '6px 8px',
                                                  border: '1px solid rgba(255,255,255,0.3)',
                                                  borderRadius: '6px',
                                                  background: 'rgba(255,255,255,0.1)',
                                                  color: 'white',
                                                  cursor: 'pointer',
                                                  fontSize: '0.85rem',
                                                  display: 'flex',
                                                  alignItems: 'center',
                                                  gap: '4px'
                                                }}
                                              >
                                                <FaDownload style={{ fontSize: '0.8rem' }} />
                                                Download
                                              </button>
                                              <button
                                                onClick={() => exportToGoogleDrive(layer.id)}
                                                title="Export to Google Drive"
                                                style={{
                                                  padding: '6px 8px',
                                                  border: '1px solid rgba(255,255,255,0.3)',
                                                  borderRadius: '6px',
                                                  background: 'rgba(255,255,255,0.1)',
                                                  color: 'white',
                                                  cursor: 'pointer',
                                                  fontSize: '0.85rem',
                                                  display: 'flex',
                                                  alignItems: 'center',
                                                  gap: '4px'
                                                }}
                                              >
                                                <FaGoogleDrive style={{ fontSize: '0.8rem' }} />
                                                Drive
                                              </button>
                                              <button
                                                onClick={() => exportToGoogleDocs(layer.id)}
                                                title="Export to Google Docs"
                                                style={{
                                                  padding: '6px 8px',
                                                  border: '1px solid rgba(255,255,255,0.3)',
                                                  borderRadius: '6px',
                                                  background: 'rgba(255,255,255,0.1)',
                                                  color: 'white',
                                                  cursor: 'pointer',
                                                  fontSize: '0.85rem',
                                                  display: 'flex',
                                                  alignItems: 'center',
                                                  gap: '4px'
                                                }}
                                              >
                                                <FaFileAlt style={{ fontSize: '0.8rem' }} />
                                                Docs
                                              </button>
                                            </div>
                                          </div>

                                          {isIntrospectionVisible && (
                                            <>
                                              {}
                                              <div style={{
                                                background: 'linear-gradient(135deg, #f8fafe 0%, #f1f6fe 100%)',
                                                padding: '16px',
                                                borderRadius: '8px',
                                                color: '#2d3748',
                                                marginBottom: '12px',
                                                border: '1px solid #e8eef7'
                                              }}>
                                                <h5 style={{
                                                  margin: '0 0 8px 0',
                                                  color: '#4a5568',
                                                  fontSize: '0.9rem',
                                                  fontWeight: '600'
                                                }}>
                                                  🔍 Standard Analysis
                                                </h5>
                                                <MarkdownWithMath content={introspectionResults[layer.id].first} />
                                              </div>

                                              {}
                                              {introspectionResults[layer.id].second && (
                                                <div style={{
                                                  background: 'linear-gradient(135deg, #f5f8fe 0%, #ecf2fd 100%)',
                                                  padding: '16px',
                                                  borderRadius: '8px',
                                                  color: '#2d3748',
                                                  marginBottom: '12px',
                                                  border: '1px solid #d1ddf7'
                                                }}>
                                                  <h5 style={{
                                                    margin: '0 0 8px 0',
                                                    color: '#ad1457',
                                                    fontSize: '0.9rem',
                                                    fontWeight: '600',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: '6px'
                                                  }}>
                                                    🎯 User Request Re-interpretation
                                                  </h5>
                                                  <MarkdownWithMath content={introspectionResults[layer.id].second || ''} />
                                                </div>
                                              )}

                                              {}
                                              {introspectionResults[layer.id].extraction && (
                                                <div style={{
                                                  background: 'linear-gradient(135deg, #f2f6fe 0%, #e6f0fd 100%)',
                                                  padding: '16px',
                                                  borderRadius: '8px',
                                                  color: '#2d3748',
                                                  marginBottom: '12px',
                                                  border: '1px solid #c4d3f5'
                                                }}>
                                                  <h5 style={{
                                                    margin: '0 0 8px 0',
                                                    color: '#d84315',
                                                    fontSize: '0.9rem',
                                                    fontWeight: '600',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: '6px'
                                                  }}>
                                                    📊 Data/Table/Figure Extraction
                                                  </h5>
                                                  <MarkdownWithMath content={introspectionResults[layer.id].extraction || ''} />
                                                </div>
                                              )}

                                              {}
                                              {introspectionResults[layer.id].reinterpretation && (
                                                <div style={{
                                                  background: 'linear-gradient(135deg, #eff4fe 0%, #e0edfc 100%)',
                                                  padding: '16px',
                                                  borderRadius: '8px',
                                                  color: '#2d3748',
                                                  marginBottom: '12px',
                                                  border: '1px solid #b7c9f3'
                                                }}>
                                                  <h5 style={{
                                                    margin: '0 0 8px 0',
                                                    color: '#1e3a8a',
                                                    fontSize: '0.9rem',
                                                    fontWeight: '600',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: '6px'
                                                  }}>
                                                    🧠 Deep Introspection
                                                  </h5>
                                                  <MarkdownWithMath content={introspectionResults[layer.id].reinterpretation || ''} />
                                                </div>
                                              )}

                                              {}
                                              {introspectionResults[layer.id].reexecution && (
                                                <div style={{
                                                  background: 'linear-gradient(135deg, #ecf2fe 0%, #dae8fc 100%)',
                                                  padding: '16px',
                                                  borderRadius: '8px',
                                                  color: '#2d3748',
                                                  border: '1px solid #a9bdf1'
                                                }}>
                                                  <h5 style={{
                                                    margin: '0 0 8px 0',
                                                    color: '#5e72e4',
                                                    fontSize: '0.9rem',
                                                    fontWeight: '600',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: '6px'
                                                  }}>
                                                    🚀 Improved Result with AI Insights
                                                  </h5>
                                                  <MarkdownWithMath content={introspectionResults[layer.id].reexecution || ''} />
                                                </div>
                                              )}
                                            </>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                                </OutputFrame>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                {stepFilterActive && !(agent?.layers || []).some(stepMatchesFilter) && (
                  <div className="no-step-matches">No steps match the current filters</div>
                )}

                {}
                <div style={{ display: 'flex', justifyContent: 'center', width: '100%', marginTop: '-0.5rem' }}>
                  <button
                    className="add-step-button"
                    onClick={addStep}
                    onMouseEnter={e => handleMouseEnter(e, 'Add new step to agent')}
                    onMouseLeave={handleMouseLeave}
                  >
                    <FaPlus /> Add Step
                  </button>
                </div>
              </div>

              {agent?.layers && agent.layers.length === 0 && (
                <div className="no-steps-placeholder">
                  <FaUser size={48} color="#ccc" />
                  <p style={{ margin: '0.5rem 0 0 0', fontSize: '0.875rem' }}>
                    No steps added yet. Click "Add Step" to create your first step.
                  </p>
                </div>
              )}

              {}
              <input
                type="file"
                multiple
                ref={fileInputRef}
                style={{ display: 'none' }}
                accept="image/*,application/pdf,audio/*,video/*"
                onChange={(e) => handleFileInputChange(e, agent?.layers?.[0]?.id || '')}
              />
            </div>
          </div>

          {}
          {personaModalOpen && (
            <PersonaPromptEditor
              isOpen={personaModalOpen}
              onClose={handleClosePersonaModal}
              initialContent={personaModalConfig?.content || ''}
              onSave={handleSavePersonaContent}
            />
          )}

          {}
          {viewCollectionContent && (
            <CollectionViewModal
              content={viewCollectionContent}
              onClose={() => setViewCollectionContent(null)}
            />
          )}

          {}
          {showMissingFoldersModal && (
            <MissingFoldersModal
              isOpen={showMissingFoldersModal}
              onClose={() => setShowMissingFoldersModal(false)}
              projectId={projectFolder?.projectId || ''}
              missingFolders={missingFolders}
              totalFolders={getRequiredFoldersCount()}
            />
          )}

          {}
          <BeautifulModal
            isOpen={modal.isOpen}
            type={modal.type}
            title={modal.title}
            message={modal.message}
            onClose={hideModal}
            onConfirm={modal.onConfirm}
            autoClose={modal.autoClose}
            autoCloseDelay={modal.autoCloseDelay}
          />

          {}
          {enhancementModal.isVisible && (
            <EnhancementModal
              isVisible={enhancementModal.isVisible}
              enhancementType={enhancementModal.type as 'prompt' | 'userInput'}
              onCancel={() => setEnhancementModal({ isVisible: false, type: 'userInstruction' })}
              allowCancel={false}
            />
          )}

          {}
          {Object.keys(personaInstructionPopupVisible).map(layerId => (
            personaInstructionPopupVisible[layerId] && (
              <PersonaPopup
                key={`persona-instruction-${layerId}`}
                isVisible={true}
                onClose={() => handlePersonaInstructionPopupClose(layerId)}
                onPersonaSelect={(instruction) => handlePersonaInstructionSelect(layerId, instruction)}
                currentInstruction={agent?.layers.find(l => l.id === layerId)?.systemInstruction || ''}
              />
            )
          ))}

          {}
          {promptActionsPopup.visible &&
            promptActionsPopup.layerId && (
              <PromptActionsPopup
                onClose={() => setPromptActionsPopup({ visible: false, layerId: null, position: { top: 0, left: 0 } })}
                onSelectPersona={() => {
                  handlePersonaInstructionPopupShow(promptActionsPopup.layerId!);
                  setPromptActionsPopup({ visible: false, layerId: null, position: { top: 0, left: 0 } });
                }}
                onExpandEditor={() => {
                  handleExpandTextarea(promptActionsPopup.layerId!, 'userInstruction');
                  setPromptActionsPopup({ visible: false, layerId: null, position: { top: 0, left: 0 } });
                }}
                onEnhancePrompt={() => {
                  const layerId = promptActionsPopup.layerId!;
                  setPromptActionsPopup({ visible: false, layerId: null, position: { top: 0, left: 0 } });

                  const confirmed = confirm(
                    'Magic Prompt Enhancement\n\nAI will automatically improve your prompt by making it more precise, structured, and effective while preserving your original intent.\n\nDo you want to proceed with the enhancement?'
                  );
                  if (confirmed) {
                    enhanceUserPrompt(layerId);
                  }
                }}
                position={promptActionsPopup.position}
              />
            )}
        </div>

        {}
        {notesPanelOpen && (
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(0, 0, 0, 0.5)',
              zIndex: 10100,
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'center',
              padding: '170px 1rem 1rem 1rem',
              boxSizing: 'border-box',
              overflowY: 'auto'
            }}
            onClick={() => setNotesPanelOpen(false)}
          >
            <div
              style={{
                background: 'white',
                border: '2px solid #AFA8BA',
                borderRadius: '1rem',
                width: '80%',
                height: 'min(85vh, 700px)',
                maxWidth: 'calc(100vw - 2rem)',
                maxHeight: 'calc(100vh - 4rem)',
                display: 'flex',
                flexDirection: 'column',
                boxShadow: '0 25px 50px -12px rgba(17, 7, 74, 0.25), 0 25px 50px -12px rgba(175, 168, 186, 0.4)',
                boxSizing: 'border-box',
                marginTop: 0
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '1.5rem',
                borderBottom: '2px solid #AFA8BA',
                background: 'linear-gradient(135deg, #F0F4FC 0%, #F9FAFB 100%)',
                borderRadius: '1rem 1rem 0 0',
                flexShrink: 0
              }}>
                <h3 style={{
                  margin: 0,
                  color: '#11074A',
                  fontSize: '1.25rem',
                  fontWeight: 700
                }}>Development Notes</h3>
                <button
                  onClick={() => setNotesPanelOpen(false)}
                  style={{
                    background: 'none',
                    border: '1px solid #AFA8BA',
                    color: '#4A4453',
                    padding: '0.75rem',
                    borderRadius: '0.5rem',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 500,
                    transition: 'all 0.2s ease'
                  }}
                  onMouseOver={(e) => {
                    e.currentTarget.style.background = '#AFA8BA';
                    e.currentTarget.style.color = 'white';
                    e.currentTarget.style.transform = 'translateY(-1px)';
                  }}
                  onMouseOut={(e) => {
                    e.currentTarget.style.background = 'none';
                    e.currentTarget.style.color = '#4A4453';
                    e.currentTarget.style.transform = 'translateY(0)';
                  }}
                >
                  <FaTimes />
                </button>
              </div>

              <div style={{
                flex: 1,
                overflowY: 'auto',
                padding: '1rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '1rem',
                minHeight: 0
              }}>
                {agent?.metadata?.notes?.map((note, index) => {
                  return (
                    <div key={index} style={{
                      background: '#F0F4FC',
                      border: '1px solid #AFA8BA',
                      borderRadius: '0.75rem',
                      padding: '1rem',
                      borderLeft: '4px solid #11074A',
                      transition: 'all 0.2s ease'
                    }}>
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '0.5rem'
                      }}>
                        <span style={{
                          fontWeight: 700,
                          color: '#11074A',
                          fontSize: '0.875rem'
                        }}>{note.username || 'Unknown'}</span>
                        <span style={{
                          fontSize: '0.75rem',
                          color: '#6B7280'
                        }}>
                          {note.timestamp ? new Date(note.timestamp).toLocaleString() : new Date().toLocaleString()}
                        </span>
                      </div>
                      <div style={{
                        color: '#374151',
                        lineHeight: 1.5,
                        whiteSpace: 'pre-wrap',
                        wordWrap: 'break-word'
                      }}>{note.text || ''}</div>
                    </div>
                  );
                })}
                {(!agent?.metadata?.notes || agent.metadata.notes.length === 0) && (
                  <div style={{
                    textAlign: 'center',
                    color: '#6B7280',
                    fontStyle: 'italic',
                    marginTop: '2rem'
                  }}>No notes yet. Start a conversation!</div>
                )}
              </div>

              <div style={{
                padding: '1rem',
                borderTop: '1px solid #E5E7EB',
                background: 'white',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
                flexShrink: 0
              }}>
                <textarea
                  value={currentNote}
                  onChange={(e) => setCurrentNote(e.target.value)}
                  placeholder="Add a development note..."
                  disabled={isSavingNote}
                  onKeyPress={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !isSavingNote) {
                      e.preventDefault();
                      handleAddNote();
                    }
                  }}
                  style={{
                    border: '1px solid #D1D5DB',
                    borderRadius: '0.5rem',
                    padding: '0.75rem',
                    resize: 'vertical',
                    minHeight: '80px',
                    maxHeight: 'min(150px, 20vh)',
                    fontFamily: 'inherit',
                    fontSize: '0.875rem',
                    width: '100%',
                    boxSizing: 'border-box',
                    opacity: isSavingNote ? 0.6 : 1,
                    cursor: isSavingNote ? 'not-allowed' : 'text'
                  }}
                  onFocus={(e) => {
                    e.target.style.outline = 'none';
                    e.target.style.borderColor = '#AFA8BA';
                    e.target.style.boxShadow = '0 0 0 3px rgba(175, 168, 186, 0.3)';
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = '#D1D5DB';
                    e.target.style.boxShadow = 'none';
                  }}
                />
                <button
                  onClick={handleAddNote}
                  disabled={!currentNote.trim() || isSavingNote}
                  style={{
                    background: currentNote.trim() && !isSavingNote ? '#AFA8BA' : '#D1D5DB',
                    color: 'white',
                    border: 'none',
                    borderRadius: '0.5rem',
                    padding: '0.75rem 1.5rem',
                    cursor: currentNote.trim() && !isSavingNote ? 'pointer' : 'not-allowed',
                    fontWeight: 500,
                    transition: 'background-color 0.2s ease',
                    alignSelf: 'flex-end',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem'
                  }}
                  onMouseOver={(e) => {
                    if (currentNote.trim() && !isSavingNote) {
                      e.currentTarget.style.background = '#9A93A6';
                    }
                  }}
                  onMouseOut={(e) => {
                    if (currentNote.trim() && !isSavingNote) {
                      e.currentTarget.style.background = '#AFA8BA';
                    }
                  }}
                >
                  {isSavingNote ? (
                    <>
                      <FaSpinner style={{ animation: 'spin 1s linear infinite' }} />
                      Saving...
                    </>
                  ) : (
                    'Send'
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        <AnswerDebugPanel
          open={debugPanelLayerId !== null}
          debugInfo={agent?.layers.find(l => l.id === debugPanelLayerId)?.debugInfo}
          onClose={() => setDebugPanelLayerId(null)}
        />

      </MathJaxContext>
    </>
  );
};

interface CollectionViewModalProps {
  content: string;
  onClose: () => void;
}

const CollectionViewModal: React.FC<CollectionViewModalProps> = ({ content, onClose }) => {
  const [selectedPageIndex, setSelectedPageIndex] = useState(0);
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setContainer(document.body);
  }, []);

  const pages = React.useMemo(() => {
    if (!content) return [];

    const pageRegex = /^% Page (\d+), PDF: (.+)$/gm;
    const parts = content.split(pageRegex);
    const pages = [];

    for (let i = 1; i < parts.length; i += 3) {
      const pageNumber = parts[i];
      const pdfName = parts[i + 1];
      const pageContent = parts[i + 2]?.trim() || '';

      if (pageNumber && pdfName) {
        pages.push({
          pageNumber: parseInt(pageNumber),
          pdfName: pdfName.trim(),
          content: pageContent
        });
      }
    }

    return pages.sort((a, b) => a.pageNumber - b.pageNumber);
  }, [content]);

  const currentPage = pages[selectedPageIndex];

  const modalContent = (
    <div style={{
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: '80vw',
      height: '80vh',
      zIndex: 9999,
      background: 'rgba(0, 0, 0, 0.5)',
      pointerEvents: 'auto'
    }}>
      <div style={{
        width: '100%',
        height: '100%',
        background: '#ffffff',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: '1rem',
        overflow: 'hidden',
        boxShadow: '0 10px 25px rgba(0, 0, 0, 0.1)'
      }}>
        {}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '1rem 1.5rem',
          borderBottom: '1px solid #e5e7eb',
          background: '#f8f9fa'
        }}>
          <h2 style={{
            margin: 0,
            fontSize: '1.25rem',
            fontWeight: '600',
            color: '#1f2937'
          }}>
            Collection Content
          </h2>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button
              onClick={onClose}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '2.5rem',
                height: '2.5rem',
                background: '#1e293b',
                border: '1px solid #1e293b',
                borderRadius: '0.5rem',
                cursor: 'pointer',
                color: '#ffffff',
                transition: 'all 0.2s ease'
              }}
              onMouseOver={(e) => {
                e.currentTarget.style.background = '#dc2626';
                e.currentTarget.style.borderColor = '#dc2626';
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.background = '#1e293b';
                e.currentTarget.style.borderColor = '#1e293b';
              }}
              title="Close"
            >
              <FaTimes size={16} />
            </button>
          </div>
        </div>

        {}
        <div style={{
          flex: 1,
          display: 'flex',
          overflow: 'hidden'
        }}>
          {}
          <div style={{
            width: '280px',
            borderRight: '1px solid #e5e7eb',
            background: '#f9fafb',
            display: 'flex',
            flexDirection: 'column'
          }}>
            <div style={{
              padding: '1rem',
              borderBottom: '1px solid #e5e7eb',
              background: '#ffffff'
            }}>
              <h3 style={{
                margin: 0,
                fontSize: '0.875rem',
                fontWeight: '600',
                color: '#374151',
                textTransform: 'uppercase',
                letterSpacing: '0.05em'
              }}>
                Pages ({pages.length})
              </h3>
            </div>
            <div style={{
              flex: 1,
              overflow: 'auto',
              padding: '0.5rem'
            }}>
              {pages.map((page, index) => (
                <button
                  key={`${page.pdfName}-${page.pageNumber}`}
                  onClick={() => setSelectedPageIndex(index)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    padding: '0.75rem',
                    margin: '0.25rem 0',
                    background: selectedPageIndex === index ? '#1e293b' : '#ffffff',
                    border: '1px solid #e5e7eb',
                    borderRadius: '0.5rem',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                    textAlign: 'left'
                  }}
                  onMouseOver={(e) => {
                    if (selectedPageIndex !== index) {
                      e.currentTarget.style.background = '#f3f4f6';
                      e.currentTarget.style.borderColor = '#d1d5db';
                    }
                  }}
                  onMouseOut={(e) => {
                    if (selectedPageIndex !== index) {
                      e.currentTarget.style.background = '#ffffff';
                      e.currentTarget.style.borderColor = '#e5e7eb';
                    }
                  }}
                >
                  <div style={{
                    fontSize: '0.875rem',
                    fontWeight: '600',
                    color: selectedPageIndex === index ? '#ffffff' : '#1f2937',
                    marginBottom: '0.25rem'
                  }}>
                    Page {page.pageNumber}
                  </div>
                  <div style={{
                    fontSize: '0.75rem',
                    color: selectedPageIndex === index ? '#e2e8f0' : '#6b7280',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    width: '100%'
                  }}>
                    {page.pdfName}
                  </div>

                </button>
              ))}
            </div>
          </div>

          {}
          <div style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}>
            {currentPage ? (
              <>
                {}
                <div style={{
                  padding: '1rem 1.5rem',
                  borderBottom: '1px solid #e5e7eb',
                  background: '#ffffff'
                }}>
                  <h3 style={{
                    margin: '0 0 0.25rem 0',
                    fontSize: '1.125rem',
                    fontWeight: '600',
                    color: '#1f2937'
                  }}>
                    Page {currentPage.pageNumber}
                  </h3>
                  <p style={{
                    margin: 0,
                    fontSize: '0.875rem',
                    color: '#6b7280'
                  }}>
                    From: {currentPage.pdfName}
                  </p>
                </div>

                {}
                <div style={{
                  flex: 1,
                  overflow: 'auto',
                  padding: '1.5rem',
                  background: '#ffffff'
                }}>
                  <div style={{
                    maxWidth: '100%',
                    lineHeight: '1.6',
                    color: '#374151',
                    fontSize: '0.875rem'
                  }}>
                    <pre style={{
                      whiteSpace: 'pre-wrap',
                      fontFamily: 'monospace',
                      fontSize: '0.875rem',
                      lineHeight: '1.4',
                      margin: 0,
                      padding: 0
                    }}>
                      {currentPage.content}
                    </pre>
                  </div>
                </div>
              </>
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280', background: '#f8f9fa' }}>
                <p>No page selected or collection is empty.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return container ? ReactDOM.createPortal(modalContent, container) : null;
};

type EditorView = 'graph' | 'form' | 'output' | 'log';

const ViewToggle: React.FC<{ view: EditorView }> = ({ view }) => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const voiceModalOpen = useVoiceModalOpen();

  const setView = (next: EditorView) => {
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.set('view', next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const wrap: React.CSSProperties = {
    position: 'fixed',
    bottom: 20,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 2147483000,
    display: 'inline-flex',
    gap: 2,
    padding: 4,
    borderRadius: 9999,
    background: 'rgba(20,20,28,0.82)',
    backdropFilter: 'blur(8px)',
    boxShadow: '0 4px 18px rgba(0,0,0,0.30)',
    pointerEvents: 'auto' };
  const btn = (active: boolean): React.CSSProperties => ({
    border: 'none',
    cursor: 'pointer',
    padding: '7px 18px',
    borderRadius: 9999,
    fontSize: 13,
    fontWeight: 600,
    color: active ? '#111' : '#e7e7ee',
    background: active ? '#fff' : 'transparent',
    transition: 'background 120ms ease, color 120ms ease' });

  if (!mounted || voiceModalOpen) return null;

  return ReactDOM.createPortal(
    <>
      <div style={wrap} role="tablist" aria-label="Editor view">
        <button type="button" role="tab" aria-selected={view === 'form'} style={btn(view === 'form')} onClick={() => setView('form')}>
          Form
        </button>
        <button type="button" role="tab" aria-selected={view === 'graph'} style={btn(view === 'graph')} onClick={() => setView('graph')}>
          Graph
        </button>
        <button type="button" role="tab" aria-selected={view === 'output'} style={btn(view === 'output')} onClick={() => setView('output')}>
          Output
        </button>
        <button type="button" role="tab" aria-selected={view === 'log'} style={btn(view === 'log')} onClick={() => setView('log')}>
          Log
        </button>
      </div>
    </>,
    document.body,
  );
};

const UnifiedEditorShell: React.FC = () => {
  const searchParams = useSearchParams();
  const rawView = searchParams?.get('view');
  const view: EditorView =
    rawView === 'graph' ? 'graph'
    : rawView === 'output' ? 'output'
    : rawView === 'log' ? 'log'
    : 'form';

  const [outputOpened, setOutputOpened] = useState(false);
  useEffect(() => {
    if (view === 'output') setOutputOpened(true);
  }, [view]);

  return (
    <div className="agent-editor-shell">
      <AgentEditorSidebar />
      <div className="agent-editor-surfaces">
        <ViewToggle view={view} />
        <div
          className="agent-editor-pane agent-editor-pane--form"
          style={{ display: view === 'form' ? 'block' : 'none' }}
        >
          <EditAgentPage />
        </div>
        <div
          className="agent-editor-pane agent-editor-pane--graph"
          style={{ display: view === 'graph' ? 'block' : 'none' }}
        >
          <AgentNodesView embedded />
        </div>
        <div
          className="agent-editor-pane agent-editor-pane--output"
          style={{ display: view === 'output' ? 'block' : 'none' }}
        >
          {outputOpened && <OutputView />}
        </div>
        <div
          className="agent-editor-pane agent-editor-pane--log"
          style={{ display: view === 'log' ? 'block' : 'none' }}
        >
          {view === 'log' && <LogView />}
        </div>
      </div>
    </div>
  );
};

const EditAgentPageWithProvider: React.FC = () => {
  return (
    <ThemeProvider initialDark={false}>
      <IntegrityChainProvider>
        <CollectionContextProvider>
          <AgentEditorProvider>
            <React.Suspense fallback={null}>
              <UnifiedEditorShell />
            </React.Suspense>
          </AgentEditorProvider>
        </CollectionContextProvider>
      </IntegrityChainProvider>
    </ThemeProvider>
  );
};

export default function EditAgentPageRoute({
  params }: {
  params: Promise<{ 'agent-id': string }>;
}) {
  React.use(params);
  return <EditAgentPageWithProvider />;
}
