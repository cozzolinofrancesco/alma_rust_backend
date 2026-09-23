'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import type { Recipe } from './AgentSidebar';
import { useSession } from 'next-auth/react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { RECIPES } from '../../canvas-272/lib/recipesCatalog';
import AgentSidebar from './AgentSidebar';
import AgentNodesDiagram, {
  type AgentNodesDiagramHandle,
} from './AgentNodesDiagram';
import StepEditorModal from '../../canvas-272/components/StepEditorModal';
import StepEditorPopup from './StepEditorPopup';
import { v1ScanProjectCorpusLinks, v1AddProjectCorpusLink, type ProjectCorpusLink } from '../../lib/agentnodesApi/agentnodesV1Client';
import AgentNodesTutorialModal from './AgentNodesTutorialModal';
import type { TutorialStep } from '../../components/tutorial/ContentVariants';
import SimulateRecordModal from './SimulateRecordModal';
import RunAllConfirmModal from './RunAllConfirmModal';
import { formatAgentToolbarTitle } from '../../canvas-272/lib/agentDisplayName';
import { useAgentNodesData } from '../hooks/useAgentNodesData';
import { useOptionalAgentEditor } from '../../ai-agents/edit/[agent-id]/AgentEditorContext';
import { useAgentGraph } from '../hooks/useAgentGraph';
import { BLANK_AGENT_STARTER_POSITION } from '../lib/initialGraph';
import { USER_STEP_LAYER_PREFIX } from '../lib/validatePersistedAgentGraph';
import { useGraphRunner } from '../hooks/useGraphRunner';
import SkillsPanel from '../../components/skills/SkillsPanel';
import AgentFilesPanel from '../../components/agent-files/AgentFilesPanel';
import { useSkillsLibrary } from '../../components/skills/useSkillsLibrary';
import { tidyLayout, countEdgeCrossings, type TidyMode, type TidyAxis } from '../lib/tidyLayout';
import { useSimulateRun, STEP_DURATION_MS } from '../hooks/useSimulateRun';
import { useSimulationGifRecorder } from '../hooks/useSimulationGifRecorder';
import { corpusRegistryEntryLabel, resolveLayerCorpusId } from '../lib/corpus';
import { buildStructuredDocByTag } from '../lib/tagSections';
import { useReviewState } from '../hooks/useReviewState';
import {
  Braces,
  ChevronDown,
  Copy,
  Crop,
  Download,
  FileText,
  Focus,
  GitBranchPlus,
  LayoutGrid,
  Loader2,
  Maximize2,
  Minimize2,
  Spline,
} from 'lucide-react';
import ExportWizardModal from './export/ExportWizardModal';
import type { TranslateFn } from '../../contexts/LanguageContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { AGENTNODES_EXPORT_NO_ROOT } from '../lib/agentnodesExportCodes';
import { getTagColor } from '../../components/StepReferenceSelector';
import {
  AGENT_NODES_GRAPH_FILTER_UNTAGGED,
  isAgentNodesGraphFilterActive,
  matchesAgentNodeGraphFilter,
  type AgentNodesGraphFilter,
} from '../lib/graphFilter';
import {
  clearAgentnodesDebugAgent,
  setAgentnodesDebugAgent,
  stringifyAgentnodesDebugAgentForDisplay,
} from '../lib/agentnodesDebugAgentContext';
import {
  buildVoiceAgentnodesSnapshot,
  clearVoiceAgentnodesContext,
  setVoiceAgentnodesContext,
} from '../lib/voiceAgentnodesContext';
import type { AgentNodeData } from '../lib/types';
import { addEdge, MarkerType, type Edge, type Node as FlowNode } from 'reactflow';
import '../../canvas-272/style.css';
import '../style.css';

const SHOW_AGENTNODES_TOOLBAR_DEBUG_JSON =
  process.env.NODE_ENV === 'development' ||
  process.env.NEXT_PUBLIC_AGENTNODES_NAV_DEBUG_AGENT_JSON === '1';

