'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import nextDynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { ChevronRight, X } from 'lucide-react';
import { FaTimes } from 'react-icons/fa';
import type { AgentFile } from '../../lib/types';
import { formatAgentDisplayName } from '../lib/agentDisplayName';
import AgentDiagram from './AgentDiagram';
import AgentList from './AgentList';
import ExportMenu from './ExportMenu';
import AnswerDebugPanel from '../../components/AnswerDebugPanel';
import { useProjectState } from '../../components/ProjectStateContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { useAgentOutputs } from '../hooks/useAgentOutputs';
import { formatAgentToolbarTitle } from '../lib/agentDisplayName';
import { buildStructuredDoc } from '../lib/exportFormatter';
import { describeLayerOutputFields, getLayerOutputText } from '../lib/layerOutput';
import type { Recipe } from '../lib/recipesCatalog';
import '../style.css';

const StepEditorModal = nextDynamic(() => import('./StepEditorModal'), { ssr: false });

type ShareModalState =
  | { open: false }
  | {
      open: true;
      agentId: string;
      agentRawName: string;
      agentDisplayName: string;
      loading: boolean;
      jsonText: string;
      to: string;
      subject: string;
      message: string;
    };

export default function Canvas272View() {
  const { status } = useSession();
  const router = useRouter();
  const { t } = useLanguage();
  const { projectFolder } = useProjectState();
  const projectId = projectFolder?.projectId ?? null;
  const {
    agentList,
    agentListLoading,
    agentListError,
    refreshAgentList,
    loaded,
    loadingAgent,
    agentError,
    selectAgent,
    setOutput,
    persistToDrive,
  } = useAgentOutputs();

  const [sidebarHidden, setSidebarHidden] = useState<boolean>(false);
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [debugLayerId, setDebugLayerId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: 'info' | 'error' } | null>(null);
  const [savingDrive, setSavingDrive] = useState<boolean>(false);
  const [shareModal, setShareModal] = useState<ShareModalState>({ open: false });

  useEffect(() => {
    if (!toast || toast.tone === 'error') return undefined;
    const id = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(id);
  }, [toast]);

  const handleSelectAgent = useCallback(
    (agentId: string) => {
      selectAgent(agentId);
      setSidebarHidden(true);
    },
    [selectAgent]
  );

  const handleBackToList = useCallback(() => {
    setSidebarHidden(false);
  }, []);

  const handleReopenSidebar = useCallback(() => {
    setSidebarHidden(false);
  }, []);

  const handleRecipeViewOnAgentNodes = useCallback(
    (recipe: Recipe) => {
      router.push(`/agentnodes?recipe=${encodeURIComponent(recipe.id)}`);
    },
    [router],
  );

  const handleNodeClick = useCallback((layerId: string) => {
    setEditingLayerId(layerId);
  }, []);

  const handleOpenDebug = useCallback((layerId: string) => {
    setDebugLayerId(layerId);
  }, []);

  const openShareModal = useCallback(
    async (agent: AgentFile) => {
      const agentDisplayName = formatAgentDisplayName(agent.name);
      setShareModal({
        open: true,
        agentId: agent.id,
        agentRawName: agent.name,
        agentDisplayName,
        loading: true,
        jsonText: '',
        to: '',
        subject: `Agent Corpus: ${agentDisplayName}`,
        message: `Hi,\n\nSharing an agent with you.\n\nAgent name: ${agent.name || agentDisplayName}\n\nNotes:\n- This will be sent directly from your Gmail account.\n- The agent Corpus will be attached as a .json file.\n`,
      });

      try {
        if (!projectId) throw new Error('Missing project ID');
        const response = await fetch(`/api/projects/${projectId}/folders/AF/files/${agent.id}`);
        if (!response.ok) throw new Error('Failed to fetch agent data');
        const agentData = await response.json();
        const jsonText = JSON.stringify(agentData, null, 2);
        setShareModal((prev) => (prev.open ? { ...prev, loading: false, jsonText } : prev));
      } catch (err) {
        console.error('Failed to load agent JSON for sharing:', err);
        setShareModal((prev) =>
          prev.open
            ? {
                ...prev,
                loading: false,
                jsonText: '',
                message: `${prev.message}\n\n(Warning) Failed to load agent Corpus. You can still open Gmail, but Corpus copy/download may not work.\n`,
              }
            : prev,
        );
      }
    },
    [projectId],
  );

  const closeShareModal = useCallback(() => {
    setShareModal({ open: false });
  }, []);

  const sendEmailNow = useCallback(async () => {
    if (!shareModal.open) return;

    const to = shareModal.to.trim();
    const subject = shareModal.subject.trim();
    const message = shareModal.message.trim();

    if (!to) {
      setToast({ message: t('canvas272Page.shareNeedRecipient'), tone: 'error' });
      return;
    }
    if (!subject) {
      setToast({ message: t('canvas272Page.shareNeedSubject'), tone: 'error' });
      return;
    }
    if (!shareModal.jsonText) {
      setToast({ message: t('canvas272Page.shareCorpusNotReady'), tone: 'error' });
      return;
    }

    try {
      const attachmentFileName = `${shareModal.agentDisplayName.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'agent'}.json`;
      const res = await fetch('/api/ai-agents/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to,
          subject,
          message,
          attachmentFileName,
          attachmentJson: shareModal.jsonText,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setToast({ message: data?.error || t('canvas272Page.shareSendFailed'), tone: 'error' });
        return;
      }

      setToast({ message: t('canvas272Page.shareSent'), tone: 'info' });
      closeShareModal();
    } catch (err) {
      console.error('Failed to send email:', err);
      setToast({ message: t('canvas272Page.shareSendFailed'), tone: 'error' });
    }
  }, [closeShareModal, shareModal, t]);

  const editingLayer = useMemo(() => {
    if (!loaded || !editingLayerId) return null;
    return loaded.agent.layers.find((l) => l.id === editingLayerId) ?? null;
  }, [loaded, editingLayerId]);

  const debugLayer = useMemo(() => {
    if (!loaded || !debugLayerId) return null;
    return loaded.agent.layers.find((l) => l.id === debugLayerId) ?? null;
  }, [loaded, debugLayerId]);

  const editingInitialValue = useMemo(() => {
    if (!loaded || !editingLayer) return '';
    const edited = loaded.sidecarOutputs[editingLayer.id];
    if (typeof edited === 'string' && edited.length > 0) return edited;
    return getLayerOutputText(editingLayer);
  }, [loaded, editingLayer]);

  const handleModalSave = useCallback(
    (value: string) => {
      if (!editingLayerId) return;
      setOutput(editingLayerId, value);
      setEditingLayerId(null);
      setToast({ message: t('canvas272Page.savedLocally'), tone: 'info' });
    },
    [editingLayerId, setOutput, t]
  );

  const handleSaveToDrive = useCallback(async () => {
    setSavingDrive(true);
    try {
      const result = await persistToDrive();
      setToast(
        result.ok
          ? { message: t('canvas272Page.savedToDrive'), tone: 'info' }
          : { message: t('canvas272Page.driveSaveFailed', { error: result.error ?? 'unknown' }), tone: 'error' }
      );
    } finally {
      setSavingDrive(false);
    }
  }, [persistToDrive, t]);

  const buildDoc = useCallback(() => {
    if (!loaded) throw new Error('No agent loaded');
    return buildStructuredDoc(loaded.agent, loaded.sidecarOutputs);
  }, [loaded]);

  const outputDiagnostic = useMemo<null | {
    totalLayers: number;
    layersWithAnyRawField: number;
    firstLayerKeys: string[];
    firstLayerFieldLengths: Record<string, number>;
  }>(() => {
    if (process.env.NODE_ENV === 'production') return null;
    if (!loaded) return null;
    const { layers } = loaded.agent;
    if (layers.length === 0) return null;
    const resolved = layers.filter((l) => getLayerOutputText(l).length > 0).length;
    const edited = Object.values(loaded.sidecarOutputs).filter(
      (v) => typeof v === 'string' && v.trim().length > 0,
    ).length;
    if (resolved + edited > 0) return null;
    const layersWithAnyRawField = layers.filter(
      (l) => Object.keys(describeLayerOutputFields(l)).length > 0,
    ).length;
    return {
      totalLayers: layers.length,
      layersWithAnyRawField,
      firstLayerKeys: layers[0] ? Object.keys(layers[0]).slice(0, 24) : [],
      firstLayerFieldLengths: layers[0] ? describeLayerOutputFields(layers[0]) : {},
    };
  }, [loaded]);

  if (status === 'loading') {
    return <div className="c272-root"><div className="c272-empty">{t('canvas272Page.loadingSession')}</div></div>;
  }

  return (
    <div className="c272-root">
      <AgentList
        projectId={projectId}
        agents={agentList}
        loading={agentListLoading}
        error={agentListError}
        selectedId={loaded?.agent.id ?? null}
        hidden={sidebarHidden && Boolean(loaded)}
        onSelect={handleSelectAgent}
        onRefresh={refreshAgentList}
        onShare={openShareModal}
        onRequestCollapse={
          loaded && !sidebarHidden ? () => setSidebarHidden(true) : undefined
        }
        onSimulateRecipe={handleRecipeViewOnAgentNodes}
      />

      {sidebarHidden && loaded ? (
        <button
          type="button"
          className="c272-reopen-handle"
          aria-label={t('canvas272Page.reopenAgentsList')}
          title={t('canvas272Page.reopenAgentsList')}
          onClick={handleReopenSidebar}
        >
          <ChevronRight size={16} aria-hidden />
        </button>
      ) : null}

      <main className="c272-stage">
        <div className="c272-toolbar">
          <div className="c272-toolbar__title">
            {loaded ? (
              <>
                <button type="button" className="c272-btn" onClick={handleBackToList}>
                  {t('canvas272Page.backToAgents')}
                </button>
                <span title={loaded.agent.name}>
                  {formatAgentToolbarTitle(loaded.agent.name, loaded.agent.metadata)}
                </span>
              </>
            ) : (
              <span>{t('canvas272Page.pickAnAgent')}</span>
            )}
          </div>
          <div className="c272-toolbar__spacer" />
          {loaded ? (
            <>
              <button
                type="button"
                className="c272-btn"
                disabled={savingDrive}
                onClick={handleSaveToDrive}
                title={t('canvas272Page.saveToDriveTitle')}
              >
                {savingDrive ? t('canvas272Page.savingDrive') : t('canvas272Page.saveToDrive')}
              </button>
              <ExportMenu
                disabled={loadingAgent}
                buildDoc={buildDoc}
                onToast={(m) => setToast({ message: m, tone: 'info' })}
              />
            </>
          ) : null}
        </div>

        <div className="c272-canvas">
          {loadingAgent ? (
            <div className="c272-empty">{t('canvas272Page.loadingAgent')}</div>
          ) : agentError ? (
            <div className="c272-empty c272-empty--error" role="alert">
              {agentError}
            </div>
          ) : !loaded ? (
            <div className="c272-empty">
              {t('canvas272Page.pickFromLeft')}
            </div>
          ) : (
            <>
              {outputDiagnostic ? (
                <div className="c272-diagnostic" role="status">
                  <strong>{t('canvas272Page.noStepOutputs')}</strong>
                  <div>
                    Layers: {outputDiagnostic.totalLayers} • Layers with any known
                    output field: {outputDiagnostic.layersWithAnyRawField}
                  </div>
                  <div>
                    First layer keys: <code>{outputDiagnostic.firstLayerKeys.join(', ') || '(none)'}</code>
                  </div>
                  {Object.keys(outputDiagnostic.firstLayerFieldLengths).length > 0 ? (
                    <div>
                      First layer output fields:{' '}
                      <code>
                        {Object.entries(outputDiagnostic.firstLayerFieldLengths)
                          .map(([k, n]) => `${k}=${n}`)
                          .join(', ')}
                      </code>
                    </div>
                  ) : (
                    <div>
                      None of <code>result / output / assistantResponse / response /
                      text / completion / answer</code> are present on the first
                      layer. Open devtools → console for a per-layer table.
                    </div>
                  )}
                </div>
              ) : null}
              <AgentDiagram
                agent={loaded.agent}
                sidecarOutputs={loaded.sidecarOutputs}
                onNodeClick={handleNodeClick}
                onOpenDebug={handleOpenDebug}
              />
            </>
          )}
        </div>
      </main>

      {editingLayer && (
        <StepEditorModal
          open
          title={editingLayer.name ?? ''}
          stepLabel={`${t('canvas272Page.markdownSource')}${editingLayer.selectedModel ? ` • ${String(editingLayer.selectedModel)}` : ''}`}
          initialValue={editingInitialValue}
          onClose={() => setEditingLayerId(null)}
          onSave={handleModalSave}
          onOpenDebug={editingLayer.debugInfo ? () => handleOpenDebug(editingLayer.id) : undefined}
        />
      )}

      <AnswerDebugPanel
        open={Boolean(debugLayer)}
        debugInfo={debugLayer?.debugInfo}
        onClose={() => setDebugLayerId(null)}
      />

      {shareModal.open &&
        createPortal(
          <div className="c272-share-overlay" onClick={closeShareModal}>
            <div className="c272-share-modal" onClick={(e) => e.stopPropagation()}>
              <div className="c272-share-modal__header">
                <div>
                  <div className="c272-share-modal__title">{t('canvas272Page.shareModalTitle')}</div>
                  <div className="c272-share-modal__subtitle">
                    {t('canvas272Page.shareModalAgent')}{' '}
                    <span className="c272-share-modal__agent">{shareModal.agentDisplayName}</span>
                  </div>
                </div>
                <button
                  type="button"
                  className="c272-share-modal__close"
                  onClick={closeShareModal}
                  aria-label={t('canvas272Page.dismiss')}
                  title={t('canvas272Page.dismiss')}
                >
                  <FaTimes aria-hidden />
                </button>
              </div>

              <div className="c272-share-modal__body">
                <label className="c272-share-field">
                  <span className="c272-share-field__label">{t('canvas272Page.shareFieldTo')}</span>
                  <input
                    className="c272-share-field__input"
                    value={shareModal.to}
                    onChange={(e) =>
                      setShareModal((prev) => (prev.open ? { ...prev, to: e.target.value } : prev))
                    }
                    placeholder={t('canvas272Page.sharePlaceholderEmails')}
                  />
                </label>

                <label className="c272-share-field">
                  <span className="c272-share-field__label">{t('canvas272Page.shareFieldSubject')}</span>
                  <input
                    className="c272-share-field__input"
                    value={shareModal.subject}
                    onChange={(e) =>
                      setShareModal((prev) => (prev.open ? { ...prev, subject: e.target.value } : prev))
                    }
                  />
                </label>

                <label className="c272-share-field">
                  <span className="c272-share-field__label">{t('canvas272Page.shareFieldMessage')}</span>
                  <textarea
                    className="c272-share-field__textarea"
                    rows={6}
                    value={shareModal.message}
                    onChange={(e) =>
                      setShareModal((prev) => (prev.open ? { ...prev, message: e.target.value } : prev))
                    }
                  />
                </label>

                <div className="c272-share-modal__footer">
                  <span className="c272-share-modal__status">
                    {shareModal.loading
                      ? t('canvas272Page.shareLoadingJson')
                      : shareModal.jsonText
                        ? t('canvas272Page.shareJsonReady')
                        : t('canvas272Page.shareJsonNotAvailable')}
                  </span>
                  <button
                    type="button"
                    className="c272-btn c272-btn--primary"
                    onClick={sendEmailNow}
                    title={t('canvas272Page.shareSendTitle')}
                  >
                    {t('canvas272Page.shareSend')}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {toast ? (
        <div
          className={`c272-toast${toast.tone === 'error' ? ' c272-toast--error' : ''}`}
          role={toast.tone === 'error' ? 'alert' : 'status'}
        >
          <span>{toast.message}</span>
          {toast.tone === 'error' ? (
            <button
              type="button"
              className="c272-toast__close"
              onClick={() => setToast(null)}
              aria-label={t('canvas272Page.dismiss')}
              title={t('canvas272Page.dismiss')}
            >
              <X size={14} aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
