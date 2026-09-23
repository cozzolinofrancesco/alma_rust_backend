"use client";
import { useStepModels } from '../../hooks/useStepModels';
import GalileoCatalogStatus from '../../components/GalileoCatalogStatus';
import StepModelOptions from '../../components/StepModelOptions';
import StepRunStatus from '../../components/StepRunStatus';
import { canSelectStepModel, isGalileoModel } from '../../lib/stepModels';
import { assertStepModelReady, getGalileoGenerationSettings, getStepEndpoint, getStepFailureDiagnostics, readStepRunResponse, type StepRunDiagnostics, type StepRunResponse } from '../../lib/stepExecution';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState } from 'react';
import { MathMarkdown } from '../../components/MathMarkdown';
import { DEFAULT_MODEL, resolveStepModel, isImageModel, withImageModels } from '../../lib/modelConfig';
import { generateStepImages, fileToBase64, dataUrlToInlineData, type InlineImage } from '../../lib/imageGen';
import { getLayerImageUrls } from '../../canvas-272/lib/layerOutput';
import { resolveSubsetFilter } from '../../rag-optimization/lib/metadataFilter';
import { fetchCorpusDocsForFilter } from '../../rag-optimization/lib/corpusDocs';
import { getTagColor } from '../../components/StepReferenceSelector';
import { useLanguage } from '../../contexts/LanguageContext';
import type { Canvas272Layer } from '../../canvas-272/lib/types';
import OutputFrame from '../../ai-agents/components/OutputFrame';
import {
  corpusRegistryEntryLabel,
  matchRegistryRowsByLayerHints,
  orderedRegistryFetchIdsFromLayerHints,
  pickRegistryRowDisambiguatedByHints,
  resolveLayerCorpusDisplayHint,
  resolveLayerCorpusId,
  collectCorpusIdCandidatesFromLayer,
  technicalCorpusIdMenuLabel,
  isSynthesisReportLayer } from '../lib/corpus';
import { CorpusPickerDropdown, type CorpusPickerItem } from './CorpusPickerDropdown';
import { useStepQc } from '../hooks/useStepQc';
import { useLocalCorpusIngestion } from '../hooks/useLocalCorpusIngestion';
import StepQcPanel from './StepQcPanel';
import AnswerDebugPanel from '../../components/AnswerDebugPanel';
import type { AnswerDebugInfo } from '../../lib/answerDebug';
import { Bug, ShieldCheck, Loader2 } from 'lucide-react';
import type { AgentInputMetadata } from '../../lib/agentFiles';
import { hasAgentInputs } from '../../lib/agentInputs';
import { prepareAgentInputSnapshot } from '../../lib/agentFilesApi';
import { fetchWithAgentInputs, getActiveStepInputs, prepareAgentImagePrompt } from '../../lib/agentInputsClient';
import { buildStepImagePrompt, combineSkillsWithSystemInstruction } from '../../lib/stepPrompt';
import { AgentFilesIndicator } from '../../components/agent-files/AgentFilesPanel';

type AttachTab = 'text' | 'upload' | 'corpus';

interface CorpusSummary {
  id: string;
  corpusId?: string;
  displayName: string;
  files?: Array<{ fileId?: string; name: string; status?: string }>;
  source?: { folderName?: string };
}

interface ProjectCorpusLinkSummary {
  corpusId: string;
  displayName: string;
  ownerEmail: string;
}

interface StepEditorPopupProps {
  open: boolean;
  layer: Canvas272Layer | null;
  allLayers: Canvas272Layer[];
  incomingLayerIds: string[];
  agentName: string | null;
  projectId?: string | null;
  agentInputMetadata?: AgentInputMetadata;
  agentSkillTexts?: readonly string[];
  onClose: () => void;
  onPatchLayer: (patch: Partial<Canvas272Layer>) => void;
  onSaveAgent: () => Promise<{ ok: boolean; error?: string }>;
  externalRunning?: boolean;
  externalError?: string;
  onRunStart?: () => void;
  /** Current user email — used to attribute newly attached corpuses. */
  currentUserEmail?: string;
  /** Corpuses linked to the project (gold-border + cross-user names in the picker). */
  projectCorpusLinks?: ProjectCorpusLinkSummary[];
  /** Called when a corpus is attached, so the parent can add it to the project link list. */
  onAttachCorpusToProject?: (link: { corpusId: string; storeName?: string; displayName: string }) => void;
}