function formatRelativeAutosaveTime(ts: number, t: TranslateFn): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 5) return t('agentnodesPage.toolbar.relativeJustNow');
  if (seconds < 60) return t('agentnodesPage.toolbar.relativeSecondsAgo', { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('agentnodesPage.toolbar.relativeMinutesAgo', { minutes });
  const hours = Math.floor(minutes / 60);
  return t('agentnodesPage.toolbar.relativeHoursAgo', { hours });
}

function getFullscreenElement(): Element | null {
  const doc = document as Document & { webkitFullscreenElement?: Element | null };
  return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

async function exitFullscreenDoc(): Promise<void> {
  const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> };
  if (document.exitFullscreen) {
    await document.exitFullscreen();
  } else if (doc.webkitExitFullscreen) {
    await doc.webkitExitFullscreen();
  }
}

async function enterFullscreenEl(el: HTMLElement): Promise<void> {
  const extended = el as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
  if (el.requestFullscreen) {
    await el.requestFullscreen();
  } else if (extended.webkitRequestFullscreen) {
    await extended.webkitRequestFullscreen();
  } else {
    throw new Error('fullscreen-unavailable');
  }
}

function extractUserStepCreatedAt(id: string): number {
  const m = /^user-step-(\d+)-/.exec(id);
  if (m && /^\d+$/.test(m[1]!)) return Number(m[1]);
  return 0;
}

function pickVoiceConnectEndpoints(
  graphNodes: FlowNode<AgentNodeData>[],
): { sourceId: string; targetId: string } | null {
  const steps = graphNodes.filter(
    (n): n is FlowNode<AgentNodeData> =>
      n.type === 'c272Step' && n.data.kind === 'step',
  );
  if (steps.length < 2) return null;

  const byCreated = [...steps]
    .map((n) => ({ n, ts: extractUserStepCreatedAt(n.id) }))
    .filter((x) => x.ts > 0)
    .sort((a, b) => b.ts - a.ts);

  if (byCreated.length >= 2) {
    const newer = byCreated[0]!.n;
    const older = byCreated[1]!.n;
    return { sourceId: older.id, targetId: newer.id };
  }

  if (byCreated.length === 1) {
    const newer = byCreated[0]!.n;
    let best: FlowNode<AgentNodeData> | null = null;
    let bestD = Infinity;
    for (const n of steps) {
      if (n.id === newer.id) continue;
      const dx = n.position.x - newer.position.x;
      const dy = n.position.y - newer.position.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    if (!best) return null;
    const a = best.position.x + best.position.y * 0.001;
    const b = newer.position.x + newer.position.y * 0.001;
    return a <= b
      ? { sourceId: best.id, targetId: newer.id }
      : { sourceId: newer.id, targetId: best.id };
  }

  const sorted = [...steps].sort(
    (a, b) => a.position.x - b.position.x || a.position.y - b.position.y,
  );
  const penultimate = sorted[sorted.length - 2]!;
  const last = sorted[sorted.length - 1]!;
  return { sourceId: penultimate.id, targetId: last.id };
}

function buildAgentnodesVoiceEdge(
  source: string,
  target: string,
  flowDirection: 'LR' | 'TB',
  smooth: boolean,
): Edge {
  const id = `user-${source}-${target}-${Date.now()}`;
  const sourceHandle = flowDirection === 'TB' ? 'bottom' : 'right';
  const targetHandle = flowDirection === 'TB' ? 'top' : 'left';
  return {
    id,
    source,
    sourceHandle,
    target,
    targetHandle,
    type: 'anOffset',
    markerEnd: { type: MarkerType.ArrowClosed, color: '#1a2b5b' },
    style: { stroke: '#1a2b5b', strokeWidth: 2 },
    data: { smooth },
  };
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function normalizeVoicePageActionKey(raw: string): { key: string; displayRaw: string } {
  const cleaned = raw.normalize('NFKC').trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
  const key = cleaned.toLowerCase().replace(/\s+/g, '_');
  return { key, displayRaw: cleaned };
}

function pickFirstSplittableStepEdge(
  graphNodes: FlowNode<AgentNodeData>[],
  graphEdges: Edge[],
): Edge | null {
  const stepIds = new Set(
    graphNodes.filter((n) => n.type === 'c272Step' && n.data.kind === 'step').map((n) => n.id),
  );
  for (const e of graphEdges) {
    if (stepIds.has(e.source) && stepIds.has(e.target)) return e;
  }
  return null;
}

const MAX_VOICE_CONNECT_PAIRS = 12;

function parseConnectPairsFromValueJSON(value: string): [number, number][] {
  const v = value.trim();
  if (!v) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch {
    return [];
  }
  const obj = parsed as { pairs?: unknown; edges?: unknown };
  const raw = Array.isArray(obj.pairs) ? obj.pairs : Array.isArray(obj.edges) ? obj.edges : null;
  if (!raw) return [];
  const out: [number, number][] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const a =
      typeof p[0] === 'number'
        ? p[0]
        : typeof p[0] === 'string'
          ? parseInt(String(p[0]).replace(/\D/g, ''), 10)
          : NaN;
    const b =
      typeof p[1] === 'number'
        ? p[1]
        : typeof p[1] === 'string'
          ? parseInt(String(p[1]).replace(/\D/g, ''), 10)
          : NaN;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const from = Math.floor(a);
    const to = Math.floor(b);
    if (from >= 1 && to >= 1 && from !== to) out.push([from, to]);
    if (out.length >= MAX_VOICE_CONNECT_PAIRS) break;
  }
  return out;
}

function parseConnectPairsFromUtterance(text: string): [number, number][] {
  if (!text.trim()) return [];
  const out: [number, number][] = [];
  const seen = new Set<string>();
  const re = /(?:step\s*)?(\d+)\s*(?:to|-|→|->)\s*(?:step\s*)?(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const from = parseInt(m[1], 10);
    const to = parseInt(m[2], 10);
    if (from >= 1 && to >= 1 && from !== to) {
      const k = `${from}-${to}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push([from, to]);
        if (out.length >= MAX_VOICE_CONNECT_PAIRS) break;
      }
    }
  }
  return out;
}

function resolveNodeIdForStepIndex(
  stepNum: number,
  graphNodes: FlowNode<AgentNodeData>[],
): string | null {
  const steps = graphNodes.filter(
    (n): n is FlowNode<AgentNodeData> =>
      n.type === 'c272Step' && n.data.kind === 'step',
  );
  const byLabel = steps.filter((n) => {
    const il = (n.data.indexLabel || '').trim();
    const rm = /^step\s*(\d+)$/i.exec(il);
    return rm && parseInt(rm[1], 10) === stepNum;
  });
  if (byLabel.length === 1) return byLabel[0]!.id;
  if (byLabel.length > 1) {
    byLabel.sort((a, b) => a.id.localeCompare(b.id));
    return byLabel[0]!.id;
  }
  const sorted = [...steps].sort(
    (a, b) => a.position.x - b.position.x || a.position.y - b.position.y,
  );
  const idx = stepNum - 1;
  if (idx >= 0 && idx < sorted.length) return sorted[idx]!.id;
  return null;
}

function applyVoiceConnectPairs(
  pairs: [number, number][],
  graphNodes: FlowNode<AgentNodeData>[],
  currentEdges: Edge[],
  flowDirection: 'LR' | 'TB',
  smooth: boolean,
  t: TranslateFn,
): { nextEdges: Edge[]; added: number; skipped: number; errors: string[] } {
  const errors: string[] = [];
  let es = [...currentEdges];
  let added = 0;
  let skipped = 0;
  const ts = Date.now();
  let idx = 0;
  for (const [fromN, toN] of pairs) {
    const src = resolveNodeIdForStepIndex(fromN, graphNodes);
    const tgt = resolveNodeIdForStepIndex(toN, graphNodes);
    if (!src || !tgt) {
      errors.push(t('agentnodesPage.voice.resolveStepsFailed', { from: fromN, to: toN }));
      continue;
    }
    if (src === tgt) continue;
    if (es.some((e) => e.source === src && e.target === tgt)) {
      skipped++;
      continue;
    }
    const edge = {
      ...buildAgentnodesVoiceEdge(src, tgt, flowDirection, smooth),
      id: `user-${src}-${tgt}-${ts}-${idx++}`,
    };
    es = addEdge(edge, es);
    added++;
  }
  return { nextEdges: es, added, skipped, errors };
}

function applyVoiceDisconnectPairs(
  pairs: [number, number][],
  graphNodes: FlowNode<AgentNodeData>[],
  currentEdges: Edge[],
  t: TranslateFn,
): { nextEdges: Edge[]; removed: number; skipped: number; errors: string[] } {
  const errors: string[] = [];
  let es = [...currentEdges];
  let removed = 0;
  let skipped = 0;
  for (const [fromN, toN] of pairs) {
    const src = resolveNodeIdForStepIndex(fromN, graphNodes);
    const tgt = resolveNodeIdForStepIndex(toN, graphNodes);
    if (!src || !tgt) {
      errors.push(t('agentnodesPage.voice.resolveStepsFailed', { from: fromN, to: toN }));
      continue;
    }
    if (src === tgt) continue;
    const before = es.length;
    es = es.filter(
      (e) =>
        !(
          (e.source === src && e.target === tgt) ||
          (e.source === tgt && e.target === src)
        ),
    );
    const delta = before - es.length;
    if (delta > 0) removed += delta;
    else skipped++;
  }
  return { nextEdges: es, removed, skipped, errors };
}

export default function AgentNodesView({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useLanguage();
  const [toast, setToast] = useState<string | null>(null);
  const { data: session, status } = useSession() as {
    data: { user?: { email?: string } } | null;
    status: string;
  };
  const currentUserEmail = session?.user?.email ?? '';
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const viewMode = searchParams?.get('view') === 'graph' ? 'graph' : 'form';
  const [formPortalElement, setFormPortalElement] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!embedded) {
      setFormPortalElement(null);
      return;
    }

    const el = document.getElementById('form-export-button-portal-target');
    if (el) {
      setFormPortalElement(el);
    }

    const observer = new MutationObserver(() => {
      const found = document.getElementById('form-export-button-portal-target');
      if (found) {
        setFormPortalElement(found);
        observer.disconnect();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    const interval = setInterval(() => {
      const found = document.getElementById('form-export-button-portal-target');
      if (found) {
        setFormPortalElement(found);
        clearInterval(interval);
        observer.disconnect();
      }
    }, 500);

    return () => {
      observer.disconnect();
      clearInterval(interval);
    };
  }, [embedded]);
  const urlAgentId = searchParams?.get('agent') ?? null;
  const recipeUrlId = searchParams?.get('recipe') ?? null;

  const agentEditor = useOptionalAgentEditor();

  const data = useAgentNodesData();
  const {
    projectId: dataProjectId,
    agentList,
    agentListLoading,
    agentListError,
    refreshAgentList,
    loadedAgent: dataLoadedAgent,
    loadingAgent,
    agentError,
    selectAgent,
    clearSelection,
    updateLayer: dataUpdateLayer,
    addLayer: dataAddLayer,
    removeLayer: dataRemoveLayer,
    updateSkillIds: dataUpdateSkillIds,
    updateInputs: dataUpdateInputs,
    saveAgent,
    autoSaveAgent,
    createBlankAgent,
    renameAgent,
    patchAgentListLabel,
  } = data;

  const projectId = embedded ? agentEditor?.projectId ?? null : dataProjectId;
  const loadedAgent = embedded ? agentEditor?.graphAgent ?? null : dataLoadedAgent;
  const updateLayer = embedded && agentEditor ? agentEditor.updateLayer : dataUpdateLayer;
  const addLayer = embedded && agentEditor ? agentEditor.addLayer : dataAddLayer;
  const removeLayer = embedded && agentEditor ? agentEditor.removeLayer : dataRemoveLayer;
  const updateSkillIds = embedded && agentEditor ? agentEditor.updateSkillIds : dataUpdateSkillIds;
  const updateInputs = embedded && agentEditor ? agentEditor.updateInputs : dataUpdateInputs;

  const skillsLib = useSkillsLibrary(Boolean(loadedAgent));
  const attachedSkillIds = loadedAgent?.metadata?.skillIds ?? [];
  const agentSkillTexts = skillsLib.resolveTexts(attachedSkillIds);

  const {
    nodes,
    edges,
    setNodes,
    setEdges,
    addStepNode,
    addNodeForLayer,
    updateNotes,
    patchNodeDataByLayerId,
    resetToInitial,
    graphHydrationWarning,
  } = useAgentGraph({
    projectId,
    agent: loadedAgent,
    defaultStepTitle: t('agentnodesPage.diagram.defaultNewStepTitle'),
    onAddLayer: addLayer,
    onRemoveLayer: removeLayer,
  });

  const {
    runAll: runAllInGraph,
    cancelRun,
    resetRunState,
    clearLayerRunState,
    isRunning: isGraphRunning,
    error: graphRunError,
    progress: runProgress,
    runningLayerIds: runnerRunningIds,
    completedLayerIds: runnerCompletedIds,
    failedLayerIds,
  } = useGraphRunner({
    agent: loadedAgent,
    nodes,
    edges,
    projectId,
    agentSkillTexts,
    inputScopeKey: JSON.stringify([currentUserEmail, embedded ? agentEditor?.runVersioningRef.current?.scope : null]),
    runVersioning: embedded ? agentEditor?.runVersioningRef.current : undefined,
    onLayerResult: updateLayer,
  });

  const {
    simulateAll,
    pauseSimulate,
    resumeSimulate,
    cancelSimulate,
    resetSimulateState,
    isSimulating,
    isPaused: simPaused,
    progress: simProgress,
    runningLayerIds: simRunningIds,
    completedLayerIds: simCompletedIds,
  } = useSimulateRun({ agent: loadedAgent, nodes, edges });

  const [demoRunningIds, setDemoRunningIds] = useState<Set<string>>(new Set());
  const [demoCompletedIds, setDemoCompletedIds] = useState<Set<string>>(new Set());
  const [isDemoSimulating, setIsDemoSimulating] = useState(false);
  const demoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runningLayerIds   = isSimulating ? simRunningIds   : (isDemoSimulating ? demoRunningIds   : runnerRunningIds);
  const completedLayerIds = isSimulating ? simCompletedIds : (isDemoSimulating ? demoCompletedIds : runnerCompletedIds);

  const handleSimulateRecipe = useCallback(
    (recipe: Recipe) => {
      if (loadedAgent) {
        setToast(t('agentnodesPage.toolbar.toastRecipeSimulateBlocked'));
        return;
      }
      if (demoTimerRef.current) clearTimeout(demoTimerRef.current);

      const COL_W  = 260;
      const LANE_H = 160;
      const ORIGIN_X = 60;
      const ORIGIN_Y = 280;

      const newNodes = recipe.steps.map((step, i) => {
        const col  = step.col  ?? i;
        const lane = step.lane ?? 0;
        return {
          id: `recipe-demo-${i}`,
          type: 'c272Step' as const,
          position: { x: ORIGIN_X + col * COL_W, y: ORIGIN_Y + lane * LANE_H },
          data: {
            kind: 'step' as const,
            layerId: `recipe-demo-${i}`,
            title: step.label,
            indexLabel: t('agentnodesPage.diagram.recipeDemoIndexLabel', { step: i + 1 }),
            hasOutput: false,
            isEdited: false,
          },
          draggable: false,
          selectable: false,
          connectable: false,
        };
      });

      const newEdges = recipe.edges
        ? recipe.edges.map((e, idx) => ({
            id: `recipe-edge-${idx}`,
            source: `recipe-demo-${e.from}`,
            target: `recipe-demo-${e.to}`,
          }))
        : recipe.steps.slice(0, -1).map((_, i) => ({
            id: `recipe-edge-${i}`,
            source: `recipe-demo-${i}`,
            target: `recipe-demo-${i + 1}`,
          }));

      setNodes(newNodes);
      setEdges(newEdges);
      setDemoRunningIds(new Set());
      setDemoCompletedIds(new Set());
      setIsDemoSimulating(true);

      setTimeout(() => diagramRef.current?.fit(), 120);

      const ids = recipe.steps.map((_, i) => `recipe-demo-${i}`);
      let stepIdx = 0;

      const advance = () => {
        if (stepIdx >= ids.length) {
          setDemoRunningIds(new Set());
          setDemoCompletedIds(new Set(ids));
          setIsDemoSimulating(false);
          return;
        }
        setDemoRunningIds(new Set([ids[stepIdx]]));
        setDemoCompletedIds(new Set(ids.slice(0, stepIdx)));
        stepIdx++;
        demoTimerRef.current = setTimeout(advance, 800);
      };

      demoTimerRef.current = setTimeout(advance, 300);
    },
    [setNodes, setEdges, loadedAgent, t, setToast],
  );

  useEffect(() => {
    if (status === 'loading') return;
    if (!recipeUrlId || urlAgentId) return;
    const recipe = RECIPES.find((r) => r.id === recipeUrlId);
    if (recipe) handleSimulateRecipe(recipe);
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.delete('recipe');
    const qs = params.toString();
    router.replace(qs ? `/agentnodes?${qs}` : '/agentnodes');
  }, [status, recipeUrlId, urlAgentId, searchParams, router, handleSimulateRecipe]);

  const [sidebarHidden, setSidebarHidden] = useState<boolean>(false);
  const [isCreatingAgent, setIsCreatingAgent] = useState<boolean>(false);
  const [layoutLint, setLayoutLint] = useState<number | null>(null);
  const [layoutMenuOpen, setLayoutMenuOpen] = useState<boolean>(false);
  const [layoutSubMenu, setLayoutSubMenu] = useState<'compact' | 'relax' | null>(null);
  const [forcedDirection, setForcedDirection] = useState<'LR' | 'TB' | null>(null);
  const forcedDirectionRef = useRef<'LR' | 'TB' | null>(null);
  const lastTidyLayoutDirectionRef = useRef<'LR' | 'TB'>('LR');
  const effectiveDirection = useMemo<'LR' | 'TB'>(() => {
    if (forcedDirection) return forcedDirection;
    for (const n of nodes) {
      if (n.type !== 'c272Step' && n.type !== 'c272Section') continue;
      const d = (n.data as { direction?: 'LR' | 'TB' }).direction;
      if (d === 'TB' || d === 'LR') return d;
    }
    return 'LR';
  }, [forcedDirection, nodes]);

  const layoutMenuRef = useRef<HTMLDivElement | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState<boolean>(false);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const [runMenuOpen, setRunMenuOpen] = useState<boolean>(false);
  const runMenuRef = useRef<HTMLDivElement | null>(null);
  const [edgeMode, setEdgeMode] = useState<'rigid' | 'smooth'>('smooth');

  useEffect(() => {
    const handleVoicePageAction = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          pageAction?: string;
          value?: string;
          utteranceHeard?: string;
        }>
      ).detail;
      const { key, displayRaw } = normalizeVoicePageActionKey(detail?.pageAction ?? '');
      const utteranceHeard = (detail?.utteranceHeard ?? '').trim();
      const actionValue = typeof detail?.value === 'string' ? detail.value.trim() : '';

      const fail = (message: string) => {
        window.dispatchEvent(
          new CustomEvent('alma:page-action-result', { detail: { ok: false, message } }),
        );
      };
      const succeed = (message: string) => {
        window.dispatchEvent(
          new CustomEvent('alma:page-action-result', { detail: { ok: true, message } }),
        );
      };

      if (!key) {
        fail(t('agentnodesPage.voice.noPageAction'));
        return;
      }

      if (key === 'add_step' || key === 'add_node' || key === 'add_a_node') {
        if (!loadedAgent) {
          fail(t('agentnodesPage.voice.openAgentFirstAddNode'));
          return;
        }
        addStepNode(t('agentnodesPage.diagram.defaultNewStepTitle'), { ...BLANK_AGENT_STARTER_POSITION });
        succeed(t('agentnodesPage.voice.addStepSuccess'));
        return;
      }

      if (
        key === 'connect_nodes' ||
        key === 'connect_edges' ||
        key === 'connect_two_nodes' ||
        key === 'connect_last_two' ||
        key === 'link_nodes'
      ) {
        if (!loadedAgent) {
          fail(t('agentnodesPage.voice.openAgentFirst'));
          return;
        }
        let pairs = parseConnectPairsFromValueJSON(actionValue);
        if (pairs.length === 0) pairs = parseConnectPairsFromUtterance(utteranceHeard);
        if (pairs.length > 0) {
          const { nextEdges, added, skipped, errors } = applyVoiceConnectPairs(
            pairs,
            nodes,
            edges,
            effectiveDirection,
            edgeMode === 'smooth',
            t,
          );
          if (added === 0 && skipped === 0 && errors.length > 0) {
            fail(errors.join(' '));
            return;
          }
          setEdges(nextEdges);
          const parts: string[] = [];
          if (added > 0) parts.push(t('agentnodesPage.voice.connectAddedLinks', { count: added }));
          if (skipped > 0) parts.push(t('agentnodesPage.voice.connectSkippedPresent', { count: skipped }));
          if (errors.length > 0) parts.push(errors.join(' '));
          succeed(parts.join(' ').trim() || t('agentnodesPage.voice.connectNoChanges'));
          return;
        }
        const pair = pickVoiceConnectEndpoints(nodes);
        if (!pair) {
          fail(t('agentnodesPage.voice.connectNeedTwoSteps'));
          return;
        }
        const { sourceId, targetId } = pair;
        if (sourceId === targetId) {
          fail(t('agentnodesPage.voice.connectSelf'));
          return;
        }
        const already = edges.some((e) => e.source === sourceId && e.target === targetId);
        if (already) {
          succeed(t('agentnodesPage.voice.connectAlreadyLinked'));
          return;
        }
        setEdges((es) =>
          addEdge(
            buildAgentnodesVoiceEdge(
              sourceId,
              targetId,
              effectiveDirection,
              edgeMode === 'smooth',
            ),
            es,
          ),
        );
        succeed(t('agentnodesPage.voice.connectTwoSuccess'));
        return;
      }

      if (
        key === 'remove_connection' ||
        key === 'disconnect_nodes' ||
        key === 'remove_edge' ||
        key === 'disconnect_edges' ||
        key === 'delete_connection' ||
        key === 'unlink_nodes'
      ) {
        if (!loadedAgent) {
          fail(t('agentnodesPage.voice.openAgentFirst'));
          return;
        }
        let pairs = parseConnectPairsFromValueJSON(actionValue);
        if (pairs.length === 0) pairs = parseConnectPairsFromUtterance(utteranceHeard);
        if (pairs.length > 0) {
          const { nextEdges, removed, skipped, errors } = applyVoiceDisconnectPairs(
            pairs,
            nodes,
            edges,
            t,
          );
          if (removed === 0 && skipped > 0 && errors.length === 0) {
            succeed(
              skipped === 1
                ? t('agentnodesPage.voice.disconnectNoMatchSingle')
                : t('agentnodesPage.voice.disconnectNoMatchMany'),
            );
            return;
          }
          if (removed === 0 && errors.length > 0) {
            fail(errors.join(' '));
            return;
          }
          setEdges(nextEdges);
          const parts: string[] = [];
          if (removed > 0) parts.push(t('agentnodesPage.voice.disconnectRemovedLinks', { count: removed }));
          if (skipped > 0) parts.push(t('agentnodesPage.voice.disconnectSkippedPairs', { count: skipped }));
          if (errors.length > 0) parts.push(errors.join(' '));
          succeed(parts.join(' ').trim() || t('agentnodesPage.voice.disconnectNoChanges'));
          return;
        }
        const pair = pickVoiceConnectEndpoints(nodes);
        if (!pair) {
          fail(t('agentnodesPage.voice.disconnectNeedTwoSteps'));
          return;
        }
        const { sourceId, targetId } = pair;
        const nextEdges = edges.filter(
          (e) =>
            !(
              (e.source === sourceId && e.target === targetId) ||
              (e.source === targetId && e.target === sourceId)
            ),
        );
        if (nextEdges.length === edges.length) {
          fail(t('agentnodesPage.voice.disconnectNoRecentEdge'));
          return;
        }
        setEdges(nextEdges);
        succeed(t('agentnodesPage.voice.disconnectTwoSuccess'));
        return;
      }

      if (key === 'insert_step_between' || key === 'split_edge') {
        if (!loadedAgent) {
          fail(t('agentnodesPage.voice.openAgentFirst'));
          return;
        }
        const edge = pickFirstSplittableStepEdge(nodes, edges);
        if (!edge) {
          fail(t('agentnodesPage.voice.insertNeedConnectedEdge'));
          return;
        }
        const srcNode = nodes.find((n) => n.id === edge.source);
        const tgtNode = nodes.find((n) => n.id === edge.target);
        if (!srcNode || !tgtNode) {
          fail(t('agentnodesPage.voice.insertNodesNotFound'));
          return;
        }
        const midX = (srcNode.position.x + tgtNode.position.x) / 2;
        const midY = (srcNode.position.y + tgtNode.position.y) / 2;
        const newId = addStepNode(t('agentnodesPage.diagram.defaultNewStepTitle'), { x: midX, y: midY });
        const ts = Date.now();
        setEdges((es) => {
          const without = es.filter((ed) => ed.id !== edge.id);
          const e1 = {
            ...buildAgentnodesVoiceEdge(edge.source, newId, effectiveDirection, edgeMode === 'smooth'),
            id: `user-${edge.source}-${newId}-${ts}a`,
          };
          const e2 = {
            ...buildAgentnodesVoiceEdge(newId, edge.target, effectiveDirection, edgeMode === 'smooth'),
            id: `user-${newId}-${edge.target}-${ts}b`,
          };
          return addEdge(e2, addEdge(e1, without));
        });
        succeed(t('agentnodesPage.voice.insertSuccess'));
        return;
      }

      if (key === 'clear_editor') {
        if (!loadedAgent) {
          fail(t('agentnodesPage.voice.openAgentFirst'));
          return;
        }
        const did = resetToInitial();
        if (did) {
          succeed(t('agentnodesPage.voice.clearGraphOk'));
        } else {
          fail(t('agentnodesPage.voice.clearGraphFail'));
        }
        return;
      }

      fail(
        t('agentnodesPage.voice.unsupported', {
          action: displayRaw.trim() ? displayRaw : t('agentnodesPage.voice.emptyActionLabel'),
        }),
      );
    };

    window.addEventListener('alma:page-action', handleVoicePageAction as EventListener);
    return () => {
      window.removeEventListener('alma:page-action', handleVoicePageAction as EventListener);
    };
  }, [
    loadedAgent,
    addStepNode,
    resetToInitial,
    nodes,
    edges,
    setEdges,
    effectiveDirection,
    edgeMode,
    t,
  ]);

  useEffect(() => {
    const onVoiceApiDone = () => {
      void refreshAgentList();
    };
    window.addEventListener('alma:agentnodes-voice-api-done', onVoiceApiDone);
    return () => window.removeEventListener('alma:agentnodes-voice-api-done', onVoiceApiDone);
  }, [refreshAgentList]);

  const [showCorpora, setShowCorpora] = useState<boolean>(true);
  const [corpusDisplayNameById, setCorpusDisplayNameById] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [corporaFetchState, setCorporaFetchState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [projectCorpusLinks, setProjectCorpusLinks] = useState<ProjectCorpusLink[]>([]);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [isAutosaving, setIsAutosaving] = useState<boolean>(false);
  const [isSavingNewVersion, setIsSavingNewVersion] = useState<boolean>(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [stepEditorLayerId, setStepEditorLayerId] = useState<string | null>(null);
  const [tutorialOpen, setTutorialOpen] = useState<boolean>(false);
  const closeTutorial = useCallback(() => setTutorialOpen(false), []);
  const handleTutorialBeforeStep = useCallback((step: TutorialStep) => {
    if (step.target === 'agent-sidebar') setSidebarHidden(false);
  }, []);
  const [showSimulateModal, setShowSimulateModal] = useState(false);
  const [showRunAllConfirmModal, setShowRunAllConfirmModal] = useState(false);
  const [exportWizardOpen, setExportWizardOpen] = useState(false);
  const [agentJsonDebugOpen, setAgentJsonDebugOpen] = useState(false);
  const [agentJsonDebugText, setAgentJsonDebugText] = useState('');
  const [agentJsonCopied, setAgentJsonCopied] = useState(false);
  const agentJsonCopyTimerRef = useRef<number | null>(null);
  const diagramRef = useRef<AgentNodesDiagramHandle | null>(null);
  const agentNodesRootRef = useRef<HTMLDivElement | null>(null);
  const [isStageFullscreen, setIsStageFullscreen] = useState(false);
  const [nodeFilterSearch, setNodeFilterSearch] = useState('');
  const [debouncedNodeFilterSearch, setDebouncedNodeFilterSearch] = useState('');
  const [nodeFilterSelectedTags, setNodeFilterSelectedTags] = useState<string[]>([]);
  const [filterTagMenuOpen, setFilterTagMenuOpen] = useState(false);
  const filterTagsMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const sync = () => {
      const root = agentNodesRootRef.current;
      const fs = getFullscreenElement();
      setIsStageFullscreen(Boolean(root && fs === root));
      requestAnimationFrame(() => diagramRef.current?.fit());
    };
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, []);

  useEffect(() => {
    return () => {
      clearVoiceAgentnodesContext();
      clearAgentnodesDebugAgent();
    };
  }, []);

  useEffect(() => {
    setAgentnodesDebugAgent(loadedAgent);
  }, [loadedAgent]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      setVoiceAgentnodesContext(
        buildVoiceAgentnodesSnapshot({
          urlAgentId,
          projectId,
          loadedAgent,
          nodes,
          edges,
          isGraphRunning,
          runProgress,
          runnerRunningIds,
          runnerCompletedIds,
          failedLayerIds,
          isSimulating,
          simPaused,
          simProgress,
          simRunningIds,
          simCompletedIds,
          isDemoSimulating,
        }),
      );
    }, 400);
    return () => window.clearTimeout(id);
  }, [
    urlAgentId,
    projectId,
    loadedAgent,
    nodes,
    edges,
    isGraphRunning,
    runProgress,
    runnerRunningIds,
    runnerCompletedIds,
    failedLayerIds,
    isSimulating,
    simPaused,
    simProgress,
    simRunningIds,
    simCompletedIds,
    isDemoSimulating,
  ]);

  const openAgentJsonDebugModal = useCallback(() => {
    setExportMenuOpen(false);
    setLayoutMenuOpen(false);
    setRunMenuOpen(false);
    setFilterTagMenuOpen(false);
    setAgentJsonDebugText(stringifyAgentnodesDebugAgentForDisplay());
    setAgentJsonCopied(false);
    setAgentJsonDebugOpen(true);
  }, []);

  const closeAgentJsonDebugModal = useCallback(() => {
    if (agentJsonCopyTimerRef.current) {
      window.clearTimeout(agentJsonCopyTimerRef.current);
      agentJsonCopyTimerRef.current = null;
    }
    setAgentJsonDebugOpen(false);
    setAgentJsonCopied(false);
  }, []);

  const copyAgentJsonDebug = useCallback(async () => {
    const text = agentJsonDebugText || stringifyAgentnodesDebugAgentForDisplay();
    if (!text.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
      setAgentJsonCopied(true);
      if (agentJsonCopyTimerRef.current) {
        window.clearTimeout(agentJsonCopyTimerRef.current);
      }
      agentJsonCopyTimerRef.current = window.setTimeout(() => {
        setAgentJsonCopied(false);
        agentJsonCopyTimerRef.current = null;
      }, 2000);
    } catch {
      setAgentJsonCopied(false);
    }
  }, [agentJsonDebugText]);

  useEffect(() => {
    if (!agentJsonDebugOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAgentJsonDebugModal();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [agentJsonDebugOpen, closeAgentJsonDebugModal]);

  const toggleStageFullscreen = useCallback(async () => {
    const el = agentNodesRootRef.current;
    if (!el) return;
    try {
      if (getFullscreenElement() === el) {
        await exitFullscreenDoc();
      } else {
        await enterFullscreenEl(el);
      }
    } catch {
      setToast(t('agentnodesPage.toolbar.toastFullscreenUnavailable'));
    }
  }, [t, setToast]);

  const captureFrame = useCallback(
    () => diagramRef.current?.captureFrame() ?? Promise.resolve(null),
    [],
  );

  const gifRecorder = useSimulationGifRecorder({
    isSimulating,
    runningLayerIds: simRunningIds,
    stepDurationMs: STEP_DURATION_MS,
    agentName: loadedAgent?.name ?? 'agent',
    captureFrame,
  });

  const realLayerIds = useMemo(() => {
    const set = new Set<string>();
    for (const l of loadedAgent?.layers ?? []) set.add(l.id);
    return set;
  }, [loadedAgent?.layers]);

  const materialisedLayerIdsRef = useRef<Set<string>>(new Set());
  const orphanUserStepTitleByIdRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    materialisedLayerIdsRef.current = new Set();
  }, [loadedAgent?.id]);
  const orphanUserStepSignature = useMemo(() => {
    const titleById = new Map<string, string>();
    for (const n of nodes) {
      if (n.type !== 'c272Step') continue;
      const lid = n.data.layerId;
      if (lid && lid.startsWith(USER_STEP_LAYER_PREFIX) && !realLayerIds.has(lid)) {
        titleById.set(lid, n.data.title?.trim() || '');
      }
    }
    orphanUserStepTitleByIdRef.current = titleById;
    return Array.from(titleById.keys()).sort().join('|');
  }, [nodes, realLayerIds]);
  useEffect(() => {
    if (!loadedAgent || !orphanUserStepSignature) return;
    for (const lid of orphanUserStepSignature.split('|')) {
      if (materialisedLayerIdsRef.current.has(lid)) continue;
      materialisedLayerIdsRef.current.add(lid);
      const title = orphanUserStepTitleByIdRef.current.get(lid) || '';
      const label = title || t('agentnodesPage.diagram.defaultNewStepTitle');
      // Reconciling an orphan graph node into a layer is not a user action — add
      // it silently (embedded) so it doesn't fabricate an activity-log entry.
      if (embedded && agentEditor) {
        agentEditor.addLayer(lid, label, { silent: true });
      } else {
        addLayer(lid, label);
      }
    }
  }, [loadedAgent, orphanUserStepSignature, addLayer, t, embedded, agentEditor]);

  // Forward materializer (embedded only): create a graph node for any active
  // layer added after load (e.g. from the form view), so a step created in the
  // form becomes positionable/connectable/runnable in the graph instead of
  // being invisible. addNodeForLayer is idempotent; the guard ref avoids
  // redundant setState. Symmetric to the orphan-node -> addLayer effect above.
  const nodeMaterialisedLayerIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    nodeMaterialisedLayerIdsRef.current = new Set();
  }, [loadedAgent?.id]);
  const activeLayerSignature = useMemo(() => {
    if (!loadedAgent) return '';
    return loadedAgent.layers
      .filter((l) => l.isActive !== false)
      .map((l) => `${l.id}:${(l.name ?? '').trim()}`)
      .join('|');
  }, [loadedAgent]);
  useEffect(() => {
    if (!embedded || !loadedAgent) return;
    const layerIdsWithNode = new Set<string>();
    for (const n of nodes) {
      if (n.data.layerId) layerIdsWithNode.add(n.data.layerId);
    }
    for (const layer of loadedAgent.layers) {
      if (layer.isActive === false) continue;
      if (layerIdsWithNode.has(layer.id)) continue;
      if (nodeMaterialisedLayerIdsRef.current.has(layer.id)) continue;
      nodeMaterialisedLayerIdsRef.current.add(layer.id);
      addNodeForLayer(layer.id, layer.name ?? '');
    }
  }, [embedded, loadedAgent, activeLayerSignature, nodes, addNodeForLayer]);

  const currentDoc = useMemo(() => {
    if (!loadedAgent) return null;
    return buildStructuredDocByTag(loadedAgent, {});
  }, [loadedAgent]);

  const {
    latestRun,
    isStale,
    isRunning: isReviewing,
    runError: reviewError,
    runReview,
    acknowledgeComment,
    clearRun: clearReview,
  } = useReviewState({
    projectId,
    agentId: loadedAgent?.id ?? null,
    currentDoc,
  });

  useEffect(() => {
    if (!loadedAgent) setShowRunAllConfirmModal(false);
  }, [loadedAgent]);

  useEffect(() => {
    setNodeFilterSearch('');
    setDebouncedNodeFilterSearch('');
    setNodeFilterSelectedTags([]);
    setFilterTagMenuOpen(false);
  }, [loadedAgent?.id]);

  const prevAgentIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (loadedAgent?.id !== prevAgentIdRef.current) {
      clearReview();
      prevAgentIdRef.current = loadedAgent?.id ?? null;
    }
  }, [loadedAgent?.id, clearReview]);

  const hasAnyCorpus = useMemo(() => {
    for (const l of loadedAgent?.layers ?? []) {
      if (resolveLayerCorpusId(l)) return true;
    }
    return false;
  }, [loadedAgent?.layers]);

  useEffect(() => {
    if (!toast) return undefined;
    const id = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    if (!layoutMenuOpen) return undefined;
    function onPointerDown(e: PointerEvent) {
      if (layoutMenuRef.current && !layoutMenuRef.current.contains(e.target as Node)) {
        setLayoutMenuOpen(false);
        setLayoutSubMenu(null);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [layoutMenuOpen]);

  useEffect(() => {
    if (!exportMenuOpen) return undefined;
    function onPointerDown(e: PointerEvent) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [exportMenuOpen]);

  useEffect(() => {
    if (!runMenuOpen) return undefined;
    function onPointerDown(e: PointerEvent) {
      if (runMenuRef.current && !runMenuRef.current.contains(e.target as Node)) {
        setRunMenuOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [runMenuOpen]);

  useEffect(() => {
    if (!filterTagMenuOpen) return undefined;
    function onPointerDown(e: PointerEvent) {
      if (filterTagsMenuRef.current && !filterTagsMenuRef.current.contains(e.target as Node)) {
        setFilterTagMenuOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [filterTagMenuOpen]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebouncedNodeFilterSearch(nodeFilterSearch.trim());
    }, 275);
    return () => window.clearTimeout(t);
  }, [nodeFilterSearch]);

  const autoSaveRef = useRef(autoSaveAgent);
  const lastAutosaveTimeRef = useRef<number>(0);
  const isAutosavingRef = useRef<boolean>(false);
  useEffect(() => { autoSaveRef.current = autoSaveAgent; }, [autoSaveAgent]);
  useEffect(() => { forcedDirectionRef.current = forcedDirection; }, [forcedDirection]);

  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (!lastSavedAt) return undefined;
    const id = window.setInterval(() => setNowTick((t) => t + 1), 10000);
    return () => window.clearInterval(id);
  }, [lastSavedAt]);

  useEffect(() => {
    if (embedded) return undefined;
    const id = window.setInterval(async () => {
      if (!loadedAgent) return;
      if (isAutosavingRef.current) return;
      if (Date.now() - lastAutosaveTimeRef.current < 10000) return;
      isAutosavingRef.current = true;
      setIsAutosaving(true);
      try {
        const res = await autoSaveRef.current();
        if (res.ok) {
          lastAutosaveTimeRef.current = Date.now();
          setLastSavedAt(Date.now());
        }
      } finally {
        isAutosavingRef.current = false;
        setIsAutosaving(false);
      }
    }, 10000);
    return () => window.clearInterval(id);
  }, [loadedAgent, embedded]);

  const showCorporaPrevRef = useRef<boolean>(false);
  useEffect(() => {
    if (showCorpora && !showCorporaPrevRef.current) {
      const id = window.setTimeout(() => diagramRef.current?.fit(), 150);
      showCorporaPrevRef.current = showCorpora;
      return () => window.clearTimeout(id);
    }
    showCorporaPrevRef.current = showCorpora;
    return undefined;
  }, [showCorpora]);

  useEffect(() => {
    if (!showCorpora && !hasAnyCorpus) return undefined;
    if (corporaFetchState !== 'idle') return undefined;
    let cancelled = false;
    setCorporaFetchState('loading');
    (async () => {
      try {
        const res = await fetch('/api/rag/corpora', { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          corpora?: Array<{
            id?: string;
            corpusId?: string;
            displayName?: string;
            name?: string;
            source?: { folderName?: string };
            files?: Array<{ name?: string; status?: string }>;
          }>;
        };
        if (cancelled) return;
        const next = new Map<string, string>();
        for (const c of data.corpora ?? []) {
          const name = corpusRegistryEntryLabel(c);
          if (!name) continue;
          if (c.id) next.set(String(c.id).trim(), name);
          const cc = typeof c.corpusId === 'string' ? c.corpusId.trim() : '';
          if (cc && cc !== String(c.id ?? '').trim()) next.set(cc, name);
        }
        setCorpusDisplayNameById(next);
        setCorporaFetchState('loaded');
      } catch {
        if (cancelled) return;
        setCorporaFetchState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showCorpora, hasAnyCorpus, corporaFetchState]);

  // Load the project's corpus links via SCAN so opening a project backfills the shared
  // project file from *this* user's registry (an owner opening their project fills in the
  // names + store paths only they can resolve). Feeds gold-border highlighting, cross-user
  // names in the picker, and real names in the diagram.
  const reloadProjectCorpusLinks = useCallback(() => {
    if (!projectId) return;
    v1ScanProjectCorpusLinks(projectId)
      .then((links) => {
        setProjectCorpusLinks(links);
        setCorpusDisplayNameById((prev) => {
          const next = new Map(prev);
          for (const l of links) {
            const name = (l.displayName || '').trim();
            if (name && name !== l.corpusId && !next.has(l.corpusId)) next.set(l.corpusId, name);
          }
          return next;
        });
      })
      .catch((error) => { console.warn('[AgentNodes] Failed to load project corpus links:', error); });
  }, [projectId]);

  useEffect(() => { reloadProjectCorpusLinks(); }, [reloadProjectCorpusLinks]);

  const handleAttachCorpusToProject = useCallback(
    (link: { corpusId: string; storeName?: string; displayName: string }) => {
      if (!projectId) return;
      v1AddProjectCorpusLink(projectId, { ...link, ownerEmail: currentUserEmail })
        .then(setProjectCorpusLinks)
        .catch((error) => { console.warn('[AgentNodes] Failed to add project corpus link:', error); });
    },
    [projectId, currentUserEmail],
  );

  const handleSelectAgent = useCallback(
    (id: string) => {
      router.push(`/agentnodes?agent=${encodeURIComponent(id)}`);
      setSidebarHidden(true);
    },
    [router],
  );

  const handleBackToList = useCallback(() => {
    router.push('/agentnodes');
  }, [router]);

  useEffect(() => {
    if (embedded) return;
    if (status === 'loading') return;
    if (!urlAgentId) {
      if (loadedAgent) clearSelection();
      setSidebarHidden(false);
      return;
    }
    if (!projectId) return;
    if (loadedAgent?.id !== urlAgentId) {
      selectAgent(urlAgentId);
    }
    setSidebarHidden(true);
  }, [urlAgentId, projectId, status, embedded]);

  const nodesRef = useRef(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  const realLayerIdsRef = useRef(realLayerIds);
  useEffect(() => {
    realLayerIdsRef.current = realLayerIds;
  }, [realLayerIds]);

  const openNode = useCallback((incomingId: string) => {
    const node = nodesRef.current.find(
      (n) => n.id === incomingId || n.data.layerId === incomingId,
    );
    if (!node) return;
    const layerId = node.data.layerId;
    const hasRealLayer = Boolean(layerId) && realLayerIdsRef.current.has(layerId);
    if (!hasRealLayer) {
      setEditingNodeId(node.id);
      return;
    }
    setStepEditorLayerId(layerId);
  }, []);

  const handleOpenNode = openNode;
  const handleOpenInWorkflow = openNode;

  const handleSetNodeTag = useCallback(
    (nodeId: string, tag: string | null) => {
      const node = nodesRef.current.find((n) => n.id === nodeId);
      if (!node) return;
      const layerId = node.data.layerId;
      const tagValue = tag ?? undefined;
      patchNodeDataByLayerId(layerId, { tag: tagValue });
      if (realLayerIdsRef.current.has(layerId)) {
        updateLayer(layerId, { tag: tagValue });
      }
    },
    [patchNodeDataByLayerId, updateLayer],
  );

  const editingLayer = useMemo(() => {
    if (!stepEditorLayerId) return null;
    return loadedAgent?.layers.find((l) => l.id === stepEditorLayerId) ?? null;
  }, [stepEditorLayerId, loadedAgent?.layers]);

  const incomingLayerIds = useMemo<string[]>(() => {
    if (!stepEditorLayerId) return [];
    const targetNodeIds = new Set<string>(
      nodes.filter((n) => n.data.layerId === stepEditorLayerId).map((n) => n.id),
    );
    if (targetNodeIds.size === 0) return [];
    const layerIds = new Set<string>();
    for (const e of edges) {
      if (!targetNodeIds.has(e.target)) continue;
      const srcNode = nodes.find((n) => n.id === e.source);
      const srcLayer = srcNode?.data.layerId;
      if (srcLayer && srcLayer !== stepEditorLayerId && realLayerIds.has(srcLayer)) {
        layerIds.add(srcLayer);
      }
    }
    return Array.from(layerIds);
  }, [stepEditorLayerId, nodes, edges, realLayerIds]);

  const syncLayersRef = useRef(loadedAgent?.layers ?? []);
  const syncNodesRef = useRef(nodes);
  const syncRealLayerIdsRef = useRef(realLayerIds);
  const syncUpdateLayerRef = useRef(updateLayer);
  const syncSetEdgesRef = useRef(setEdges);
  const syncDirRef = useRef(effectiveDirection);
  const syncSmoothRef = useRef(edgeMode === 'smooth');
  useEffect(() => { syncLayersRef.current = loadedAgent?.layers ?? []; });
  useEffect(() => { syncNodesRef.current = nodes; });
  useEffect(() => { syncRealLayerIdsRef.current = realLayerIds; });
  useEffect(() => { syncUpdateLayerRef.current = updateLayer; });
  useEffect(() => { syncSetEdgesRef.current = setEdges; });
  useEffect(() => { syncDirRef.current = effectiveDirection; });
  useEffect(() => { syncSmoothRef.current = edgeMode === 'smooth'; });

  const nodeLayerByIdMemo = useMemo(() => {
    const m = new Map<string, string | undefined>();
    for (const n of nodes) m.set(n.id, n.data.layerId);
    return m;
  }, [nodes]);

  const edgeDepSignature = useMemo(() => {
    if (!embedded) return '';
    const incomingByLayer = new Map<string, Set<string>>();
    for (const e of edges) {
      const tgt = nodeLayerByIdMemo.get(e.target);
      const src = nodeLayerByIdMemo.get(e.source);
      if (!tgt || !src || tgt === src) continue;
      if (!realLayerIds.has(tgt) || !realLayerIds.has(src)) continue;
      if (!incomingByLayer.has(tgt)) incomingByLayer.set(tgt, new Set());
      incomingByLayer.get(tgt)!.add(src);
    }
    return Array.from(incomingByLayer.entries())
      .map(([t, s]) => `${t}<${Array.from(s).sort().join(',')}`)
      .sort()
      .join('|');
  }, [embedded, edges, nodeLayerByIdMemo, realLayerIds]);

  const layerDepSignature = useMemo(() => {
    if (!embedded || !loadedAgent) return '';
    const layerHasNode = new Set<string>();
    for (const v of nodeLayerByIdMemo.values()) if (v) layerHasNode.add(v);
    return loadedAgent.layers
      .map((l) => {
        const refs = (l.referencedSteps ?? [])
          .filter((r) => realLayerIds.has(r) && layerHasNode.has(r))
          .sort();
        return `${l.id}<${refs.join(',')}`;
      })
      .sort()
      .join('|');
  }, [embedded, loadedAgent, nodeLayerByIdMemo, realLayerIds]);

  const edgeSyncPendingRef = useRef(false);
  const refSyncPendingRef = useRef(false);

  useEffect(() => {
    if (!embedded) return;
    if (refSyncPendingRef.current) {
      refSyncPendingRef.current = false;
      return;
    }
    const layers = syncLayersRef.current;
    const nodesNow = syncNodesRef.current;
    const realIds = syncRealLayerIdsRef.current;
    const doUpdate = syncUpdateLayerRef.current;
    if (layers.length === 0 || nodesNow.length === 0) return;

    const incomingByLayer = new Map<string, Set<string>>();
    if (edgeDepSignature) {
      for (const part of edgeDepSignature.split('|')) {
        const [tgt, rest] = part.split('<');
        incomingByLayer.set(tgt, new Set(rest ? rest.split(',') : []));
      }
    }

    // A ref is "graph-owned" (reconciled from edges) only if its target is a
    // real layer that currently has a node. Refs to non-real or inactive
    // (nodeless) steps cannot be represented as edges, so they must be
    // preserved verbatim — otherwise mounting the graph silently destroys a
    // reference to a deactivated step that the form created.
    const layerHasNode = new Set<string>();
    for (const n of nodesNow) {
      if (n.data.layerId) layerHasNode.add(n.data.layerId);
    }
    const isGraphOwnedRef = (r: string) => realIds.has(r) && layerHasNode.has(r);

    let updated = false;
    for (const layer of layers) {
      const desiredReal = incomingByLayer.get(layer.id) ?? new Set<string>();
      const prevRefs = layer.referencedSteps ?? [];
      const prevGraphOwned = new Set(prevRefs.filter(isGraphOwnedRef));
      if (sameSet(prevGraphOwned, desiredReal)) continue;
      const preserved = prevRefs.filter((r) => !isGraphOwnedRef(r));
      doUpdate(layer.id, {
        referencedSteps: [...preserved, ...desiredReal],
      });
      updated = true;
    }
    if (updated) {
      edgeSyncPendingRef.current = true;
    }
  }, [embedded, edgeDepSignature]);

  useEffect(() => {
    if (!embedded) return;
    if (edgeSyncPendingRef.current) {
      edgeSyncPendingRef.current = false;
      return;
    }
    const layers = syncLayersRef.current;
    const nodesNow = syncNodesRef.current;
    const setEdgesNow = syncSetEdgesRef.current;
    if (layers.length === 0 || nodesNow.length === 0) return;

    const nodeIdForLayer = new Map<string, string>();
    for (const n of nodesNow) {
      if (n.data.layerId && !nodeIdForLayer.has(n.data.layerId)) {
        nodeIdForLayer.set(n.data.layerId, n.id);
      }
    }

    const desiredPairs = new Set<string>();
    for (const layer of layers) {
      const targetNodeId = nodeIdForLayer.get(layer.id);
      if (!targetNodeId) continue;
      for (const refId of layer.referencedSteps ?? []) {
        const sourceNodeId = nodeIdForLayer.get(refId);
        if (!sourceNodeId || sourceNodeId === targetNodeId) continue;
        desiredPairs.add(`${sourceNodeId}|${targetNodeId}`);
      }
    }

    setEdgesNow((prev) => {
      const knownNodeIds = new Set(nodesNow.map((n) => n.id));
      const existingPairs = new Set<string>();
      for (const e of prev) {
        if (knownNodeIds.has(e.source) && knownNodeIds.has(e.target)) {
          existingPairs.add(`${e.source}|${e.target}`);
        }
      }
      if (sameSet(existingPairs, desiredPairs)) return prev;

      const kept = prev.filter(
        (e) =>
          !(knownNodeIds.has(e.source) && knownNodeIds.has(e.target)) ||
          desiredPairs.has(`${e.source}|${e.target}`),
      );
      let next = kept;
      for (const pair of desiredPairs) {
        if (existingPairs.has(pair)) continue;
        const [source, target] = pair.split('|');
        next = addEdge(
          buildAgentnodesVoiceEdge(source, target, syncDirRef.current, syncSmoothRef.current),
          next,
        );
      }
      refSyncPendingRef.current = true;
      return next;
    });
  }, [embedded, layerDepSignature]);

  const executeRunAll = useCallback(() => {
    if (!loadedAgent || isGraphRunning || isSimulating) return;
    resetSimulateState();
    resetRunState();
    void runAllInGraph();
  }, [loadedAgent, isGraphRunning, isSimulating, resetRunState, resetSimulateState, runAllInGraph]);

  const requestRunAll = useCallback(() => {
    if (!loadedAgent || isGraphRunning || isSimulating) return;
    if (loadedAgent.layers.length === 0) {
      setToast(t('agentnodesPage.toolbar.toastNoStepsRun'));
      return;
    }
    setShowRunAllConfirmModal(true);
  }, [loadedAgent, isGraphRunning, isSimulating]);

  const confirmRunAll = useCallback(() => {
    setShowRunAllConfirmModal(false);
    executeRunAll();
  }, [executeRunAll]);

  const handleSimulate = useCallback(() => {
    if (!loadedAgent || isGraphRunning || isSimulating) return;
    if (loadedAgent.layers.length === 0) {
      setToast(t('agentnodesPage.toolbar.toastNoStepsSimulate'));
      return;
    }
    setShowSimulateModal(true);
  }, [loadedAgent, isGraphRunning, isSimulating]);

  const handleStartSimulate = useCallback((withRecording: boolean) => {
    setShowSimulateModal(false);
    gifRecorder.setIsRecordingEnabled(withRecording);
    resetRunState();
    simulateAll();
  }, [gifRecorder, resetRunState, simulateAll]);

  const handleNewVersion = useCallback(async () => {
    if (!loadedAgent || isSavingNewVersion) return;
    setIsSavingNewVersion(true);
    try {
      const res = await saveAgent();
      if (res.ok) {
        setLastSavedAt(Date.now());
        lastAutosaveTimeRef.current = Date.now();
        setToast(t('agentnodesPage.toolbar.toastNewVersionSaved'));
      } else {
        setToast(res.error ?? t('agentnodesPage.toolbar.toastNewVersionFailed'));
      }
    } finally {
      setIsSavingNewVersion(false);
    }
  }, [loadedAgent, isSavingNewVersion, saveAgent]);

  const runLayout = useCallback((mode: TidyMode, axis: TidyAxis = 'both', preferFreshAutoDetect = false) => {
    if (!loadedAgent) return;
    let tidiedNodes: Parameters<typeof countEdgeCrossings>[0] = [];
    let didMove = false;
    let layoutDirectionOut: 'LR' | 'TB' = lastTidyLayoutDirectionRef.current;
    const forced = forcedDirectionRef.current ?? undefined;
    flushSync(() => {
      setNodes((prev) => {
        const { nodes: tidied, direction } = tidyLayout(
          prev,
          edges,
          mode,
          axis,
          forced,
          preferFreshAutoDetect,
        );
        layoutDirectionOut = direction;
        didMove = tidied !== prev;
        tidiedNodes = tidied;
        lastTidyLayoutDirectionRef.current = direction;
        return tidied;
      });
    });
    const crossings = countEdgeCrossings(tidiedNodes, edges);
    setLayoutLint(crossings);
    const axisLabel = axis === 'h' ? ' (horizontal)' : axis === 'v' ? ' (vertical)' : '';
    const label = mode === 'compact'
      ? t('agentnodesPage.toolbar.toastLayoutCompacted', { axis: axisLabel })
      : t('agentnodesPage.toolbar.toastLayoutRelaxed', { axis: axisLabel });
    setToast(didMove ? label : t('agentnodesPage.toolbar.toastLayoutAlreadyClean'));
    const srcHandle = layoutDirectionOut === 'TB' ? 'bottom' : 'right';
    const tgtHandle = layoutDirectionOut === 'TB' ? 'top' : 'left';
    setEdges((prevEdges) =>
      prevEdges.map((e) =>
        e.sourceHandle === srcHandle && e.targetHandle === tgtHandle
          ? e
          : { ...e, sourceHandle: srcHandle, targetHandle: tgtHandle },
      ),
    );
    requestAnimationFrame(() => diagramRef.current?.fit());
  }, [loadedAgent, setNodes, setEdges, edges]);

  const closeAndRun = useCallback((mode: TidyMode, axis: TidyAxis) => {
    setLayoutMenuOpen(false);
    setLayoutSubMenu(null);
    setRunMenuOpen(false);
    runLayout(mode, axis);
  }, [runLayout]);

  const handleSetDirection = useCallback((dir: 'LR' | 'TB' | null) => {
    forcedDirectionRef.current = dir;
    setForcedDirection(dir);
    runLayout('compact', 'both', dir === null);
  }, [runLayout]);
  const handleResetToInitial = useCallback(() => {
    setLayoutMenuOpen(false);
    setLayoutSubMenu(null);
    setRunMenuOpen(false);
    setLayoutLint(null);
    const ok = resetToInitial();
    if (!ok) {
      setToast(t('agentnodesPage.toolbar.toastResetLayoutFailed'));
    }
    requestAnimationFrame(() => diagramRef.current?.fit());
  }, [resetToInitial]);

  const handleExportGraph = useCallback(
    async (format: 'png' | 'svg', graphOnly: boolean) => {
      setExportMenuOpen(false);
      setRunMenuOpen(false);
      if (!nodes.length) {
        setToast(t('agentnodesPage.toolbar.toastNothingToExport'));
        return;
      }
      if (!diagramRef.current) {
        setToast(t('agentnodesPage.toolbar.toastGraphNotReady'));
        return;
      }
      const res = await diagramRef.current.exportImage({ format, graphOnly });
      if (res.ok) {
        setToast(
          graphOnly
            ? t('agentnodesPage.toolbar.toastDownloadedGraphOnly', { format: format.toUpperCase() })
            : t('agentnodesPage.toolbar.toastDownloadedFull', { format: format.toUpperCase() }),
        );
      } else {
        setToast(
          res.error === AGENTNODES_EXPORT_NO_ROOT
            ? t('agentnodesPage.toolbar.toastGraphNotReady')
            : t('agentnodesPage.toolbar.toastExportFailed'),
        );
      }
    },
    [nodes.length, t],
  );

  const shouldPortalExport = embedded && viewMode === 'form' && formPortalElement !== null;

  const exportMenuNode = useMemo(() => {
    return (
      <div className="an-layout-menu an-layout-menu--align-end" ref={exportMenuRef}>
        <button
          type="button"
          className={`an-btn-ghost an-layout-menu__trigger an-export-menu__trigger${exportMenuOpen ? ' an-layout-menu__trigger--open' : ''}`}
          onClick={() => {
            setLayoutMenuOpen(false);
            setRunMenuOpen(false);
            setFilterTagMenuOpen(false);
            setExportMenuOpen((v) => !v);
          }}
          aria-haspopup="menu"
          aria-expanded={exportMenuOpen}
          title={t('agentnodesPage.view.exportMenuTitle')}
          disabled={nodes.length === 0 && !loadedAgent}
        >
          <Download className="an-export-menu__trigger-icon" size={15} strokeWidth={2} aria-hidden />
          {t('agentnodesPage.toolbar.export')}
          <ChevronDown
            className={`an-export-menu__trigger-chevron${exportMenuOpen ? ' an-export-menu__trigger-chevron--open' : ''}`}
            size={15}
            strokeWidth={2}
            aria-hidden
          />
        </button>

        {exportMenuOpen && (
          <div className="an-layout-menu__panel an-export-menu__panel" role="menu">
            {loadedAgent && (
              <div className="an-export-menu__section" role="group" aria-label={t('agentnodesPage.toolbar.docSectionTitle')}>
                <div className="an-export-menu__section-title">{t('agentnodesPage.toolbar.docSectionTitle')}</div>
                <button
                  type="button"
                  role="menuitem"
                  className="an-layout-menu__item an-export-menu__item"
                  onClick={() => {
                    setExportMenuOpen(false);
                    setExportWizardOpen(true);
                  }}
                >
                  <span className="an-layout-menu__item-icon an-export-menu__glyph" aria-hidden>
                    <FileText size={17} strokeWidth={1.75} />
                  </span>
                  <span className="an-layout-menu__item-body">
                    <span className="an-layout-menu__item-label">{t('agentnodesPage.toolbar.docExportLabel')}</span>
                    <span className="an-layout-menu__item-desc">{t('agentnodesPage.toolbar.docExportDesc')}</span>
                  </span>
                </button>
              </div>
            )}
            <div className="an-export-menu__section" role="group" aria-label={t('agentnodesPage.view.exportPngGroup')}>
              <div className="an-export-menu__section-title">{t('agentnodesPage.toolbar.pngSection')}</div>
              <button
                type="button"
                role="menuitem"
                className="an-layout-menu__item an-export-menu__item"
                onClick={() => { void handleExportGraph('png', false); }}
                title={t('agentnodesPage.view.exportPngGridTitle')}
              >
                <span className="an-layout-menu__item-icon an-export-menu__glyph" aria-hidden>
                  <LayoutGrid size={17} strokeWidth={1.75} />
                </span>
                <span className="an-layout-menu__item-body">
                  <span className="an-layout-menu__item-label">{t('agentnodesPage.toolbar.fullCanvas')}</span>
                  <span className="an-layout-menu__item-desc">{t('agentnodesPage.toolbar.fullCanvasDesc')}</span>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="an-layout-menu__item an-export-menu__item"
                onClick={() => { void handleExportGraph('png', true); }}
                title={t('agentnodesPage.view.exportPngBareTitle')}
              >
                <span className="an-layout-menu__item-icon an-export-menu__glyph" aria-hidden>
                  <Focus size={17} strokeWidth={1.75} />
                </span>
                <span className="an-layout-menu__item-body">
                  <span className="an-layout-menu__item-label">{t('agentnodesPage.toolbar.graphOnly')}</span>
                  <span className="an-layout-menu__item-desc">{t('agentnodesPage.toolbar.graphOnlyDesc')}</span>
                </span>
              </button>
            </div>
            <div className="an-export-menu__section" role="group" aria-label={t('agentnodesPage.view.exportSvgGroup')}>
              <div className="an-export-menu__section-title">{t('agentnodesPage.toolbar.svgSection')}</div>
              <button
                type="button"
                role="menuitem"
                className="an-layout-menu__item an-export-menu__item"
                onClick={() => { void handleExportGraph('svg', false); }}
                title={t('agentnodesPage.view.exportSvgGridTitle')}
              >
                <span className="an-layout-menu__item-icon an-export-menu__glyph" aria-hidden>
                  <Spline size={17} strokeWidth={1.75} />
                </span>
                <span className="an-layout-menu__item-body">
                  <span className="an-layout-menu__item-label">{t('agentnodesPage.toolbar.fullCanvas')}</span>
                  <span className="an-layout-menu__item-desc">{t('agentnodesPage.toolbar.fullCanvasDesc')}</span>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="an-layout-menu__item an-export-menu__item"
                onClick={() => { void handleExportGraph('svg', true); }}
                title={t('agentnodesPage.view.exportSvgBareTitle')}
              >
                <span className="an-layout-menu__item-icon an-export-menu__glyph" aria-hidden>
                  <Crop size={17} strokeWidth={1.75} />
                </span>
                <span className="an-layout-menu__item-body">
                  <span className="an-layout-menu__item-label">{t('agentnodesPage.toolbar.graphOnly')}</span>
                  <span className="an-layout-menu__item-desc">{t('agentnodesPage.toolbar.graphOnlyDesc')}</span>
                </span>
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }, [
    exportMenuOpen,
    nodes,
    loadedAgent,
    t,
    handleExportGraph,
    setLayoutMenuOpen,
    setRunMenuOpen,
    setFilterTagMenuOpen,
    setExportMenuOpen,
    setExportWizardOpen,
  ]);

  const handleCreateAgent = useCallback(
    async (name: string): Promise<{ ok: boolean; fileId?: string; error?: string }> => {
      setIsCreatingAgent(true);
      try {
        const res = await createBlankAgent(name);
        if (res.ok) {
          await refreshAgentList();
          if (res.fileId) {
            handleSelectAgent(res.fileId);
          }
          setToast(t('agentnodesPage.toolbar.toastAgentCreated', { name }));
        }
        return res;
      } finally {
        setIsCreatingAgent(false);
      }
    },
    [createBlankAgent, refreshAgentList, handleSelectAgent],
  );

  const handleRenameAgent = useCallback(
    async (agentId: string, newName: string): Promise<{ ok: boolean; error?: string }> => {
      const trimmed = newName.trim();
      const res = await renameAgent(agentId, trimmed);
      if (res.ok) {
        await refreshAgentList();
        patchAgentListLabel(agentId, trimmed);
        setToast(t('agentnodesPage.toolbar.toastRenamed', { name: trimmed }));
      }
      return res;
    },
    [renameAgent, refreshAgentList, patchAgentListLabel],
  );

  const editingNode = useMemo(
    () => (editingNodeId ? nodes.find((n) => n.id === editingNodeId) ?? null : null),
    [editingNodeId, nodes],
  );

  const initialNotes = editingNode?.data.notes ?? '';

  const handleModalSave = useCallback(
    (value: string) => {
      if (!editingNodeId) return;
      updateNotes(editingNodeId, value);
      setEditingNodeId(null);
      setToast(t('agentnodesPage.toolbar.toastNotesSaved'));
    },
    [editingNodeId, updateNotes, t],
  );

  const graphFilterForDiagram = useMemo<AgentNodesGraphFilter | null>(() => {
    if (!loadedAgent) return null;
    const f: AgentNodesGraphFilter = {
      nameQuery: debouncedNodeFilterSearch,
      selectedTags: nodeFilterSelectedTags,
    };
    return isAgentNodesGraphFilterActive(f) ? f : null;
  }, [loadedAgent, debouncedNodeFilterSearch, nodeFilterSelectedTags]);

  const filterableNodes = useMemo(
    () => nodes.filter((n) => n.type === 'c272Step' || n.type === 'c272Section'),
    [nodes],
  );

  const distinctGraphTags = useMemo(
    () =>
      Array.from(
        new Set(
          filterableNodes.map((n) => n.data.tag).filter((tag): tag is string => Boolean(tag)),
        ),
      ).sort((a, b) => a.localeCompare(b)),
    [filterableNodes],
  );

  const hasUntaggedGraphNodes = useMemo(
    () => filterableNodes.some((n) => !n.data.tag),
    [filterableNodes],
  );

  const graphFilterStats = useMemo(() => {
    const total = filterableNodes.length;
    if (!graphFilterForDiagram) return { visible: total, total };
    const visible = filterableNodes.filter((n) =>
      matchesAgentNodeGraphFilter(n, graphFilterForDiagram),
    ).length;
    return { visible, total };
  }, [filterableNodes, graphFilterForDiagram]);

  const filterUiActive = useMemo(
    () => nodeFilterSearch.trim().length > 0 || nodeFilterSelectedTags.length > 0,
    [nodeFilterSearch, nodeFilterSelectedTags],
  );

  const filterHidesRunningNode = useMemo(() => {
    if (!graphFilterForDiagram) return false;
    if (!isGraphRunning && !isSimulating) return false;
    const visibleLayerIds = new Set(
      nodes
        .filter((n) => matchesAgentNodeGraphFilter(n, graphFilterForDiagram))
        .map((n) => n.data.layerId)
        .filter(Boolean),
    );
    for (const lid of runningLayerIds) {
      if (!visibleLayerIds.has(lid)) return true;
    }
    return false;
  }, [graphFilterForDiagram, isGraphRunning, isSimulating, nodes, runningLayerIds]);

  useEffect(() => {
    if (!loadedAgent) return undefined;
    const id = requestAnimationFrame(() => diagramRef.current?.fit());
    return () => cancelAnimationFrame(id);
  }, [loadedAgent?.id, debouncedNodeFilterSearch, nodeFilterSelectedTags]);

  const rootClassName = `c272-root${isStageFullscreen ? ' c272-root--stage-fs' : ''}`;

  if (status === 'loading') {
    return (
      <div ref={agentNodesRootRef} className={rootClassName}>
        <div className="c272-empty">{t('agentnodesPage.toolbar.loadingSession')}</div>
      </div>
    );
  }

  return (
    <div ref={agentNodesRootRef} className={rootClassName}>
      {}
      {!embedded && (
        <AgentSidebar
          agents={agentList}
          loading={agentListLoading}
          error={agentListError}
          selectedId={loadedAgent?.id ?? null}
          hidden={sidebarHidden && Boolean(loadedAgent)}
          onSelect={handleSelectAgent}
          onRefresh={refreshAgentList}
          onCreateAgent={handleCreateAgent}
          isCreating={isCreatingAgent}
          onRenameAgent={handleRenameAgent}
          onRequestCollapse={
            loadedAgent && !sidebarHidden ? () => setSidebarHidden(true) : undefined
          }
          onSimulateRecipe={handleSimulateRecipe}
        />
      )}

      {!embedded && sidebarHidden && loadedAgent ? (
        <button
          type="button"
          className="c272-reopen-handle"
          aria-label={t('agentnodesPage.view.reopenAgents')}
          title={t('agentnodesPage.view.reopenAgents')}
          onClick={() => setSidebarHidden(false)}
        >
          ›
        </button>
      ) : null}

      <main className="c272-stage">
        <div className="c272-toolbar an-toolbar">
          <div className="an-toolbar__left">
            {loadedAgent ? (
              <>
                {!embedded && (
                  <>
                    <button
                      type="button"
                      className="an-btn-ghost an-btn-back"
                      onClick={handleBackToList}
                      title={t('agentnodesPage.view.backToAgents')}
                      aria-label={t('agentnodesPage.view.backToAgents')}
                    >
                      <span className="an-btn-back__chevron" aria-hidden>‹</span>
                      <span>{t('agentnodesPage.toolbar.agents')}</span>
                    </button>
                    <span className="an-toolbar__divider" aria-hidden />
                  </>
                )}
                <span className="an-toolbar__title-text" title={loadedAgent.name}>
                  {formatAgentToolbarTitle(loadedAgent.name, loadedAgent.metadata)}
                </span>
                <div className="an-toolbar-version-cluster">
                  {loadedAgent.currentVersion ? (
                    <span
                      className="an-version-pill"
                      title={
                        loadedAgent.versions && loadedAgent.versions.length > 1
                          ? t('agentnodesPage.toolbar.versionsCount', {
                              count: loadedAgent.versions.length,
                            })
                          : t('agentnodesPage.toolbar.currentVersion')
                      }
                    >
                      {loadedAgent.currentVersion}
                    </span>
                  ) : null}
                  {}
                  {!embedded && <button
                    type="button"
                    className="an-toolbar-version-bump"
                    onClick={handleNewVersion}
                    disabled={isSavingNewVersion}
                    title={t('agentnodesPage.view.newVersionTitle')}
                    aria-label={t('agentnodesPage.toolbar.newVersion')}
                  >
                    {isSavingNewVersion ? (
                      <Loader2 className="an-toolbar-version-bump__spin" size={16} strokeWidth={2} aria-hidden />
                    ) : (
                      <GitBranchPlus size={16} strokeWidth={2} aria-hidden />
                    )}
                  </button>}
                </div>
                <span
                  className={`an-autosave-status${isAutosaving ? ' an-autosave-status--saving' : ''}`}
                  title={t('agentnodesPage.view.autoSaveTitle')}
                >
                  {isAutosaving
                    ? t('agentnodesPage.toolbar.saving')
                    : lastSavedAt
                      ? t('agentnodesPage.toolbar.savedPrefix', {
                          time: formatRelativeAutosaveTime(lastSavedAt, t),
                        })
                      : t('agentnodesPage.toolbar.autoSaveOn')}
                </span>
              </>
            ) : (
              <span className="an-toolbar__title-text">
                {t('agentnodesPage.toolbar.pickAgentTitle')}
              </span>
            )}
          </div>

          <div className="an-toolbar__right">
            {loadedAgent ? (
              <>
                <div className="an-toolbar__group an-toolbar-filter">
                  {graphFilterForDiagram ? (
                    <span className="an-toolbar-filter__count" aria-live="polite">
                      {t('agentnodesPage.toolbar.graphFilterCount', {
                        visible: graphFilterStats.visible,
                        total: graphFilterStats.total,
                      })}
                    </span>
                  ) : null}
                  <input
                    type="search"
                    className="an-toolbar-filter__search"
                    value={nodeFilterSearch}
                    onChange={(e) => setNodeFilterSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        setNodeFilterSearch('');
                      }
                    }}
                    placeholder={t('agentnodesPage.toolbar.graphFilterSearchPlaceholder')}
                    aria-label={t('agentnodesPage.toolbar.graphFilterSearchAria')}
                    title={t('agentnodesPage.toolbar.graphFilterSearchTitle')}
                  />
                  {filterHidesRunningNode ? (
                    <span className="an-toolbar-filter__hint" role="status">
                      {t('agentnodesPage.toolbar.graphFilterHiddenRunningHint')}
                    </span>
                  ) : null}
                  {(distinctGraphTags.length > 0 || hasUntaggedGraphNodes) ? (
                    <div className="an-layout-menu an-toolbar-filter__tags" ref={filterTagsMenuRef}>
                      <button
                        type="button"
                        className={`an-btn-ghost an-layout-menu__trigger${filterTagMenuOpen ? ' an-layout-menu__trigger--open' : ''}`}
                        onClick={() => {
                          setLayoutMenuOpen(false);
                          setExportMenuOpen(false);
                          setRunMenuOpen(false);
                          setFilterTagMenuOpen((v) => !v);
                        }}
                        aria-haspopup="menu"
                        aria-expanded={filterTagMenuOpen}
                        title={t('agentnodesPage.toolbar.graphFilterTagsMenuTitle')}
                      >
                        {t('agentnodesPage.toolbar.graphFilterTags')}
                        <span className="an-layout-menu__caret" aria-hidden>▾</span>
                      </button>
                      {filterTagMenuOpen ? (
                        <div
                          className="an-layout-menu__panel"
                          role="menu"
                          aria-label={t('agentnodesPage.toolbar.graphFilterTagsMenuTitle')}
                        >
                          {hasUntaggedGraphNodes ? (
                            <button
                              type="button"
                              role="menuitemcheckbox"
                              aria-checked={nodeFilterSelectedTags.includes(AGENT_NODES_GRAPH_FILTER_UNTAGGED)}
                              className="an-layout-menu__item"
                              onClick={() => {
                                setNodeFilterSelectedTags((prev) =>
                                  prev.includes(AGENT_NODES_GRAPH_FILTER_UNTAGGED)
                                    ? prev.filter((x) => x !== AGENT_NODES_GRAPH_FILTER_UNTAGGED)
                                    : [...prev, AGENT_NODES_GRAPH_FILTER_UNTAGGED].sort((a, b) =>
                                        a.localeCompare(b),
                                      ),
                                );
                              }}
                            >
                              <span className="an-layout-menu__item-body">
                                <span className="an-layout-menu__item-label">
                                  {t('agentnodesPage.toolbar.graphFilterUntagged')}
                                </span>
                              </span>
                            </button>
                          ) : null}
                          {distinctGraphTags.map((tag) => {
                            const col = getTagColor(tag);
                            const on = nodeFilterSelectedTags.includes(tag);
                            return (
                              <button
                                key={tag}
                                type="button"
                                role="menuitemcheckbox"
                                aria-checked={on}
                                className="an-layout-menu__item"
                                onClick={() => {
                                  setNodeFilterSelectedTags((prev) =>
                                    prev.includes(tag)
                                      ? prev.filter((x) => x !== tag)
                                      : [...prev, tag].sort((a, b) => a.localeCompare(b)),
                                  );
                                }}
                              >
                                <span
                                  className="an-layout-menu__item-icon an-toolbar-filter__tag-swatch"
                                  aria-hidden
                                  style={{ background: col?.border ?? '#94a3b8' }}
                                />
                                <span className="an-layout-menu__item-body">
                                  <span className="an-layout-menu__item-label">{tag}</span>
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {filterUiActive ? (
                    <button
                      type="button"
                      className="an-btn-ghost"
                      onClick={() => {
                        setNodeFilterSearch('');
                        setDebouncedNodeFilterSearch('');
                        setNodeFilterSelectedTags([]);
                        setFilterTagMenuOpen(false);
                      }}
                    >
                      {t('agentnodesPage.toolbar.graphFilterClear')}
                    </button>
                  ) : null}
                </div>

                <span className="an-toolbar__divider" aria-hidden />

                {}
                <div className="an-toolbar__group" data-tour="toolbar-tools">
                  {}
                  <div className="an-layout-menu" ref={layoutMenuRef}>
                    <button
                      type="button"
                      className={`an-btn-ghost an-layout-menu__trigger${layoutMenuOpen ? ' an-layout-menu__trigger--open' : ''}`}
                      onClick={() => {
                        setExportMenuOpen(false);
                        setRunMenuOpen(false);
                        setFilterTagMenuOpen(false);
                        setLayoutMenuOpen((v) => !v);
                      }}
                      aria-haspopup="menu"
                      aria-expanded={layoutMenuOpen}
                      title={t('agentnodesPage.view.layoutMenu')}
                    >
                      {t('agentnodesPage.toolbar.layout')}
                      {layoutLint !== null && (
                        <span
                          className={`an-layout-lint an-layout-lint--badge${layoutLint === 0 ? ' an-layout-lint--ok' : ' an-layout-lint--warn'}`}
                          aria-label={
                            layoutLint === 0
                              ? t('agentnodesPage.toolbar.crossingsNone')
                              : t('agentnodesPage.toolbar.crossingsCount', { count: layoutLint })
                          }
                        >
                          {layoutLint === 0 ? '✓' : `⚠\u202f${layoutLint}`}
                        </span>
                      )}
                      <span className="an-layout-menu__caret" aria-hidden>▾</span>
                    </button>

                    {layoutMenuOpen && (
                      <div className="an-layout-menu__panel" role="menu">
                        {}
                        <div className="an-layout-menu__dir-row">
                          <span className="an-layout-menu__dir-label">{t('agentnodesPage.toolbar.direction')}</span>
                          <div
                            className="an-layout-menu__dir-pills"
                            role="group"
                            aria-label={t('agentnodesPage.view.flowDirAria')}
                            dir="ltr"
                          >
                            <button
                              type="button"
                              className={`an-layout-menu__dir-pill${forcedDirection === null ? ' an-layout-menu__dir-pill--active' : ''}`}
                              onClick={() => handleSetDirection(null)}
                              title={t('agentnodesPage.view.flowAutoTitle')}
                            >
                              {t('agentnodesPage.toolbar.auto')}
                            </button>
                            {}
                            <button
                              type="button"
                              className={`an-layout-menu__dir-pill${forcedDirection === 'TB' ? ' an-layout-menu__dir-pill--active' : ''}`}
                              onClick={() => handleSetDirection('TB')}
                              title={t('agentnodesPage.view.flowTBTitle')}
                            >
                              ↕ V
                            </button>
                            {}
                            <button
                              type="button"
                              className={`an-layout-menu__dir-pill${forcedDirection === 'LR' ? ' an-layout-menu__dir-pill--active' : ''}`}
                              onClick={() => handleSetDirection('LR')}
                              title={t('agentnodesPage.view.flowLRTitle')}
                            >
                              ←→ H
                            </button>
                          </div>
                        </div>

                        <div className="an-layout-menu__dir-row">
                          <span className="an-layout-menu__dir-label">{t('agentnodesPage.toolbar.edgeStyle')}</span>
                          <div
                            className="an-layout-menu__dir-pills"
                            role="group"
                            aria-label={t('agentnodesPage.view.edgeStyleAria')}
                            dir="ltr"
                          >
                            <button
                              type="button"
                              className={`an-layout-menu__dir-pill${edgeMode === 'rigid' ? ' an-layout-menu__dir-pill--active' : ''}`}
                              onClick={() => setEdgeMode('rigid')}
                              title={t('agentnodesPage.view.edgeRigidTitle')}
                            >
                              {t('agentnodesPage.toolbar.rigid')}
                            </button>
                            <button
                              type="button"
                              className={`an-layout-menu__dir-pill${edgeMode === 'smooth' ? ' an-layout-menu__dir-pill--active' : ''}`}
                              onClick={() => setEdgeMode('smooth')}
                              title={t('agentnodesPage.view.edgeSmoothTitle')}
                            >
                              {t('agentnodesPage.toolbar.smooth')}
                            </button>
                          </div>
                        </div>

                        <div className="an-layout-menu__sep" aria-hidden />

                        {}
                        <button
                          type="button"
                          role="menuitem"
                          aria-expanded={layoutSubMenu === 'compact'}
                          className={`an-layout-menu__item an-layout-menu__item--parent${layoutSubMenu === 'compact' ? ' an-layout-menu__item--expanded' : ''}`}
                          onClick={() => setLayoutSubMenu((m) => (m === 'compact' ? null : 'compact'))}
                          title={t('agentnodesPage.view.compactTitle')}
                        >
                          <span className="an-layout-menu__item-icon" aria-hidden>⬡</span>
                          <span className="an-layout-menu__item-body">
                            <span className="an-layout-menu__item-label">{t('agentnodesPage.toolbar.compact')}</span>
                            <span className="an-layout-menu__item-desc">{t('agentnodesPage.toolbar.compactDesc')}</span>
                          </span>
                          <span className="an-layout-menu__item-expand" aria-hidden>
                            {layoutSubMenu === 'compact' ? '▾' : '▸'}
                          </span>
                        </button>
                        {layoutSubMenu === 'compact' && (
                          <div className="an-layout-menu__sub" role="group" aria-label={t('agentnodesPage.view.compactGroupAria')}>
                            {}
                            <button type="button" className="an-layout-menu__sub-item" onClick={() => closeAndRun('compact', effectiveDirection === 'TB' ? 'v' : 'h')}>
                              <span className="an-layout-menu__sub-icon" aria-hidden>{effectiveDirection === 'TB' ? '↕' : '←→'}</span>
                              <span className="an-layout-menu__sub-label">{t('agentnodesPage.toolbar.alongFlow')}</span>
                              <span className="an-layout-menu__sub-desc">{effectiveDirection === 'TB' ? t('agentnodesPage.toolbar.rowSpacing') : t('agentnodesPage.toolbar.colSpacing')}</span>
                            </button>
                            {}
                            <button type="button" className="an-layout-menu__sub-item" onClick={() => closeAndRun('compact', effectiveDirection === 'TB' ? 'h' : 'v')}>
                              <span className="an-layout-menu__sub-icon" aria-hidden>{effectiveDirection === 'TB' ? '←→' : '↕'}</span>
                              <span className="an-layout-menu__sub-label">{t('agentnodesPage.toolbar.acrossFlow')}</span>
                              <span className="an-layout-menu__sub-desc">{effectiveDirection === 'TB' ? t('agentnodesPage.toolbar.colSpacing') : t('agentnodesPage.toolbar.rowSpacing')}</span>
                            </button>
                            <button type="button" className="an-layout-menu__sub-item" onClick={() => closeAndRun('compact', 'both')}>
                              <span className="an-layout-menu__sub-icon" aria-hidden>⊞</span>
                              <span className="an-layout-menu__sub-label">{t('agentnodesPage.toolbar.allAxes')}</span>
                              <span className="an-layout-menu__sub-desc">{t('agentnodesPage.toolbar.fullRelayout')}</span>
                            </button>
                          </div>
                        )}

                        {}
                        <button
                          type="button"
                          role="menuitem"
                          aria-expanded={layoutSubMenu === 'relax'}
                          className={`an-layout-menu__item an-layout-menu__item--parent${layoutSubMenu === 'relax' ? ' an-layout-menu__item--expanded' : ''}`}
                          onClick={() => setLayoutSubMenu((m) => (m === 'relax' ? null : 'relax'))}
                          title={t('agentnodesPage.view.relaxTitle')}
                        >
                          <span className="an-layout-menu__item-icon" aria-hidden>⬡</span>
                          <span className="an-layout-menu__item-body">
                            <span className="an-layout-menu__item-label">{t('agentnodesPage.toolbar.relax')}</span>
                            <span className="an-layout-menu__item-desc">{t('agentnodesPage.toolbar.relaxDesc')}</span>
                          </span>
                          <span className="an-layout-menu__item-expand" aria-hidden>
                            {layoutSubMenu === 'relax' ? '▾' : '▸'}
                          </span>
                        </button>
                        {layoutSubMenu === 'relax' && (
                          <div className="an-layout-menu__sub" role="group" aria-label={t('agentnodesPage.view.relaxGroupAria')}>
                            <button type="button" className="an-layout-menu__sub-item" onClick={() => closeAndRun('relax', effectiveDirection === 'TB' ? 'v' : 'h')}>
                              <span className="an-layout-menu__sub-icon" aria-hidden>{effectiveDirection === 'TB' ? '↕' : '←→'}</span>
                              <span className="an-layout-menu__sub-label">{t('agentnodesPage.toolbar.alongFlow')}</span>
                              <span className="an-layout-menu__sub-desc">{effectiveDirection === 'TB' ? t('agentnodesPage.toolbar.rowSpacing') : t('agentnodesPage.toolbar.colSpacing')}</span>
                            </button>
                            <button type="button" className="an-layout-menu__sub-item" onClick={() => closeAndRun('relax', effectiveDirection === 'TB' ? 'h' : 'v')}>
                              <span className="an-layout-menu__sub-icon" aria-hidden>{effectiveDirection === 'TB' ? '←→' : '↕'}</span>
                              <span className="an-layout-menu__sub-label">{t('agentnodesPage.toolbar.acrossFlow')}</span>
                              <span className="an-layout-menu__sub-desc">{effectiveDirection === 'TB' ? t('agentnodesPage.toolbar.colSpacing') : t('agentnodesPage.toolbar.rowSpacing')}</span>
                            </button>
                            <button type="button" className="an-layout-menu__sub-item" onClick={() => closeAndRun('relax', 'both')}>
                              <span className="an-layout-menu__sub-icon" aria-hidden>⊞</span>
                              <span className="an-layout-menu__sub-label">{t('agentnodesPage.toolbar.allAxes')}</span>
                              <span className="an-layout-menu__sub-desc">{t('agentnodesPage.toolbar.fullRelayout')}</span>
                            </button>
                          </div>
                        )}

                        <div className="an-layout-menu__sep" aria-hidden />

                        <button
                          type="button"
                          role="menuitem"
                          className="an-layout-menu__item"
                          onClick={handleResetToInitial}
                          title={t('agentnodesPage.view.resetLayoutTitle')}
                        >
                          <span className="an-layout-menu__item-icon" aria-hidden>↺</span>
                          <span className="an-layout-menu__item-body">
                            <span className="an-layout-menu__item-label">{t('agentnodesPage.toolbar.resetLayout')}</span>
                            <span className="an-layout-menu__item-desc">{t('agentnodesPage.toolbar.resetLayoutDesc')}</span>
                          </span>
                        </button>

                        {hasAnyCorpus && (
                          <>
                            <div className="an-layout-menu__sep" aria-hidden />
                            <label
                              className={`an-layout-menu__item an-layout-menu__item--toggle${showCorpora ? ' an-layout-menu__item--toggle-on' : ''}`}
                              title={t('agentnodesPage.view.showCorporaTitle')}
                            >
                              <input
                                type="checkbox"
                                className="an-rag-toggle__input"
                                checked={showCorpora}
                                onChange={(e) => setShowCorpora(e.target.checked)}
                                aria-label={t('agentnodesPage.view.showCorporaAria')}
                              />
                              <span className="an-layout-menu__item-icon" aria-hidden>⛁</span>
                              <span className="an-layout-menu__item-body">
                                <span className="an-layout-menu__item-label">{t('agentnodesPage.toolbar.ragSources')}</span>
                                <span className="an-layout-menu__item-desc">{t('agentnodesPage.toolbar.ragSourcesDesc')}</span>
                              </span>
                              <span className="an-layout-menu__item-check" aria-hidden>
                                {showCorpora ? '✓' : ''}
                              </span>
                            </label>
                          </>
                        )}

                        {layoutLint !== null && layoutLint > 0 && (
                          <div className="an-layout-menu__lint an-layout-menu__lint--warn">
                            {t('agentnodesPage.toolbar.crossingsHint', { count: layoutLint })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  {!shouldPortalExport && exportMenuNode}
                  {SHOW_AGENTNODES_TOOLBAR_DEBUG_JSON ? (
                    <button
                      type="button"
                      className="an-btn-ghost an-toolbar-debug-json"
                      onClick={openAgentJsonDebugModal}
                      title={t('agentnodesPage.toolbar.debugAgentJsonTitle')}
                      aria-label={t('agentnodesPage.toolbar.debugAgentJson')}
                      disabled={!loadedAgent}
                    >
                      <Braces size={16} strokeWidth={2} aria-hidden />
                      <span className="an-toolbar-debug-json__label">
                        {t('agentnodesPage.toolbar.debugAgentJson')}
                      </span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="an-btn-ghost"
                    aria-label={t('agentnodesPage.view.helpBtnAria')}
                    title={t('agentnodesPage.view.helpBtnTitle')}
                    onClick={() => setTutorialOpen(true)}
                  >
                    ?
                  </button>
                </div>

                <span className="an-toolbar__divider" aria-hidden />

                {}
                <div className="an-toolbar__group" data-tour="run-toolbar">
                  {isGraphRunning ? (
                    <div className="an-run-progress">
                      <span className="an-run-progress__label">
                        {runProgress.currentStepName
                          ? t('agentnodesPage.toolbar.runningWithStep', {
                              current: runProgress.current,
                              total: runProgress.total,
                              name: runProgress.currentStepName,
                            })
                          : t('agentnodesPage.toolbar.runningShort', {
                              current: runProgress.current,
                              total: runProgress.total,
                            })}
                      </span>
                      <button
                        type="button"
                        className="an-btn-ghost"
                        onClick={cancelRun}
                        title={t('agentnodesPage.view.stopRunTitle')}
                      >
                        <span className="an-btn-icon" aria-hidden>■</span>
                        <span>{t('agentnodesPage.toolbar.stop')}</span>
                      </button>
                    </div>
                  ) : isSimulating ? (
                    <div className="an-run-progress">
                      <span className="an-run-progress__label">
                        {gifRecorder.isRecordingEnabled && (
                          <span className="an-rec-badge" aria-label={t('agentnodesPage.view.recordingBadge')}>⏺</span>
                        )}
                        {simPaused
                          ? simProgress.currentStepName
                            ? t('agentnodesPage.toolbar.pausedWithStep', {
                                current: simProgress.current,
                                total: simProgress.total,
                                name: simProgress.currentStepName,
                              })
                            : t('agentnodesPage.toolbar.pausedStep', {
                                current: simProgress.current,
                                total: simProgress.total,
                              })
                          : simProgress.currentStepName
                            ? t('agentnodesPage.toolbar.simulatingWithStep', {
                                current: simProgress.current,
                                total: simProgress.total,
                                name: simProgress.currentStepName,
                              })
                            : t('agentnodesPage.toolbar.simulatingShort', {
                                current: simProgress.current,
                                total: simProgress.total,
                              })}
                      </span>
                      {simPaused ? (
                        <button
                          type="button"
                          className="an-btn-ghost"
                          onClick={resumeSimulate}
                          title={t('agentnodesPage.view.simContinueTitle')}
                        >
                          <span className="an-btn-icon" aria-hidden>▶</span>
                          <span>{t('agentnodesPage.toolbar.resume')}</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="an-btn-ghost"
                          onClick={pauseSimulate}
                          title={t('agentnodesPage.view.simPauseTitle')}
                        >
                          <span className="an-btn-icon" aria-hidden>⏸</span>
                          <span>{t('agentnodesPage.toolbar.pause')}</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="an-btn-ghost"
                        onClick={cancelSimulate}
                        title={t('agentnodesPage.view.simStopTitle')}
                      >
                        <span className="an-btn-icon" aria-hidden>■</span>
                        <span>{t('agentnodesPage.toolbar.stop')}</span>
                      </button>
                    </div>
                  ) : gifRecorder.isEncoding ? (
                    <div className="an-gif-encoding">
                      <span className="an-gif-encoding__label">
                        {t('agentnodesPage.toolbar.encodingGif', {
                          pct: Math.round(gifRecorder.encodingProgress * 100),
                        })}
                      </span>
                      <span
                        className="an-gif-encoding__bar"
                        style={{ width: `${gifRecorder.encodingProgress * 100}%` }}
                        aria-hidden
                      />
                    </div>
                  ) : (
                    <div
                      className="an-layout-menu an-layout-menu--align-end an-run-split"
                      ref={runMenuRef}
                    >
                      <div className="an-run-split__buttons">
                        <button
                          type="button"
                          className="an-btn-primary an-run-split__main"
                          onClick={() => {
                            setRunMenuOpen(false);
                            setLayoutMenuOpen(false);
                            setExportMenuOpen(false);
                            requestRunAll();
                          }}
                          title={t('agentnodesPage.view.runAllMainTitle')}
                          disabled={!loadedAgent.layers.length}
                        >
                          <span className="an-btn-icon" aria-hidden>▶</span>
                          <span>{t('agentnodesPage.toolbar.runAllBtn')}</span>
                        </button>
                        <button
                          type="button"
                          className={`an-btn-primary an-run-split__caret${runMenuOpen ? ' an-run-split__caret--open' : ''}`}
                          aria-haspopup="menu"
                          aria-expanded={runMenuOpen}
                          aria-label={t('agentnodesPage.view.runAllMoreAria')}
                          onClick={() => {
                            setLayoutMenuOpen(false);
                            setExportMenuOpen(false);
                            setFilterTagMenuOpen(false);
                            setRunMenuOpen((v) => !v);
                          }}
                          title={t('agentnodesPage.view.runAllSimulateMenuTitle')}
                          disabled={!loadedAgent.layers.length}
                        >
                          <ChevronDown size={16} strokeWidth={2.25} aria-hidden />
                        </button>
                      </div>
                      {runMenuOpen && (
                        <div className="an-layout-menu__panel an-run-split__panel" role="menu">
                          <button
                            type="button"
                            role="menuitem"
                            className="an-layout-menu__item"
                            onClick={() => {
                              setRunMenuOpen(false);
                              handleSimulate();
                            }}
                          >
                            <span className="an-layout-menu__item-icon" aria-hidden>⏵</span>
                            <span className="an-layout-menu__item-body">
                              <span className="an-layout-menu__item-label">{t('agentnodesPage.toolbar.simulate')}</span>
                              <span className="an-layout-menu__item-desc">{t('agentnodesPage.toolbar.simulateDesc')}</span>
                            </span>
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : null}
            <div className="an-toolbar__group">
              <button
                type="button"
                className="an-btn-ghost an-stage-fs-toggle"
                aria-pressed={isStageFullscreen}
                aria-label={
                  isStageFullscreen
                    ? t('agentnodesPage.toolbar.exitStageFullscreen')
                    : t('agentnodesPage.toolbar.enterStageFullscreen')
                }
                title={
                  isStageFullscreen
                    ? t('agentnodesPage.toolbar.exitStageFullscreenTitle')
                    : t('agentnodesPage.toolbar.enterStageFullscreenTitle')
                }
                onClick={() => {
                  void toggleStageFullscreen();
                }}
              >
                {isStageFullscreen ? (
                  <Minimize2 size={16} strokeWidth={2.25} aria-hidden />
                ) : (
                  <Maximize2 size={16} strokeWidth={2.25} aria-hidden />
                )}
              </button>
            </div>
          </div>
        </div>

        {loadedAgent ? (
          <div className="an-skills-bar" style={{ padding: '8px 12px', borderBottom: '1px solid #e6e6eb' }}>
            <SkillsPanel
              lib={skillsLib}
              attachedIds={attachedSkillIds}
              onChange={updateSkillIds}
            />
            <AgentFilesPanel
              key={`${projectId}:${loadedAgent.id}:${currentUserEmail}`}
              metadata={loadedAgent.metadata}
              onChange={updateInputs}
              projectId={projectId}
              projectCorpora={projectCorpusLinks}
              disabled={isGraphRunning || Boolean(stepEditorLayerId)}
            />
            {graphRunError && <div className="agent-files-error" role="alert">{graphRunError}</div>}
          </div>
        ) : null}

        <div className="c272-canvas" data-tour="graph-canvas">
          {loadingAgent ? (
            <div className="c272-empty">{t('agentnodesPage.toolbar.loadingAgent')}</div>
          ) : agentError ? (
            <div
              className="c272-empty"
              role="alert"
              style={{ color: '#b00020' }}
            >
              {agentError}
            </div>
          ) : !loadedAgent && nodes.length === 0 ? (
            <div className="c272-empty">
              {t('agentnodesPage.toolbar.pickAgentCanvas')}
            </div>
          ) : (
            <>
              {graphHydrationWarning && loadedAgent ? (
                <div className="an-graph-hydration-banner" role="status">
                  {t('agentnodesPage.graphHydrationRebuiltBanner')}
                </div>
              ) : null}
            <AgentNodesDiagram
              ref={diagramRef}
              agentId={loadedAgent?.id ?? null}
              nodes={nodes}
              edges={edges}
              setNodes={setNodes}
              setEdges={setEdges}
              addStepNode={addStepNode}
              edgeMode={edgeMode}
              runningLayerIds={runningLayerIds}
              completedLayerIds={completedLayerIds}
              failedLayerIds={failedLayerIds}
              isSimulating={isSimulating}
              simulationPaused={simPaused}
              onPanDuringSimulation={pauseSimulate}
              showCorpora={showCorpora && hasAnyCorpus}
              corpusDisplayNameById={corpusDisplayNameById}
              allLayers={loadedAgent?.layers ?? []}
              onOpenNode={handleOpenNode}
              onOpenInWorkflow={handleOpenInWorkflow}
              onSetNodeTag={handleSetNodeTag}
              graphFilter={graphFilterForDiagram}
              onRemoveLayer={removeLayer}
            />
            </>
          )}
        </div>
      </main>

      <StepEditorModal
        open={Boolean(editingNode)}
        title={editingNode?.data.title ?? ''}
        stepLabel={editingNode ? `Notes • ${editingNode.data.indexLabel}` : ''}
        initialValue={initialNotes}
        onClose={() => setEditingNodeId(null)}
        onSave={handleModalSave}
      />

      <StepEditorPopup
        open={Boolean(editingLayer)}
        layer={editingLayer}
        projectId={projectId}
        agentInputMetadata={loadedAgent?.metadata}
        agentSkillTexts={agentSkillTexts}
        externalRunning={Boolean(editingLayer && runnerRunningIds.has(editingLayer.id))}
        externalError={editingLayer && failedLayerIds.has(editingLayer.id) ? 'Graph run did not complete.' : undefined}
        onRunStart={() => { if (stepEditorLayerId) clearLayerRunState(stepEditorLayerId); }}
        allLayers={loadedAgent?.layers ?? []}
        incomingLayerIds={incomingLayerIds}
        agentName={
          loadedAgent ? formatAgentToolbarTitle(loadedAgent.name, loadedAgent.metadata) : null
        }
        onClose={() => setStepEditorLayerId(null)}
        onPatchLayer={(patch) => {
          if (!stepEditorLayerId) return;
          updateLayer(stepEditorLayerId, patch);
          const nodePatch: Record<string, unknown> = {};
          if ('tag' in patch) nodePatch.tag = patch.tag;
          if ('name' in patch) nodePatch.title = patch.name;
          const patchAny = patch as unknown as Record<string, unknown>;
          if ('corpusId' in patchAny) {
            nodePatch.corpusId = typeof patchAny.corpusId === 'string' && patchAny.corpusId
              ? patchAny.corpusId
              : undefined;
          }
          if (Object.keys(nodePatch).length > 0) {
            patchNodeDataByLayerId(
              stepEditorLayerId,
              nodePatch as Parameters<typeof patchNodeDataByLayerId>[1],
            );
          }
        }}
        onSaveAgent={autoSaveAgent}
        currentUserEmail={currentUserEmail}
        projectCorpusLinks={projectCorpusLinks}
        onAttachCorpusToProject={handleAttachCorpusToProject}
      />

      {toast &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className="c272-toast" role="status">
            {toast}
          </div>,
          document.body,
        )}

      <AgentNodesTutorialModal
        open={tutorialOpen}
        onClose={closeTutorial}
        onBeforeStep={handleTutorialBeforeStep}
      />

      <SimulateRecordModal
        open={showSimulateModal}
        onSimulate={() => handleStartSimulate(false)}
        onSimulateAndRecord={() => handleStartSimulate(true)}
        onClose={() => setShowSimulateModal(false)}
      />

      <RunAllConfirmModal
        open={showRunAllConfirmModal}
        stepCount={loadedAgent?.layers.length ?? 0}
        onClose={() => setShowRunAllConfirmModal(false)}
        onConfirm={confirmRunAll}
      />

      {SHOW_AGENTNODES_TOOLBAR_DEBUG_JSON &&
        agentJsonDebugOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="an-debug-agent-json-backdrop"
            onClick={closeAgentJsonDebugModal}
            role="presentation"
          >
            <div
              className="an-debug-agent-json-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="an-debug-agent-json-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="an-debug-agent-json-header">
                <h2 id="an-debug-agent-json-title" className="an-debug-agent-json-title">
                  {t('agentnodesPage.toolbar.debugAgentJson')}
                </h2>
                <div className="an-debug-agent-json-actions">
                  <button
                    type="button"
                    className="an-debug-agent-json-copy"
                    onClick={() => void copyAgentJsonDebug()}
                  >
                    <Copy size={14} aria-hidden />
                    <span>
                      {agentJsonCopied
                        ? t('agentnodesPage.toolbar.debugAgentJsonCopied')
                        : t('agentnodesPage.toolbar.debugAgentJsonCopy')}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="an-debug-agent-json-close"
                    onClick={closeAgentJsonDebugModal}
                    aria-label={t('agentnodesPage.toolbar.debugAgentJsonClose')}
                  >
                    ✕
                  </button>
                </div>
              </div>
              <pre className="an-debug-agent-json-pre" tabIndex={0}>
                {agentJsonDebugText.trim()
                  ? agentJsonDebugText
                  : t('agentnodesPage.toolbar.debugAgentJsonEmpty')}
              </pre>
            </div>
          </div>,
          document.body,
        )}

      {shouldPortalExport &&
        formPortalElement &&
        typeof document !== 'undefined' &&
        createPortal(exportMenuNode, formPortalElement)}

      {typeof document !== 'undefined' &&
        createPortal(
          <ExportWizardModal
            open={exportWizardOpen}
            doc={currentDoc}
            persistId={loadedAgent?.id ?? null}
            agentVersions={loadedAgent?.versions}
            currentAgentVersion={loadedAgent?.currentVersion}
            latestRun={latestRun}
            isStale={isStale}
            isRunning={isReviewing}
            runError={reviewError}
            onClose={() => setExportWizardOpen(false)}
            onRun={(reviewerIds, sectionDoc) => void runReview(reviewerIds, sectionDoc)}
            onAcknowledge={acknowledgeComment}
            onJumpToStep={(stepNumber) => {
              setExportWizardOpen(false);
              if (currentDoc) {
                for (const section of currentDoc.sections) {
                  for (const step of section.steps) {
                    if (step.number === stepNumber) {
                      const matchedNode = nodes.find((n) => n.data?.title === step.name);
                      if (matchedNode?.data?.layerId) {
                        if (embedded && viewMode === 'form') {
                          const params = new URLSearchParams(searchParams?.toString() ?? '');
                          params.set('step', matchedNode.data.layerId);
                          router.replace(`${pathname}?${params.toString()}`, { scroll: false });
                        } else {
                          setStepEditorLayerId(matchedNode.data.layerId);
                        }
                      }
                      break;
                    }
                  }
                }
              }
            }}
            onToast={(msg) => setToast(msg)}
          />,
          document.body,
        )}

    </div>
  );
}
