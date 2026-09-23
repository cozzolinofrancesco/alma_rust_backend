'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAgentEditor } from '../ai-agents/edit/[agent-id]/AgentEditorContext';
import type { StructuredDoc } from '../canvas-272/lib/exportFormatter';
import { buildStructuredDocByTag } from '../agentnodes/lib/tagSections';
import { useReviewState } from '../agentnodes/hooks/useReviewState';
import type { ReviewerId, ReviewRun } from '../agentnodes/lib/reviewers/types';
import { exportStructuredDocToGoogleDoc } from '../canvas-272/lib/exportGoogleDoc';
import { exportStructuredDocToPdf } from '../canvas-272/lib/exportPdf';
import { exportStructuredDocToDocx } from '../canvas-272/lib/exportDocx';
import { useLanguage } from '../contexts/LanguageContext';

export type OutputTab = 'preview' | 'edit' | 'validation' | 'export';

export interface OutputWorkspaceValue {
  // Tab mode shared between the main output pane and the side panel.
  outputTab: OutputTab;
  setOutputTab: (tab: OutputTab) => void;

  // Validation section selection.
  activeSection: number | null;
  setActiveSection: (index: number | null) => void;
  lastAnalysedSection: number | null;

  // Editable document (markdown). Empty string = use the doc's baseline.
  editedMarkdown: string;
  setEditedMarkdown: (markdown: string) => void;
  editorKey: number;

  // The assembled document (single source for edit / validation / export).
  currentDoc: StructuredDoc | null;

  // Review/audit state.
  latestRun: ReviewRun | null;
  isStale: boolean;
  isRunning: boolean;
  runError: string | null;
  runSection: (reviewerIds: ReviewerId[], sectionIdx: number) => void;
  acknowledgeComment: (reviewerId: ReviewerId, commentId: string, acked: boolean) => void;

  // Export.
  exporting: boolean;
  handleGoogleDoc: () => void;
  handlePdf: () => void;
  handleDocx: () => void;

  // Preview modal.
  previewDoc: StructuredDoc | null;
  openPreview: () => void;
  closePreview: () => void;

  // Toast.
  toast: string | null;
}

const OutputWorkspaceContext = createContext<OutputWorkspaceValue | null>(null);

export function useOutputWorkspace(): OutputWorkspaceValue {
  const ctx = useContext(OutputWorkspaceContext);
  if (!ctx) {
    throw new Error('useOutputWorkspace must be used within an OutputWorkspaceProvider');
  }
  return ctx;
}

export function useOptionalOutputWorkspace(): OutputWorkspaceValue | null {
  return useContext(OutputWorkspaceContext);
}

function fileNameBase(doc: StructuredDoc): string {
  const base = (doc.title || doc.agentName).replace(/[^a-z0-9-_]+/gi, '_').slice(0, 60);
  return `${base || 'document'}-${Date.now()}`;
}