function readStr(layer: Canvas272Layer, key: string): string {
  const v = (layer as unknown as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : '';
}
function readBool(layer: Canvas272Layer, key: string): boolean {
  const v = (layer as unknown as Record<string, unknown>)[key];
  return typeof v === 'boolean' ? v : false;
}
function readStrArr(layer: Canvas272Layer, key: string): string[] {
  const v = (layer as unknown as Record<string, unknown>)[key];
  return Array.isArray(v) ? (v.filter((x) => typeof x === 'string') as string[]) : [];
}

function buildDebugInfo(data: StepRunResponse, model: string): AnswerDebugInfo {
  return {
    reasoning: typeof data.reasoning === 'string' ? data.reasoning : undefined,
    model,
    grounded: data.isGrounded ?? (Array.isArray(data.sources) && data.sources.length > 0),
    sources: Array.isArray(data.sources) ? data.sources : [],
    supports: Array.isArray(data.supports) ? data.supports : [],
    capturedAt: new Date().toISOString(),
  };
}
export default function StepEditorPopup({
  open,
  layer,
  allLayers,
  incomingLayerIds,
  agentName,
  projectId,
  agentInputMetadata,
  agentSkillTexts = [],
  onClose,
  onPatchLayer,
  onSaveAgent,
  externalRunning = false,
  externalError,
  onRunStart,
  currentUserEmail = '',
  projectCorpusLinks = [],
  onAttachCorpusToProject }: StepEditorPopupProps) {
  const { models, catalog, refreshing, refreshCatalog } = useStepModels();
  const modelOptions = useMemo(() => withImageModels(models), [models]);
  const { t } = useLanguage();
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const runControllerRef = useRef<AbortController | null>(null);
  const [activeTab, setActiveTab] = useState<AttachTab>('text');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [lastRunDiagnostics, setLastRunDiagnostics] = useState<StepRunDiagnostics | undefined>(layer?.lastRunDiagnostics);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    setRunError(null);
  }, [open, layer?.id, externalRunning]);

  useEffect(() => {
    setLastRunDiagnostics(layer?.lastRunDiagnostics);
  }, [layer?.id, layer?.lastRunDiagnostics]);

  useEffect(() => {
    setRunning(false);
    return () => {
      runControllerRef.current?.abort();
      runControllerRef.current = null;
    };
  }, [open, layer?.id, projectId, currentUserEmail]);

  const [title, setTitle] = useState<string>('');
  const [tag, setTag] = useState<string>('');
  const [tagEditing, setTagEditing] = useState<boolean>(false);
  const [tagDraft, setTagDraft] = useState<string>('');
  const [showTagPicker, setShowTagPicker] = useState<boolean>(false);
  const [userInstruction, setUserInstruction] = useState<string>('');
  const [systemInstruction, setSystemInstruction] = useState<string>('');
  const [userInput, setUserInput] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  const [preProcess, setPreProcess] = useState<boolean>(false);
  const [qcEnabled, setQcEnabled] = useState<boolean>(false);
  const [result, setResult] = useState<string>('');
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [debugInfo, setDebugInfo] = useState<AnswerDebugInfo | undefined>(undefined);
  const [showDebug, setShowDebug] = useState<boolean>(false);
  const qc = useStepQc();

  const [manualRefs, setManualRefs] = useState<Set<string>>(new Set());

  const [uploadFiles, setUploadFiles] = useState<File[]>([]);

  const [corpora, setCorpora] = useState<CorpusSummary[]>([]);
  const [corporaLoaded, setCorporaLoaded] = useState(false);
  const [corporaError, setCorporaError] = useState<string | null>(null);
  const [selectedCorpusId, setSelectedCorpusId] = useState<string>('');

  // When uploaded files finish indexing into a corpus, attach that corpus to
  // the step (so single-step AND "Run All" use it) and persist it.
  const handleIngestionReady = useCallback(
    async (corpusId: string) => {
      setSelectedCorpusId(corpusId);
      setActiveTab('corpus');
      setUploadFiles([]);
      onPatchLayer({ corpusId, uploadFileJobId: undefined });
      setToast(t('agentnodesPage.stepEditor.upload.indexedReady'));
      try {
        await onSaveAgent();
      } catch {
        // Save errors surface via the normal Save flow; the corpus is already
        // patched into the in-session agent so Run All works this session.
      }
    },
    [onPatchLayer, onSaveAgent, t],
  );
  const ingestion = useLocalCorpusIngestion(handleIngestionReady);
  const {
    phase: ingestPhase,
    processed: ingestProcessed,
    total: ingestTotal,
    error: ingestError,
    start: startIngestion,
    resume: resumeIngestion,
    reset: resetIngestion,
  } = ingestion;

  const synthesisLayerEffectively = useMemo(() => {
    if (!layer) return false;
    const effectiveTag = (tag.trim() || readStr(layer, 'tag')).trim() || undefined;
    return isSynthesisReportLayer({ ...layer, tag: effectiveTag } as Canvas272Layer);
  }, [layer, tag]);

  const attachTabs = useMemo(() => {
    // Mutual exclusion: a corpus and ad-hoc PDF uploads cannot coexist on a step.
    const hasCorpus = Boolean(selectedCorpusId);
    const hasUploads = uploadFiles.length > 0 || Boolean(layer ? readStr(layer, 'uploadFileJobId') : '');
    const all = [
      { id: 'text' as const, label: t('agentnodesPage.stepEditor.tabInputText'), disabled: false },
      { id: 'upload' as const, label: t('agentnodesPage.stepEditor.tabUpload'), disabled: hasCorpus },
      { id: 'corpus' as const, label: t('agentnodesPage.stepEditor.tabCorpus'), disabled: hasUploads },
    ] satisfies Array<{ id: AttachTab; label: string; disabled: boolean }>;
    return synthesisLayerEffectively ? all.filter((tab) => tab.id !== 'corpus') : all;
  }, [t, synthesisLayerEffectively, selectedCorpusId, uploadFiles.length, layer]);

  useEffect(() => {
    if (synthesisLayerEffectively && activeTab === 'corpus') {
      setActiveTab('text');
    }
  }, [synthesisLayerEffectively, activeTab]);

  useEffect(() => {
    if (!open || !layer) return;
    setTitle(layer.name ?? '');
    setTag(layer.tag ?? '');
    setTagEditing(false);
    setTagDraft('');
    setShowTagPicker(false);
    setUserInstruction(readStr(layer, 'userInstruction'));
    setSystemInstruction(readStr(layer, 'systemInstruction'));
    setUserInput(readStr(layer, 'userInput'));
    setSelectedModel(
      typeof layer.selectedModel === 'string' && layer.selectedModel
        ? layer.selectedModel
        : DEFAULT_MODEL,
    );
    setPreProcess(readBool(layer, 'preProcess'));
    setQcEnabled(readBool(layer, 'qcEnabled'));
    setResult(
      (layer.result as string) ||
        (layer.output as string) ||
        (layer.assistantResponse as string) ||
        '',
    );
    setImageUrls(getLayerImageUrls(layer));
    setDebugInfo(layer.debugInfo);
    setShowDebug(false);
    setUploadFiles([]);
    const resolvedCorpusId = resolveLayerCorpusId(layer);
    setSelectedCorpusId(resolvedCorpusId);
    setActiveTab(resolvedCorpusId ? 'corpus' : 'text');
    const persisted = new Set<string>(readStrArr(layer, 'referencedSteps'));
    for (const id of incomingLayerIds) persisted.delete(id);
    setManualRefs(persisted);
    // Resume polling if files were left indexing when the editor last closed.
    const pendingJob = readStr(layer, 'uploadFileJobId');
    if (pendingJob && !resolvedCorpusId) resumeIngestion(pendingJob);
    else resetIngestion();
    qc.reset();
  }, [open, layer?.id, qc.reset, resumeIngestion, resetIngestion]);

  useEffect(() => {
    if (activeTab !== 'corpus' || corporaLoaded) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/rag/corpora', { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { corpora?: CorpusSummary[] };
        if (cancelled) return;
        setCorpora(Array.isArray(data.corpora) ? data.corpora : []);
        setCorporaLoaded(true);
      } catch (err) {
        if (cancelled) return;
        setCorporaError(
          err instanceof Error ? err.message : t('agentnodesPage.stepEditor.corpusLoadFailed'),
        );
        setCorporaLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTab, corporaLoaded, t]);

  useEffect(() => {
    if (!corporaLoaded || corpora.length === 0) return;
    if (!selectedCorpusId) {
      const ragIds = Array.isArray((layer as { ragKnowledge?: unknown } | null)?.ragKnowledge)
        ? ((layer as { ragKnowledge?: Array<{ id?: string }> }).ragKnowledge ?? []).map((r) => r.id)
        : [];
      console.debug('[StepEditorPopup][CorpusNormalize] selectedCorpusId is empty', {
        layerId: layer?.id,
        ragKnowledgeIds: ragIds,
        corporaCount: corpora.length });
      return;
    }
    if (corpora.some((c) => c.id === selectedCorpusId)) {
      console.debug('[StepEditorPopup][CorpusNormalize] canonical', {
        layerId: layer?.id,
        selectedCorpusId });
      return;
    }
    const byAltId = corpora.find((c) => c.corpusId === selectedCorpusId);
    if (byAltId) {
      console.debug('[StepEditorPopup][CorpusNormalize] remapping legacy id', {
        layerId: layer?.id,
        from: selectedCorpusId,
        to: byAltId.id });
      setSelectedCorpusId(byAltId.id);
      return;
    }
    if (layer) {
      const picked = pickRegistryRowDisambiguatedByHints(corpora, layer);
      if (picked?.id) {
        console.debug('[StepEditorPopup][CorpusNormalize] mapped orphan via layer hints', {
          layerId: layer.id,
          from: selectedCorpusId,
          to: picked.id });
        setSelectedCorpusId(picked.id);
        return;
      }
      const hintRows = matchRegistryRowsByLayerHints(corpora, layer);
      if (hintRows.length > 0) {
        console.debug(
          '[StepEditorPopup][CorpusNormalize] hint overlap but no unique corpus (tie or weak score)',
          { layerId: layer.id, count: hintRows.length },
        );
        return;
      }
    }
    console.warn('[StepEditorPopup][CorpusNormalize] unmatched — corpus not in registry', {
      layerId: layer?.id,
      selectedCorpusId,
      corporaIds: corpora.map((c) => c.id).slice(0, 10) });
  }, [corporaLoaded, selectedCorpusId, corpora, layer]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    closeBtnRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!toast) return undefined;
    const id = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(id);
  }, [toast]);

  const incomingSet = useMemo(
    () => new Set(incomingLayerIds),
    [incomingLayerIds],
  );

  const effectiveRefIds = useMemo<string[]>(() => {
    const out = new Set<string>();
    for (const id of incomingLayerIds) out.add(id);
    for (const id of manualRefs) out.add(id);
    return Array.from(out);
  }, [incomingLayerIds, manualRefs]);

  const buildReferenceContext = useCallback((): string => {
    if (effectiveRefIds.length === 0) return '';
    const lines: string[] = [t('agentnodesPage.stepEditor.referencedHeader')];
    for (const refId of effectiveRefIds) {
      const ref = allLayers.find((l) => l.id === refId);
      if (!ref) continue;
      const out =
        (ref.result as string) ||
        (ref.output as string) ||
        (ref.assistantResponse as string) ||
        '';
      if (out) {
        lines.push(
          t('agentnodesPage.stepEditor.referencedStepBlock', {
            name: ref.name || ref.id,
            id: ref.id,
            output: out }),
        );
      }
    }
    return lines.length > 1 ? lines.join('\n') : '';
  }, [effectiveRefIds, allLayers, t]);

  const corpusDocumentSelections = useMemo(
    () => (layer ? readStrArr(layer, 'documentSelections') : []),
    [layer],
  );

  const orphanAttachedCorpusLabel = useMemo(() => {
    if (!layer || !selectedCorpusId) return '';
    // Prefer the display name captured at attach time — survives cross-user sharing
    // where the viewer's registry can't resolve the corpus id.
    const persisted = readStr(layer, 'corpusDisplayName').trim();
    if (persisted && persisted !== selectedCorpusId) return `${persisted} (attached on layer)`;
    const linkName = projectCorpusLinks.find((l) => l.corpusId === selectedCorpusId)?.displayName;
    if (linkName && linkName !== selectedCorpusId) return `${linkName} (attached on layer)`;
    const sid = selectedCorpusId.trim();
    const resolved = resolveLayerCorpusId(layer).trim();
    if (resolved === sid) {
      const hint = resolveLayerCorpusDisplayHint(layer);
      if (hint) return `${hint} (attached on layer)`;
    }
    return technicalCorpusIdMenuLabel(selectedCorpusId);
  }, [layer, selectedCorpusId, projectCorpusLinks]);

  const corpusPickerItems = useMemo<CorpusPickerItem[]>(() => {
    const linkByCorpusId = new Map(projectCorpusLinks.map((l) => [l.corpusId, l]));
    const items: CorpusPickerItem[] = corpora.map((c) => {
      const link = linkByCorpusId.get(c.id) || (c.corpusId ? linkByCorpusId.get(c.corpusId) : undefined);
      const ownerEmail = link?.ownerEmail || currentUserEmail;
      return {
        id: c.id,
        label: corpusRegistryEntryLabel(c),
        ownerEmail,
        isOwn: !link || (ownerEmail || '').toLowerCase() === currentUserEmail.toLowerCase(),
        isProjectLinked: Boolean(link),
      };
    });
    const known = new Set(items.map((i) => i.id));
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
    if (selectedCorpusId && !known.has(selectedCorpusId)) {
      items.push({
        id: selectedCorpusId,
        label: orphanAttachedCorpusLabel || technicalCorpusIdMenuLabel(selectedCorpusId),
        ownerEmail: layer ? readStr(layer, 'corpusOwnerEmail') : undefined,
        isOwn: true,
        isProjectLinked: false,
      });
    }
    return items;
  }, [corpora, projectCorpusLinks, currentUserEmail, selectedCorpusId, orphanAttachedCorpusLabel, layer]);


  const selectedCorpusRow = useMemo(
    () =>
      selectedCorpusId
        ? corpora.find(
            (c) =>
              c.id === selectedCorpusId ||
              (typeof c.corpusId === 'string' && c.corpusId === selectedCorpusId),
          )
        : undefined,
    [corpora, selectedCorpusId],
  );

  const corpusFilesFromList = useMemo(() => {
    const files = selectedCorpusRow?.files;
    return Array.isArray(files) && files.length > 0 ? files : undefined;
  }, [selectedCorpusRow]);

  const [fetchedCorpusFiles, setFetchedCorpusFiles] = useState<
    CorpusSummary['files'] | undefined
  >(undefined);
  const [corpusFilesDetailStatus, setCorpusFilesDetailStatus] = useState<
    'unused' | 'loading' | 'ready' | 'error'
  >('unused');

  const corpusDetailFetchIds = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (s: string) => {
      const t = s.trim();
      if (!t || seen.has(t)) return;
      seen.add(t);
      out.push(t);
    };

    const attachedPresent = corpora.some(
      (c) =>
        c.id === selectedCorpusId ||
        (typeof c.corpusId === 'string' && c.corpusId === selectedCorpusId),
    );

    if (layer && !attachedPresent && corpora.length > 0) {
      for (const id of orderedRegistryFetchIdsFromLayerHints(corpora, layer)) {
        push(id);
      }
    }

    push(selectedCorpusId);
    for (const id of collectCorpusIdCandidatesFromLayer(layer)) push(id);

    return out;
  }, [selectedCorpusId, layer, corpora]);

  useEffect(() => {
    if (activeTab !== 'corpus' || !selectedCorpusId || !corporaLoaded || !layer) {
      setFetchedCorpusFiles(undefined);
      setCorpusFilesDetailStatus('unused');
      return undefined;
    }
    if (corpusFilesFromList) {
      setFetchedCorpusFiles(undefined);
      setCorpusFilesDetailStatus('unused');
      return undefined;
    }
    let cancelled = false;
    setCorpusFilesDetailStatus('loading');
    setFetchedCorpusFiles(undefined);
    (async () => {
      try {
        let resolvedCorpusKey: string | null = null;
        let lastHttpStatus = 0;
        let data: { files?: CorpusSummary['files'] } | null = null;

        for (const tryId of corpusDetailFetchIds) {
          const res = await fetch(
            `/api/rag/corpora/${encodeURIComponent(tryId)}`,
            { credentials: 'include' },
          );
          lastHttpStatus = res.status;
          if (!res.ok) {
            continue;
          }
          resolvedCorpusKey = tryId;
          data = (await res.json()) as { files?: CorpusSummary['files'] };
          break;
        }

        if (!resolvedCorpusKey || !data) {
          throw new Error(`HTTP ${lastHttpStatus}`);
        }

        const n = Array.isArray(data.files) ? data.files.length : 0;
        if (!cancelled) {
          if (n > 0) {
            setFetchedCorpusFiles(Array.isArray(data.files) ? data.files : []);
            setCorpusFilesDetailStatus('ready');
            return;
          }
          const dres = await fetch(
            `/api/rag/corpora/${encodeURIComponent(resolvedCorpusKey)}/documents`,
            { credentials: 'include' },
          );
          if (dres.ok) {
            const djson = (await dres.json()) as {
              documents?: Array<{ pdfName: string; state: string }>;
            };
            const live = djson.documents ?? [];
            const mapped: NonNullable<CorpusSummary['files']> = live.map(
              (d) => ({
                fileId: d.pdfName,
                name: d.pdfName,
                status:
                  d.state === 'ACTIVE'
                    ? 'indexed'
                    : d.state === 'FAILED'
                      ? 'error'
                      : 'indexing' }),
            );
            if (!cancelled) {
              setFetchedCorpusFiles(mapped);
              setCorpusFilesDetailStatus('ready');
            }
            return;
          }
          if (!cancelled) {
            setFetchedCorpusFiles([]);
            setCorpusFilesDetailStatus('ready');
          }
        }
      } catch {
        if (!cancelled) {
          setFetchedCorpusFiles(undefined);
          setCorpusFilesDetailStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTab, selectedCorpusId, corporaLoaded, corpusFilesFromList, corpusDetailFetchIds, layer]);

  const pushLayerPatch = useCallback(
    (patch: Partial<Canvas272Layer>) => onPatchLayer(patch),
    [onPatchLayer],
  );

  const handleSelectCorpus = useCallback((nextCorpusId: string) => {
    setSelectedCorpusId(nextCorpusId);
    const matchedRow = corpora.find((c) => c.id === nextCorpusId || c.corpusId === nextCorpusId);
    const label = matchedRow
      ? corpusRegistryEntryLabel(matchedRow)
      : projectCorpusLinks.find((l) => l.corpusId === nextCorpusId)?.displayName || nextCorpusId;
    // Reset document scope on change; write display-name/owner + clear uploads
    // (mutual exclusion); register the corpus with the project.
    pushLayerPatch({
      documentSelections: [],
      ...({
        corpusId: nextCorpusId || undefined,
        corpusDisplayName: nextCorpusId ? label : undefined,
        corpusOwnerEmail: nextCorpusId
          ? (layer ? readStr(layer, 'corpusOwnerEmail') || currentUserEmail || undefined : currentUserEmail || undefined)
          : undefined,
        uploadFileJobId: undefined,
        uploadedFileNames: nextCorpusId ? [] : (layer ? (layer.uploadedFileNames as string[] | undefined) : undefined),
      } as unknown as Partial<Canvas272Layer>),
    } as unknown as Partial<Canvas272Layer>);
    if (nextCorpusId) {
      setUploadFiles([]);
      const storeName = matchedRow && typeof matchedRow.corpusId === 'string' ? matchedRow.corpusId : undefined;
      onAttachCorpusToProject?.({ corpusId: nextCorpusId, storeName, displayName: label });
    }
  }, [corpora, projectCorpusLinks, pushLayerPatch, layer, currentUserEmail, onAttachCorpusToProject]);

  const toggleManualRef = useCallback(
    (id: string, checked: boolean) => {
      setManualRefs((prev) => {
        const next = new Set(prev);
        if (checked) next.add(id);
        else next.delete(id);
        return next;
      });
      const combined = new Set<string>(incomingLayerIds);
      if (checked) combined.add(id);
      for (const prev of manualRefs) if (prev !== id || checked) combined.add(prev);
      pushLayerPatch(
        { referencedSteps: Array.from(combined) } as unknown as Partial<Canvas272Layer>,
      );
    },
    [incomingLayerIds, manualRefs, pushLayerPatch],
  );

  const onPickUploadFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      const arr = Array.from(files).filter((f) => f.size > 0);
      setUploadFiles((prev) => [...prev, ...arr]);
    },
    [],
  );
  const removeUploadFile = useCallback((index: number) => {
    setUploadFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Ingest the uploaded files into a durable file-search corpus so the whole
  // graph "Run All" can use them (Run All has no file-upload transport; it only
  // queries a corpus). New corpus the first time; appends to the step's corpus
  // if one is already attached.
  const handleIndexForRunAll = useCallback(async () => {
    if (!layer) return;
    if (uploadFiles.length === 0) {
      setToast(t('agentnodesPage.stepEditor.attachFile'));
      return;
    }
    const baseName = (title.trim() || layer.name || 'Step').trim();
    const displayName = `${baseName} — ${t('agentnodesPage.stepEditor.upload.corpusSuffix')}`;
    const names = uploadFiles.map((f) => f.name);
    try {
      const jobId = await startIngestion({
        files: uploadFiles,
        displayName,
        existingCorpusId: selectedCorpusId || undefined,
      });
      onPatchLayer({ uploadFileJobId: jobId, uploadedFileNames: names });
    } catch (err) {
      setToast(err instanceof Error ? err.message : t('agentnodesPage.stepEditor.upload.indexFailed'));
    }
  }, [layer, uploadFiles, title, selectedCorpusId, startIngestion, onPatchLayer, t]);

  const runStep = useCallback(async () => {
    if (!layer || running || externalRunning) return;
    if (!userInstruction.trim()) {
      setToast(t('agentnodesPage.stepEditor.enterInstruction'));
      return;
    }
    const startedAt = new Date().toISOString();
    const model = resolveStepModel(selectedModel);
    const controller = new AbortController();
    runControllerRef.current = controller;
    setRunning(true);
    setRunError(null);
    setLastRunDiagnostics(undefined);
    if (layer.lastRunDiagnostics) pushLayerPatch({ lastRunDiagnostics: undefined });
    onRunStart?.();
    try {
      if (isGalileoModel(model)) await assertStepModelReady(model, controller.signal);
      const sharedInputs = hasAgentInputs(agentInputMetadata) ? await prepareAgentInputSnapshot(agentInputMetadata, controller.signal) : null;
      const localInputs = getActiveStepInputs(activeTab, uploadFiles, selectedCorpusId, readStrArr(layer, 'documentSelections'), layer.ragKnowledge, projectId);
      const refContext = buildReferenceContext();
      const baseText = [
        userInstruction.trim(),
        refContext ? `\n\n${refContext}` : '',
        activeTab === 'text' && userInput.trim()
          ? t('agentnodesPage.stepEditor.promptUserInputLead', { text: userInput.trim() })
          : '',
      ]
        .filter(Boolean)
        .join('');
      const messages = [{ role: 'user', text: baseText }];

      let out = '';
      let captured: AnswerDebugInfo | undefined;
      let runDiagnostics: StepRunDiagnostics | undefined;
      const systemInstructionForRun = combineSkillsWithSystemInstruction(systemInstruction, agentSkillTexts) || undefined;
      const sharedBody = { model, messages, systemInstruction: systemInstructionForRun,
        ...getGalileoGenerationSettings(model, layer), projectId: projectId || undefined, ragKnowledge: localInputs.ragKnowledge };

      if (isImageModel(selectedModel)) {
        // Image generation: base image comes from an uploaded image on this step,
        // else the first generated image of a referenced upstream step.
        let base: InlineImage | null = null;
        const uploadedImage = uploadFiles.find((f) => f.type.startsWith('image/'));
        if (uploadedImage) {
          base = await fileToBase64(uploadedImage);
        } else {
          for (const refId of effectiveRefIds) {
            const ref = allLayers.find((l) => l.id === refId);
            const refImage = ref ? getLayerImageUrls(ref)[0] : undefined;
            if (refImage) {
              base = dataUrlToInlineData(refImage);
              if (base) break;
            }
          }
        }
        const { imageUrls: generated, text } = await generateStepImages({
          prompt: sharedInputs ? await prepareAgentImagePrompt(sharedInputs, sharedBody, localInputs.files, localInputs.corpora, controller.signal) : buildStepImagePrompt(messages, systemInstructionForRun),
          model: selectedModel,
          base,
        });
        if (runControllerRef.current !== controller || controller.signal.aborted) return;
        setResult(text ?? '');
        setImageUrls(generated);
        setDebugInfo(undefined);
        pushLayerPatch({ result: text ?? '', imageUrls: generated } as Partial<Canvas272Layer>);
        setToast(t('agentnodesPage.stepEditor.imageRanOk'));
        qc.reset();
        return;
      }

      if (sharedInputs) {
        const res = await fetchWithAgentInputs(sharedInputs, sharedBody, localInputs.files, localInputs.corpora, controller.signal);
        const data = await readStepRunResponse(res, false, model);
        out = data.response ?? '';
        captured = buildDebugInfo(data, model);
        runDiagnostics = data.runDiagnostics;
      } else if (activeTab === 'corpus') {
        if (!selectedCorpusId) {
          throw new Error(t('agentnodesPage.stepEditor.pickCorpus'));
        }
        const documentSelections = readStrArr(layer, 'documentSelections');
        // Resolve the subset to a stable file_id filter (pdf_name fallback for old
        // corpora); search whole corpus if the doc list can't be fetched.
        let metadataFilter: string | undefined;
        if (documentSelections.length > 0) {
          const allDocs = await fetchCorpusDocsForFilter(selectedCorpusId);
          if (allDocs.length > 0) {
            const subset = resolveSubsetFilter(documentSelections, allDocs);
            if (subset.action === 'block') {
              throw new Error(t('agentnodesPage.stepEditor.docsNotInCorpus'));
            }
            metadataFilter = subset.filter;
          }
        }
        const res = await fetch(getStepEndpoint(model, true), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            corpusId: selectedCorpusId,
            messages,
            systemInstruction:
              combineSkillsWithSystemInstruction([userInstruction.trim(), systemInstruction.trim()].filter(Boolean).join('\n\n'), agentSkillTexts) ||
              undefined,
            model,
            ...getGalileoGenerationSettings(model, layer),
            ...(isGalileoModel(model) ? { projectId: projectId || undefined, corpusIds: Array.from(new Set([selectedCorpusId, ...collectCorpusIdCandidatesFromLayer(layer)])) } : {}),
            metadataFilter }),
          credentials: 'include', signal: controller.signal });
        const data = await readStepRunResponse(res, !isGalileoModel(model), model);
        out = data.response ?? '';
        captured = buildDebugInfo(data, model);
        runDiagnostics = data.runDiagnostics;
      } else if (activeTab === 'upload') {
        if (uploadFiles.length === 0) {
          throw new Error(t('agentnodesPage.stepEditor.attachFile'));
        }
        const fd = new FormData();
        uploadFiles.forEach((f, i) => fd.append(`file${i}`, f));
        fd.append('messages', JSON.stringify(messages));
        fd.append('model', model);
        for (const [key, value] of Object.entries(getGalileoGenerationSettings(model, layer))) fd.append(key, JSON.stringify(value));
        if (projectId && isGalileoModel(model)) fd.append('projectId', projectId);
        if (systemInstructionForRun) fd.append('systemInstruction', systemInstructionForRun);
        const res = await fetch(getStepEndpoint(model), { method: 'POST', body: fd, signal: controller.signal });
        const data = await readStepRunResponse(res, false, model);
        out = data.response ?? '';
        captured = buildDebugInfo(data, model);
        runDiagnostics = data.runDiagnostics;
      } else {
        const res = await fetch(getStepEndpoint(model), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages, model, systemInstruction: systemInstructionForRun, ...getGalileoGenerationSettings(model, layer) }), signal: controller.signal });
        const data = await readStepRunResponse(res, false, model);
        out = data.response ?? '';
        captured = buildDebugInfo(data, model);
        runDiagnostics = data.runDiagnostics;
      }

      if (runControllerRef.current !== controller || controller.signal.aborted) return;
      setResult(out);
      setImageUrls([]);
      setDebugInfo(captured);
      setLastRunDiagnostics(runDiagnostics);
      pushLayerPatch({ result: out, debugInfo: captured, ...(runDiagnostics ? { lastRunDiagnostics: runDiagnostics } : {}) });
      setToast(t('agentnodesPage.stepEditor.ranOk'));
      // A new answer was produced — clear any stale QC results. QC is a separate,
      // user-triggered pass on the produced answer (the "Run QC" button), not part
      // of running the step.
      qc.reset();
    } catch (err) {
      if (runControllerRef.current !== controller) return;
      const diagnostics = getStepFailureDiagnostics(err, model, startedAt);
      if (diagnostics) {
        setLastRunDiagnostics(diagnostics);
        pushLayerPatch({ lastRunDiagnostics: diagnostics });
      }
      if (err instanceof Error && err.name === 'AbortError') return;
      const message = err instanceof Error ? err.message : t('agentnodesPage.stepEditor.runFailed');
      setRunError(message);
      setToast(message);
    } finally {
      if (runControllerRef.current === controller) {
        runControllerRef.current = null;
        setRunning(false);
      }
    }
  }, [
    layer,
    running,
    externalRunning,
    projectId,
    agentInputMetadata,
    agentSkillTexts,
    onRunStart,
    userInstruction,
    systemInstruction,
    userInput,
    selectedModel,
    activeTab,
    selectedCorpusId,
    uploadFiles,
    effectiveRefIds,
    allLayers,
    buildReferenceContext,
    pushLayerPatch,
    qc.reset,
    t,
  ]);

  const handleSave = useCallback(async () => {
    if (!layer) return;
    pushLayerPatch({
      name: title,
      tag: tag || undefined,
      userInstruction,
      selectedModel,
      referencedSteps: effectiveRefIds,
      ...({
        systemInstruction,
        userInput,
        preProcess,
        qcEnabled,
        corpusId: selectedCorpusId || undefined } as unknown as Partial<Canvas272Layer>) });
    setSaving(true);
    const res = await onSaveAgent();
    setSaving(false);
    setToast(res.ok ? t('agentnodesPage.stepEditor.savedProject') : res.error ?? t('agentnodesPage.stepEditor.saveFailed'));
  }, [
    layer,
    title,
    tag,
    userInstruction,
    systemInstruction,
    selectedModel,
    effectiveRefIds,
    userInput,
    preProcess,
    qcEnabled,
    selectedCorpusId,
    pushLayerPatch,
    onSaveAgent,
    t,
  ]);

  const resultText = useMemo(() => result, [result]);

  if (!open || !layer) return null;

  const otherLayers = allLayers.filter((l) => l.id !== layer.id);

  return (
    <div
      className="c272-modal-backdrop an-step-popup-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('agentnodesPage.stepEditor.aria')}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="c272-modal an-popup an-step-popup">
        <div className="c272-modal__header an-popup__header">
          <div className="c272-modal__title an-step-popup__title-block">
            <input
              type="text"
              className="an-step-popup__title-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => pushLayerPatch({ name: title })}
              aria-label={t('agentnodesPage.stepEditor.nameAria')}
              placeholder={t('agentnodesPage.stepEditor.namePh')}
            />
            <span className="c272-modal__sub">
              <AgentFilesIndicator metadata={agentInputMetadata} />
              {agentName
                ? `${t('agentnodesPage.frameModal.subPrefix')} • ${agentName}`
                : t('agentnodesPage.frameModal.subPrefix')}
            </span>
          </div>
          <div className="c272-modal__spacer" />
          <button
            ref={closeBtnRef}
            type="button"
            className="c272-modal__close"
            aria-label={t('agentnodesPage.common.close')}
            title={t('agentnodesPage.common.closeEsc')}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="an-step-popup__runbar">
          <label className="an-step-popup__field">
            <span className="an-step-popup__field-label">{t('agentnodesPage.stepEditor.modelLabel')}</span>
            <select
              className="an-step-popup__select"
              value={selectedModel}
              onChange={(e) => {
                if (!canSelectStepModel(e.target.value, models)) return;
                setSelectedModel(e.target.value);
                pushLayerPatch({ selectedModel: e.target.value });
              }}
            >
              <StepModelOptions models={modelOptions} selectedModel={selectedModel} />
            </select>
          </label>
          <label className="an-step-popup__checkbox">
            <input
              type="checkbox"
              checked={preProcess}
              onChange={(e) => {
                setPreProcess(e.target.checked);
                pushLayerPatch(
                  { preProcess: e.target.checked } as unknown as Partial<Canvas272Layer>,
                );
              }}
            />
            <span>{t('agentnodesPage.stepEditor.preProcessLabel')}</span>
          </label>
          <label className="an-step-popup__checkbox">
            <input
              type="checkbox"
              checked={qcEnabled}
              onChange={(e) => {
                setQcEnabled(e.target.checked);
                pushLayerPatch(
                  { qcEnabled: e.target.checked } as unknown as Partial<Canvas272Layer>,
                );
              }}
            />
            <span>{t('agentnodesPage.stepEditor.qcLabel')}</span>
          </label>
          {}
          {(() => {
            const existingTags = Array.from(
              new Set(
                allLayers
                  .filter((l) => l.id !== layer?.id && l.tag)
                  .map((l) => l.tag as string),
              ),
            );
            const commitTag = (val: string) => {
              const trimmed = val.trim();
              setTag(trimmed);
              setTagEditing(false);
              setShowTagPicker(false);
              pushLayerPatch({ tag: trimmed || undefined });
            };
            return (
              <div className="an-step-popup__tag-field" style={{ position: 'relative' }}>
                {tagEditing ? (
                  <input
                    type="text"
                    className="an-step-popup__tag-input"
                    value={tagDraft}
                    autoFocus
                    placeholder={t('agentnodesPage.stepEditor.collectionPlaceholder')}
                    onChange={(e) => setTagDraft(e.target.value)}
                    onBlur={() => commitTag(tagDraft)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitTag(tagDraft); }
                      else if (e.key === 'Escape') { e.preventDefault(); setTagEditing(false); setShowTagPicker(false); }
                    }}
                  />
                ) : showTagPicker ? (
                  <div className="an-step-popup__tag-picker" onMouseDown={(e) => e.preventDefault()}>
                    {existingTags.map((tagOption) => {
                      const tc = getTagColor(tagOption);
                      return (
                        <button
                          key={tagOption}
                          type="button"
                          className="an-step-popup__tag-picker-option"
                          style={{ background: tc.bg, borderColor: tc.border, color: tc.text }}
                          onMouseDown={() => commitTag(tagOption)}
                        >
                          {tagOption}
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      className="an-step-popup__tag-picker-new"
                      onMouseDown={() => { setShowTagPicker(false); setTagDraft(''); setTagEditing(true); }}
                    >
                      {t('agentnodesPage.stepEditor.newCollection')}
                    </button>
                  </div>
                ) : tag ? (
                  (() => {
                    const tc = getTagColor(tag);
                    return (
                      <button
                        type="button"
                        className="an-step-popup__tag-pill"
                        style={{ background: tc.border, borderColor: tc.border, color: '#fff' }}
                        title={t('agentnodesPage.stepEditor.editTagTitle')}
                        onClick={() => { setTagDraft(tag); setTagEditing(true); }}
                      >
                        {tag}
                        <span
                          className="an-step-popup__tag-pill-clear"
                          role="button"
                          aria-label={t('agentnodesPage.stepEditor.removeTagAria')}
                          onClick={(e) => { e.stopPropagation(); commitTag(''); }}
                        >
                          ✕
                        </span>
                      </button>
                    );
                  })()
                ) : (
                  <button
                    type="button"
                    className="an-step-popup__tag-add"
                    title={t('agentnodesPage.stepEditor.addCollectionTitle')}
                    onBlur={() => setShowTagPicker(false)}
                    onClick={() => {
                      if (existingTags.length > 0) {
                        setShowTagPicker(true);
                      } else {
                        setTagDraft('');
                        setTagEditing(true);
                      }
                    }}
                  >
                    {t('agentnodesPage.stepEditor.addCollectionBtn')}
                  </button>
                )}
              </div>
            );
          })()}

          <div className="c272-modal__spacer" />
          <button
            type="button"
            className="an-step-popup__run"
            onClick={runStep}
            disabled={running || externalRunning || !userInstruction.trim()}
            title={
              userInstruction.trim()
                ? t('agentnodesPage.stepEditor.runThisStepTitle')
                : t('agentnodesPage.stepEditor.enterInstructionFirst')
            }
          >
            {running || externalRunning ? t('agentnodesPage.stepEditor.running') : t('agentnodesPage.stepEditor.runButton')}
          </button>
        </div>

        <div className="an-step-popup__body">
          <GalileoCatalogStatus catalog={catalog} refreshing={refreshing} onRefresh={refreshCatalog} />
          <StepRunStatus diagnostics={lastRunDiagnostics} />
          <div className="an-step-popup__group">
            <label className="an-step-popup__group-label" htmlFor="an-user-instruction">
              {t('agentnodesPage.stepEditor.userInstructionLabel')}
            </label>
            <textarea
              id="an-user-instruction"
              className="an-step-popup__textarea"
              value={userInstruction}
              onChange={(e) => setUserInstruction(e.target.value)}
              onBlur={() => pushLayerPatch({ userInstruction })}
              placeholder={t('agentnodesPage.stepEditor.userInstructionPlaceholder')}
              rows={4}
            />
          </div>

          <div className="an-step-popup__group">
            <label className="an-step-popup__group-label" htmlFor="an-system-instruction">
              {t('agentnodesPage.stepEditor.systemInstructionLabel')}
            </label>
            <textarea
              id="an-system-instruction"
              className="an-step-popup__textarea"
              value={systemInstruction}
              onChange={(e) => setSystemInstruction(e.target.value)}
              onBlur={() => pushLayerPatch({ systemInstruction } as unknown as Partial<Canvas272Layer>)}
              placeholder={t('agentnodesPage.stepEditor.systemInstructionPlaceholder')}
              rows={3}
            />
          </div>

          {}
          <div className="an-step-popup__group">
            <label className="an-step-popup__group-label">
              {t('agentnodesPage.stepEditor.referencedStepsLabel')}
              <span className="an-step-popup__hint">
                {' '}
                {t('agentnodesPage.stepEditor.referencedStepsHint')}
              </span>
            </label>
            {otherLayers.length === 0 ? (
              <div className="an-step-popup__tab-placeholder">
                {t('agentnodesPage.stepEditor.noOtherSteps')}
              </div>
            ) : (
              <ul className="an-step-popup__refs">
                {otherLayers.map((l) => {
                  const linked = incomingSet.has(l.id);
                  const checked = linked || manualRefs.has(l.id);
                  return (
                    <li key={l.id} className="an-step-popup__ref">
                      <label
                        className={
                          'an-step-popup__ref-row' +
                          (linked ? ' an-step-popup__ref-row--linked' : '')
                        }
                        title={
                          linked
                            ? t('agentnodesPage.stepEditor.linkedViaEdgeTitle')
                            : t('agentnodesPage.stepEditor.manualReferenceTitle')
                        }
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={linked}
                          onChange={(e) => toggleManualRef(l.id, e.target.checked)}
                        />
                        <span className="an-step-popup__ref-name">{l.name || l.id}</span>
                        {linked ? (
                          <span className="an-step-popup__ref-badge">
                            {t('agentnodesPage.stepEditor.graphBadge')}
                          </span>
                        ) : null}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {}
          <div className="an-step-popup__group">
            <div className="an-step-popup__tabs" role="tablist">
              {attachTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  disabled={tab.disabled}
                  title={
                    tab.disabled
                      ? tab.id === 'corpus'
                        ? t('agentnodesPage.stepEditor.corpusDisabledByUploads')
                        : t('agentnodesPage.stepEditor.uploadDisabledByCorpus')
                      : undefined
                  }
                  className={
                    'an-step-popup__tab' +
                    (activeTab === tab.id ? ' an-step-popup__tab--active' : '') +
                    (tab.disabled ? ' an-step-popup__tab--disabled' : '')
                  }
                  onClick={() => { if (!tab.disabled) setActiveTab(tab.id); }}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {activeTab === 'text' ? (
              <textarea
                className="an-step-popup__textarea"
                value={userInput}
                onChange={(e) => setUserInput(e.target.value)}
                onBlur={() =>
                  pushLayerPatch(
                    { userInput } as unknown as Partial<Canvas272Layer>,
                  )
                }
                placeholder={t('agentnodesPage.stepEditor.userInputPlaceholder')}
                rows={5}
              />
            ) : activeTab === 'upload' ? (
              <div className="an-step-popup__upload">
                <input
                  type="file"
                  multiple
                  onChange={(e) => onPickUploadFiles(e.target.files)}
                />
                {uploadFiles.length > 0 ? (
                  <ul className="an-step-popup__chips">
                    {uploadFiles.map((f, i) => (
                      <li key={`${f.name}-${i}`} className="an-step-popup__chip">
                        <span>{f.name}</span>
                        <button
                          type="button"
                          className="an-step-popup__chip-x"
                          aria-label={t('agentnodesPage.stepEditor.removeFileAria', {
                            name: f.name })}
                          onClick={() => removeUploadFile(i)}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="an-step-popup__hint">
                    {t('agentnodesPage.stepEditor.uploadHint')}
                  </div>
                )}
                <div className="an-step-popup__upload-index">
                  {ingestPhase === 'uploading' || ingestPhase === 'indexing' ? (
                    <div className="an-step-popup__hint">
                      <Loader2 size={14} className="animate-spin" />{' '}
                      {t('agentnodesPage.stepEditor.upload.indexing', {
                        processed: ingestProcessed,
                        total: ingestTotal })}
                    </div>
                  ) : ingestPhase === 'ready' ? (
                    <div className="an-step-popup__hint">
                      {t('agentnodesPage.stepEditor.upload.indexedReady')}
                    </div>
                  ) : ingestPhase === 'error' ? (
                    <div className="an-step-popup__tab-placeholder">
                      <span>
                        {t('agentnodesPage.stepEditor.upload.indexFailed')}
                        {ingestError ? `: ${ingestError}` : ''}
                      </span>
                      <button
                        type="button"
                        className="an-step-popup__retry-btn"
                        onClick={handleIndexForRunAll}
                        disabled={uploadFiles.length === 0}
                      >
                        {t('agentnodesPage.stepEditor.retry')}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="an-step-popup__retry-btn"
                      onClick={handleIndexForRunAll}
                      disabled={uploadFiles.length === 0}
                    >
                      {t('agentnodesPage.stepEditor.upload.indexForRunAll')}
                    </button>
                  )}
                  <div className="an-step-popup__hint">
                    {t('agentnodesPage.stepEditor.upload.runAllHint')}
                  </div>
                </div>
              </div>
            ) : activeTab === 'corpus' ? (
              <div className="an-step-popup__corpus">
                {!corporaLoaded ? (
                  <div className="an-step-popup__hint">{t('agentnodesPage.stepEditor.loadingCorpora')}</div>
                ) : corporaError ? (
                  <div className="an-step-popup__tab-placeholder">
                    <span>
                      {t('agentnodesPage.stepEditor.corpusLoadError', {
                        message: corporaError })}
                    </span>
                    <button
                      type="button"
                      className="an-step-popup__retry-btn"
                      onClick={() => {
                        setCorporaError(null);
                        setCorporaLoaded(false);
                      }}
                    >
                      {t('agentnodesPage.stepEditor.retry')}
                    </button>
                  </div>
                ) : corpora.length === 0 && !selectedCorpusId ? (
                  <div className="an-step-popup__tab-placeholder">
                    {t('agentnodesPage.stepEditor.noCorpora')}
                  </div>
                ) : (
                  <label className="an-step-popup__field">
                    <span className="an-step-popup__field-label">
                      {t('agentnodesPage.stepEditor.corpusSelectLabel')}
                    </span>
                    <CorpusPickerDropdown
                      items={corpusPickerItems}
                      value={selectedCorpusId}
                      searchable
                      placeholder={t('agentnodesPage.stepEditor.pickCorpusOption')}
                      searchPlaceholder={t('agentnodesPage.stepEditor.corpusSearchPlaceholder')}
                      createdByLabel={(name) => t('agentnodesPage.stepEditor.corpusCreatedBy', { name })}
                      filterMineLabel={t('agentnodesPage.stepEditor.corpusFilterMine')}
                      filterProjectLabel={t('agentnodesPage.stepEditor.corpusFilterProject')}
                      filterOthersLabel={t('agentnodesPage.stepEditor.corpusFilterOthers')}
                      allAuthorsLabel={t('agentnodesPage.stepEditor.corpusFilterAllAuthors')}
                      onChange={handleSelectCorpus}
                    />
                  </label>
                )}
                {selectedCorpusId && corporaLoaded && !corporaError ? (
                  <div className="an-step-popup__corpus-pdfs">
                    <span className="an-step-popup__field-label">
                      {t('agentnodesPage.stepEditor.pdfsInCorpus')}
                    </span>
                    {corpusFilesFromList && corpusFilesFromList.length > 0 ? (
                      <ul className="an-step-popup__corpus-pdf-list">
                        {corpusFilesFromList.map((f) => {
                          const label = f.name.split(/[/\\]/).pop() ?? f.name;
                          const key = f.fileId || f.name;
                          return (
                            <li key={key} className="an-step-popup__corpus-pdf-item" title={f.name}>
                              <span className="an-step-popup__corpus-pdf-name">{label}</span>
                              {f.status && f.status !== 'indexed' ? (
                                <span className="an-step-popup__corpus-pdf-status">{f.status}</span>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    ) : corpusFilesDetailStatus === 'error' ? (
                      <div className="an-step-popup__hint">
                        {t('agentnodesPage.stepEditor.corpusFileListFailed')}
                      </div>
                    ) : corpusFilesDetailStatus === 'ready' &&
                      (!fetchedCorpusFiles || fetchedCorpusFiles.length === 0) ? (
                      <div className="an-step-popup__hint">
                        {t('agentnodesPage.stepEditor.noFilesInCorpus')}
                      </div>
                    ) : corpusFilesDetailStatus === 'ready' && fetchedCorpusFiles && fetchedCorpusFiles.length > 0 ? (
                      <ul className="an-step-popup__corpus-pdf-list">
                        {fetchedCorpusFiles.map((f) => {
                          const label = f.name.split(/[/\\]/).pop() ?? f.name;
                          const key = f.fileId || f.name;
                          return (
                            <li key={key} className="an-step-popup__corpus-pdf-item" title={f.name}>
                              <span className="an-step-popup__corpus-pdf-name">{label}</span>
                              {f.status && f.status !== 'indexed' ? (
                                <span className="an-step-popup__corpus-pdf-status">{f.status}</span>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <div className="an-step-popup__hint">
                        {t('agentnodesPage.stepEditor.loadingFileList')}
                      </div>
                    )}
                  </div>
                ) : null}
                {layer ? (
                  <div className="an-step-popup__corpus-docs">
                    <span className="an-step-popup__field-label">
                      {t('agentnodesPage.stepEditor.documentsInScope')}
                    </span>
                    {corpusDocumentSelections.length === 0 ? (
                      <div className="an-step-popup__hint">
                        {t('agentnodesPage.stepEditor.fullCorpusHint')}
                      </div>
                    ) : (
                      <ul className="an-step-popup__chips">
                        {corpusDocumentSelections.map((doc) => (
                          <li
                            key={doc}
                            className="an-step-popup__chip an-step-popup__chip--static"
                            title={doc}
                          >
                            {doc.split(/[/\\]/).pop() ?? doc}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
                <div className="an-step-popup__hint">
                  {t('agentnodesPage.stepEditor.corpusRagHint')}
                </div>
              </div>
            ) : null}
          </div>

          <div className="an-step-popup__group">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <label className="an-step-popup__group-label">{t('agentnodesPage.stepEditor.resultLabel')}</label>
              {debugInfo ? (
                <button
                  type="button"
                  onClick={() => setShowDebug(true)}
                  aria-label={t('answerDebug.openAria')}
                  title={t('answerDebug.title')}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                    cursor: 'pointer',
                    background: 'none',
                    border: 'none',
                    color: '#6366f1',
                    padding: '0.15rem',
                  }}
                >
                  <Bug size={16} />
                </button>
              ) : null}
              {qcEnabled && resultText.trim() ? (
                <button
                  type="button"
                  onClick={() => {
                    if (!selectedCorpusId) {
                      setToast(t('agentnodesPage.stepEditor.qc.needCorpus'));
                      return;
                    }
                    qc.runExtract(resultText, selectedCorpusId);
                  }}
                  disabled={qc.phase === 'extracting' || qc.phase === 'verifying'}
                  aria-label={t('agentnodesPage.stepEditor.qc.runQc')}
                  title={
                    selectedCorpusId
                      ? t('agentnodesPage.stepEditor.qc.runQc')
                      : t('agentnodesPage.stepEditor.qc.needCorpus')
                  }
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                    cursor: qc.phase === 'extracting' || qc.phase === 'verifying' ? 'default' : 'pointer',
                    background: 'none',
                    border: 'none',
                    color: '#6366f1',
                    padding: '0.15rem',
                    opacity: selectedCorpusId ? 1 : 0.45,
                  }}
                >
                  {qc.phase === 'extracting' || qc.phase === 'verifying' ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <ShieldCheck size={16} />
                  )}
                </button>
              ) : null}
            </div>
            <OutputFrame layer={{ ...layer, result: resultText, imageUrls }} running={running || externalRunning} error={runError ?? externalError}>
            <div className="an-step-popup__result">
              {resultText ? (
                <div className="an-step-popup__result-md markdown-body">
                  <MathMarkdown content={resultText} />
                </div>
              ) : imageUrls.length === 0 ? (
                <div className="an-step-popup__result-empty">{t('agentnodesPage.stepEditor.noOutputYet')}</div>
              ) : null}
              {imageUrls.length > 0 ? (
                <div className="an-step-popup__result-images">
                  {imageUrls.map((url, i) => (

                    <img key={i} src={url} alt={t('agentnodesPage.stepEditor.generatedImageAlt')} />
                  ))}
                </div>
              ) : null}
            </div>
            </OutputFrame>
          </div>

          {qcEnabled ? (
            <div className="an-step-popup__group">
              <StepQcPanel
                qc={qc}
                corpusLinked={Boolean(selectedCorpusId)}
                onVerify={() => qc.verifySelected(selectedCorpusId)}
                t={t}
              />
            </div>
          ) : null}
        </div>

        <div className="an-step-popup__footer">
          <div className="c272-modal__spacer" />
          <button type="button" className="c272-btn" onClick={onClose}>
            {t('agentnodesPage.common.cancel')}
          </button>
          <button
            type="button"
            className="c272-btn c272-btn--primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? t('agentnodesPage.stepEditor.saving') : t('agentnodesPage.stepEditor.save')}
          </button>
        </div>

        {toast ? (
          <div className="an-step-popup__toast" role="status">
            {toast}
          </div>
        ) : null}
      </div>
      <AnswerDebugPanel open={showDebug} debugInfo={debugInfo} onClose={() => setShowDebug(false)} />
    </div>
  );
}