export function OutputWorkspaceProvider({ children }: { children: React.ReactNode }) {
  const { t } = useLanguage();
  const { graphAgent, agentId, projectId } = useAgentEditor();

  const [outputTab, setOutputTab] = useState<OutputTab>('preview');
  const [activeSection, setActiveSection] = useState<number | null>(null);
  const [lastAnalysedSection, setLastAnalysedSection] = useState<number | null>(null);
  const [editedMarkdown, setEditedMarkdown] = useState('');
  const [editorKey, setEditorKey] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [previewDoc, setPreviewDoc] = useState<StructuredDoc | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const currentDoc = useMemo<StructuredDoc | null>(
    () => (graphAgent ? buildStructuredDocByTag(graphAgent, {}) : null),
    [graphAgent],
  );

  const { latestRun, isStale, isRunning, runError, runReview, acknowledgeComment, clearRun } =
    useReviewState({ projectId, agentId, currentDoc });

  // Reset per-agent state when switching agents.
  useEffect(() => {
    setEditedMarkdown('');
    setActiveSection(null);
    setLastAnalysedSection(null);
    setEditorKey((k) => k + 1);
    clearRun();
  }, [agentId, clearRun]);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const buildExportDoc = useCallback((): StructuredDoc | null => {
    if (!currentDoc) return null;
    if (editedMarkdown.trim()) {
      return {
        title: currentDoc.title,
        agentName: currentDoc.agentName,
        exportedAt: currentDoc.exportedAt,
        sections: [
          {
            heading: null,
            tag: null,
            steps: [
              {
                number: '1',
                name: currentDoc.agentName || 'Document',
                output: editedMarkdown.trim(),
              },
            ],
          },
        ],
      };
    }
    return currentDoc;
  }, [currentDoc, editedMarkdown]);

  const withExport = useCallback(
    async (fn: (doc: StructuredDoc) => Promise<void>, successMsg: string, failMsg: string) => {
      const doc = buildExportDoc();
      if (!doc) return;
      setExporting(true);
      try {
        await fn(doc);
        showToast(successMsg);
      } catch (err) {
        showToast(
          t('agentnodesPage.exportWizard.exportFailDetail', {
            failMsg,
            detail:
              err instanceof Error ? err.message : t('agentnodesPage.exportWizard.unknownError'),
          }),
        );
      } finally {
        setExporting(false);
      }
    },
    [buildExportDoc, showToast, t],
  );

  const handleGoogleDoc = useCallback(() => {
    void withExport(
      async (doc) => {
        const result = await exportStructuredDocToGoogleDoc(doc);
        if (result.webViewLink) window.open(result.webViewLink, '_blank', 'noopener,noreferrer');
      },
      t('agentnodesPage.exportWizard.toastGoogleDocOk'),
      t('agentnodesPage.exportWizard.toastGoogleDocFail'),
    );
  }, [withExport, t]);

  const handlePdf = useCallback(() => {
    void withExport(
      (doc) => exportStructuredDocToPdf(doc, `${fileNameBase(doc)}.pdf`),
      t('agentnodesPage.exportWizard.toastPdfOk'),
      t('agentnodesPage.exportWizard.toastPdfFail'),
    );
  }, [withExport, t]);

  const handleDocx = useCallback(() => {
    void withExport(
      (doc) => exportStructuredDocToDocx(doc, `${fileNameBase(doc)}.docx`),
      t('agentnodesPage.exportWizard.toastDocxOk'),
      t('agentnodesPage.exportWizard.toastDocxFail'),
    );
  }, [withExport, t]);

  const openPreview = useCallback(() => {
    setPreviewDoc(buildExportDoc());
  }, [buildExportDoc]);
  const closePreview = useCallback(() => setPreviewDoc(null), []);

  const runSection = useCallback(
    (reviewerIds: ReviewerId[], sectionIdx: number) => {
      if (!currentDoc) return;
      const section = currentDoc.sections[sectionIdx];
      if (!section) return;
      setLastAnalysedSection(sectionIdx);
      void runReview(reviewerIds, { ...currentDoc, sections: [section] });
    },
    [currentDoc, runReview],
  );

  const value = useMemo<OutputWorkspaceValue>(
    () => ({
      outputTab,
      setOutputTab,
      activeSection,
      setActiveSection,
      lastAnalysedSection,
      editedMarkdown,
      setEditedMarkdown,
      editorKey,
      currentDoc,
      latestRun,
      isStale,
      isRunning,
      runError,
      runSection,
      acknowledgeComment,
      exporting,
      handleGoogleDoc,
      handlePdf,
      handleDocx,
      previewDoc,
      openPreview,
      closePreview,
      toast,
    }),
    [
      outputTab,
      activeSection,
      lastAnalysedSection,
      editedMarkdown,
      editorKey,
      currentDoc,
      latestRun,
      isStale,
      isRunning,
      runError,
      runSection,
      acknowledgeComment,
      exporting,
      handleGoogleDoc,
      handlePdf,
      handleDocx,
      previewDoc,
      openPreview,
      closePreview,
      toast,
    ],
  );

  return (
    <OutputWorkspaceContext.Provider value={value}>{children}</OutputWorkspaceContext.Provider>
  );
}
