'use client';
import { usePathname, useRouter } from 'next/navigation';
import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FaCloud, FaClock, FaEye, FaPlay, FaPlus, FaRobot, FaShareAlt, FaTag, FaTimes, FaUpload } from 'react-icons/fa';
import { CollectionContextProvider } from '../components/CollectionContext';
import MissingFoldersModal from '../components/MissingFoldersModal';
import { useProjectState } from '../components/ProjectStateContext';
import { useSharedSession } from '../components/SharedSessionProvider';
import { usePageReady } from '../components/SplashScreenWrapper';
import { getRequiredFoldersCount } from '../lib/project-constants';
import { getAgentLastOpenedIndexForProject, recordAgentOpened } from '../lib/recentItemsManager';
import FullScreenCubeLoader from './components/FullScreenCubeLoader';
import AIAssistCreateAgentModal from './components/AIAssistCreateAgentModal';
import ReportCreationModal from './components/ReportCreationModal';
import AgentNameModal from '../components/AgentNameModal';
import { useLanguage } from '../contexts/LanguageContext';

interface VantaEffect {
  destroy: () => void;
  resize: () => void;
}

declare global {
  interface Window {
    THREE?: unknown;
    VANTA?: {
      CLOUDS: (options: unknown) => VantaEffect;
      NET: (options: unknown) => VantaEffect;
      HALO: (options: unknown) => VantaEffect;
      CELLS: (options: unknown) => VantaEffect;
      RINGS: (options: unknown) => VantaEffect;
    };
  }
}

import { AGENT_FILES_FETCH_TIMEOUT_MS, fetchAgentFiles } from '../lib/api';
import { isSct272Pathname, SCT272_REOPEN_EVENT } from '../lib/sct272-events';
import { formatAgentSidebarLabel } from '../canvas-272/lib/agentDisplayName';
import "../styles/collections.css";
import "./style.css";

interface Layer {
  id: string;
  name: string;
  selectedModel?: string;
  systemInstruction?: string;
  userInput?: string;
  result?: string;
  referencedSteps?: string[];
  collection?: number;
  imageUrls?: string[];
  urlContent?: string[];
  instructions?: string;
  input?: string;
  [key: string]: unknown;
}

interface AgentData {
  version?: string;
  name: string;
  layers: Layer[];
  metadata?: {
    created?: string;
    modified?: string;
    description?: string;
    healingInfo?: {
      needsHealing: boolean;
      changes: string[];
      errors: string[];
      originalVersion: string;
    };
  };
}

interface DashboardAgent {
  id: string;
  name: string;
  created: string;
  modified: string;
  createdTimestamp: number;
  modifiedTimestamp: number;
  stepsCount?: number;
  version?: string;
}

type HoverTooltipState =
  | { visible: false }
  | { visible: true; text: string; copyText: string; top: number; left: number; maxWidth: number; placement: 'above' | 'below' };

type ToastState =
  | { visible: false }
  | { visible: true; text: string; top: number; left: number };

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

const migrateAgent = (oldAgent: Record<string, unknown>): { agent: AgentData, changes: string[], errors: string[], needsHealing: boolean } => {
  const changes: string[] = [];
  const errors: string[] = [];
  const currentVersion = "1";
  let needsHealing = false;

  if (!oldAgent || typeof oldAgent !== 'object') {
    needsHealing = true;
    errors.push("Agent data is corrupted or invalid");
    return {
      agent: {
        version: currentVersion,
        name: "Corrupted Agent",
        layers: [],
        metadata: {
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
          description: "This agent has corrupted data and needs healing"
        }
      },
      changes: [],
      errors,
      needsHealing
    };
  }

  const requiredKeys = ['name', 'layers'];
  const missingKeys = requiredKeys.filter(key => !oldAgent[key]);

  if (missingKeys.length > 0) {
    needsHealing = true;
    errors.push(`Missing required keys: ${missingKeys.join(', ')}`);
  }

  if (oldAgent.layers && Array.isArray(oldAgent.layers)) {
    const layers = oldAgent.layers as Record<string, unknown>[];
    layers.forEach((layer, index) => {
      const layerRequiredKeys = ['id', 'name'];
      const layerMissingKeys = layerRequiredKeys.filter(key => !layer[key]);

      if (layerMissingKeys.length > 0) {
        needsHealing = true;
        errors.push(`Step ${index + 1} missing keys: ${layerMissingKeys.join(', ')}`);
      }
    });
  }

  if (!needsHealing) {
    return {
      agent: oldAgent as unknown as AgentData,
      changes: [],
      errors: [],
      needsHealing: false
    };
  }

  const newAgent: AgentData = {
    version: currentVersion,
    name: (oldAgent.name as string) || "Untitled Agent",
    layers: (oldAgent.layers as Layer[]) || [],
    metadata: {
      created: ((oldAgent.metadata as Record<string, unknown>)?.created as string) || (oldAgent.created as string) || new Date().toISOString(),
      modified: new Date().toISOString(),
      description: ((oldAgent.metadata as Record<string, unknown>)?.description as string) || (oldAgent.description as string) || ""
    }
  };

  return { agent: newAgent, changes, errors, needsHealing };
};

interface AgentCardProps {
  agent: {
    id: string;
    name: string;
    created: string;
    modified: string;
    createdTimestamp?: number;
    modifiedTimestamp?: number;
    lastOpenedTimestamp?: number;
    stepsCount?: number;
    version?: string;
  };
  onLoadAgent: (agentId: string) => void;
  onPreviewAgent: (agentId: string) => void;
  projectId?: string;
  onShare?: (agentId: string, agentRawName: string, agentDisplayName: string) => void;
}

const AgentCard: React.FC<AgentCardProps> = ({ agent, onLoadAgent, onPreviewAgent, projectId, onShare }) => {
  const { t } = useLanguage();
  const rawName = (agent.name || '').trim();
  const displayName = formatAgentSidebarLabel(rawName) || t('aiAgents.untitledAgent');

  const [hoverTooltip, setHoverTooltip] = useState<HoverTooltipState>({ visible: false });
  const hideTooltipTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [toast, setToast] = useState<ToastState>({ visible: false });
  const toastTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const formatTooltipText = useCallback((text: string): string => {
    const clean = (text || '').trim();
    if (!clean) return '';
    const idSuffixMatch = clean.match(/\s+([a-z]{1,4}\d{4,}(\s+[a-z]{1,4}\d{4,})*)\s*$/i);
    if (idSuffixMatch) {
      const idx = clean.indexOf(idSuffixMatch[1].trim());
      const primary = clean.slice(0, idx).trim();
      const suffix = idSuffixMatch[1].trim();
      return primary ? `${primary}\n${suffix}` : clean;
    }
    return clean;
  }, []);

  const showHoverTooltip = useCallback((el: HTMLElement, text: string) => {
    const clean = (text || '').trim();
    if (!clean) return;

    if (hideTooltipTimeoutRef.current) {
      clearTimeout(hideTooltipTimeoutRef.current);
      hideTooltipTimeoutRef.current = null;
    }

    const rect = el.getBoundingClientRect();
    const padding = 10;
    const desiredMaxWidth = 520;
    const gap = 10;

    const placement: 'above' | 'below' = rect.top < 120 ? 'below' : 'above';
    const top = placement === 'below' ? rect.bottom + gap : rect.top - gap;

    const left = Math.min(
      Math.max(padding, rect.left),
      window.innerWidth - desiredMaxWidth - padding
    );

    setHoverTooltip({
      visible: true,
      text: formatTooltipText(clean),
      copyText: clean,
      top,
      left,
      maxWidth: desiredMaxWidth,
      placement,
    });
  }, [formatTooltipText]);

  const hideHoverTooltip = useCallback(() => {
    if (hideTooltipTimeoutRef.current) {
      clearTimeout(hideTooltipTimeoutRef.current);
      hideTooltipTimeoutRef.current = null;
    }

    hideTooltipTimeoutRef.current = setTimeout(() => {
      setHoverTooltip({ visible: false });
      hideTooltipTimeoutRef.current = null;
    }, 2000);
  }, []);

  const showToast = useCallback((el: HTMLElement | null, text: string) => {
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = null;
    }

    const rect = el?.getBoundingClientRect?.();
    const top = rect ? rect.top - 10 : 24;
    const left = rect ? rect.left : 24;

    setToast({ visible: true, text, top, left });
    toastTimeoutRef.current = setTimeout(() => {
      setToast({ visible: false });
      toastTimeoutRef.current = null;
    }, 900);
  }, []);

  const formatRelativeTime = useCallback((timestampMs?: number): string | null => {
    if (!timestampMs || Number.isNaN(timestampMs) || timestampMs <= 0) return null;
    const now = Date.now();
    const diffMs = Math.max(0, now - timestampMs);
    const diffMinutes = Math.floor(diffMs / 60000);
    if (diffMinutes < 1) return t('aiAgents.timeJustNow');
    if (diffMinutes < 60) {
      return t('aiAgents.cardAgo', { time: t('aiAgents.timeMinutes', { n: diffMinutes }) });
    }
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) {
      return t('aiAgents.cardAgo', { time: t('aiAgents.timeHours', { n: diffHours }) });
    }
    const diffDays = Math.floor(diffHours / 24);
    return t('aiAgents.cardAgo', { time: t('aiAgents.timeDays', { n: diffDays }) });
  }, [t]);

  const modifiedAgo = formatRelativeTime(agent.modifiedTimestamp);
  const createdAgo = formatRelativeTime(agent.createdTimestamp);

  return (
    <div className="agent-card">
      <div className="agent-card-header">
        <h3
          className="agent-card-title"
          onMouseEnter={(e) => showHoverTooltip(e.currentTarget, displayName)}
          onMouseLeave={hideHoverTooltip}
          onClick={async (e) => {
            e.stopPropagation();
            const textToCopy = rawName || displayName;
            const anchorEl = e.currentTarget as HTMLElement;
            try {
              await navigator.clipboard.writeText(textToCopy);
              showToast(anchorEl, t('aiAgents.nameCopied'));
            } catch (err) {
              console.error('Failed to copy agent name:', err);
            }
          }}
          style={{ cursor: 'pointer' }}
        >
          {displayName}
        </h3>

        <div className="agent-card-actions">
          <button
            type="button"
            className="agent-icon-button agent-download-icon"
            onClick={async (e) => {
              e.stopPropagation();
              const btn = e.currentTarget;
              const original = btn.innerHTML;
              btn.innerHTML = '<span style="font-size:16px;">⏳</span>';
              try {
                if (!projectId) throw new Error('Missing project ID');
                const response = await fetch(`/api/projects/${projectId}/folders/AF/files/${agent.id}`);
                if (!response.ok) throw new Error('Failed to fetch agent data');
                const agentData = await response.json();
                const dataStr = JSON.stringify(agentData, null, 2);
                const blob = new Blob([dataStr], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${displayName.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'agent'}.json`;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                }, 0);
              } catch (err) {
                alert('Failed to download agent: ' + (err instanceof Error ? err.message : err));
              } finally {
                btn.innerHTML = original;
              }
            }}
            title={t('aiAgents.downloadAgentJson')}
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M10 3V15M10 15L5 10M10 15L15 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <rect x="3" y="17" width="14" height="2" rx="1" fill="currentColor" />
            </svg>
          </button>

          <button
            type="button"
            className="agent-icon-button"
            onClick={(e) => {
              e.stopPropagation();
              if (!onShare) {
                showToast(e.currentTarget as HTMLElement, t('aiAgents.shareUnavailable'));
                return;
              }
              onShare(agent.id, rawName || displayName, displayName);
            }}
            title={t('aiAgents.shareViaGmailTitle')}
          >
            <FaShareAlt />
          </button>

          <button
            type="button"
            className="agent-icon-button agent-preview-icon"
            onClick={(e) => {
              e.stopPropagation();
              onPreviewAgent(agent.id);
            }}
            title={t('aiAgents.previewAgentTitle')}
          >
            <FaEye />
          </button>
        </div>
      </div>

      <div className="agent-card-info">
        {modifiedAgo && (
          <div className="agent-info-item">
            <FaClock className="agent-info-icon" />
            <span className="agent-info-label">{t('aiAgents.cardModified')}</span>
            <span className="agent-info-value">{modifiedAgo}</span>
          </div>
        )}
        {createdAgo && (
          <div className="agent-info-item">
            <FaClock className="agent-info-icon" />
            <span className="agent-info-label">{t('aiAgents.cardCreated')}</span>
            <span className="agent-info-value">{createdAgo}</span>
          </div>
        )}
        {agent.version && (
          <div className="agent-info-item">
            <FaTag className="agent-info-icon" />
            <span className="agent-info-label">{t('aiAgents.cardVersion')}</span>
            <span className="agent-info-value">{agent.version}</span>
          </div>
        )}
      </div>

      <button
        className="load-agent-button"
        onClick={() => onLoadAgent(agent.id)}
      >
        <FaPlay /> {t('aiAgents.loadAgent')}
      </button>

      {hoverTooltip.visible &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              top: hoverTooltip.top,
              left: hoverTooltip.left,
              maxWidth: `${hoverTooltip.maxWidth}px`,
              transform: hoverTooltip.placement === 'above' ? 'translateY(-100%)' : undefined,
              backgroundColor: 'var(--alma-text)',
              color: 'var(--alma-on-accent)',
              padding: '8px 10px',
              borderRadius: '10px',
              fontSize: '12px',
              lineHeight: 1.35,
              zIndex: 100000,
              boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
              border: '1px solid rgba(255,255,255,0.12)',
              whiteSpace: 'pre-line',
              wordBreak: 'break-word',
              pointerEvents: 'auto',
            }}
            role="tooltip"
            onClick={async (e) => {
              e.stopPropagation();
              try {
                await navigator.clipboard.writeText(hoverTooltip.copyText);
                showToast(e.currentTarget as HTMLElement, t('aiAgents.nameCopied'));
              } catch (err) {
                console.error('Failed to copy tooltip text:', err);
              }
            }}
          >
            {hoverTooltip.text}
          </div>,
          document.body
        )}

      {toast.visible &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              top: toast.top,
              left: toast.left,
              backgroundColor: 'var(--alma-surface)',
              color: 'var(--alma-text)',
              padding: '6px 10px',
              borderRadius: '10px',
              fontSize: '12px',
              fontWeight: 700,
              zIndex: 100000,
              boxShadow: '0 10px 30px rgba(0,0,0,0.15)',
              border: '1px solid var(--alma-border)',
              pointerEvents: 'none',
            }}
            role="status"
            aria-live="polite"
          >
            {toast.text}
          </div>,
          document.body
        )}
    </div>
  );
};

const CreateNewAgentCard: React.FC<{ onClick: () => void; isCreating?: boolean }> = ({ onClick, isCreating = false }) => {
  const { t } = useLanguage();
  return (
    <div
      className={`create-agent-card ${isCreating ? 'creating' : ''}`}
      onClick={isCreating ? undefined : onClick}
      style={{ cursor: isCreating ? 'not-allowed' : 'pointer', opacity: isCreating ? 0.7 : 1 }}
      title={isCreating ? t('aiAgents.createCardTooltipCreating') : t('aiAgents.createCardTooltipIdle')}
    >
      {isCreating ? (
        <>
          <div className="create-icon creating-spinner">⏳</div>
          <h3 className="create-title">{t('aiAgents.createCardCreating')}</h3>
          <p className="create-subtitle">{t('aiAgents.createCardWait')}</p>
        </>
      ) : (
        <>
          <FaPlus className="create-icon" />
          <h3 className="create-title">{t('aiAgents.createCardNew')}</h3>
          <p className="create-subtitle">{t('aiAgents.createCardSubtitle')}</p>
        </>
      )}
    </div>
  );
};

const ImportAgentCard: React.FC<{ onClick: () => void }> = ({ onClick }) => {
  const { t } = useLanguage();
  return (
    <div className="import-agent-card" onClick={onClick} title={t('aiAgents.importCardTooltip')}>
      <FaUpload className="import-icon" />
      <h3 className="import-title">{t('aiAgents.importCardTitle')}</h3>
      <p className="import-subtitle">{t('aiAgents.importCardSubtitle')}</p>
    </div>
  );
};

const AIAssistCreateAgentCard: React.FC<{ onClick: () => void }> = ({ onClick }) => {
  const { t } = useLanguage();
  return (
    <div className="ai-assist-agent-card" onClick={onClick} title={t('aiAgents.aiAssistCardTooltip')}>
      <FaRobot className="ai-assist-icon" />
      <h3 className="ai-assist-title">{t('aiAgents.aiAssistCardTitle')}</h3>
      <p className="ai-assist-subtitle">{t('aiAgents.aiAssistCardSubtitle')}</p>
    </div>
  );
};

const ReportCreationCard: React.FC<{ onClick: () => void }> = ({ onClick }) => {
  const { t } = useLanguage();
  return (
    <div className="report-creation-card" onClick={onClick} title={t('aiAgents.reportCardTooltip')}>
      <svg className="report-creation-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M9 17H7V10H9V17ZM13 17H11V7H13V17ZM17 17H15V13H17V17ZM19 19H5V5H19V19ZM19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3Z" fill="currentColor" />
      </svg>
      <h3 className="report-creation-title">{t('aiAgents.reportCardTitle')}</h3>
      <p className="report-creation-subtitle">{t('aiAgents.reportCardSubtitle')}</p>
    </div>
  );
};

interface WarningDialogProps {
  isOpen: boolean;
  agentName: string;
  onSaveAndExit: () => void;
  onDiscardAndExit: () => void;
  onCancel: () => void;
}

const WarningDialog: React.FC<WarningDialogProps> = ({
  isOpen,
  agentName,
  onSaveAndExit,
  onDiscardAndExit,
  onCancel
}) => {
  const { t } = useLanguage();
  if (!isOpen) return null;

  return (
    <div className="warning-overlay">
      <div className="warning-dialog">
        <h3>{t('aiAgents.warningTitle')}</h3>
        <p>{t('aiAgents.warningLine1', { name: agentName })}</p>
        <p>{t('aiAgents.warningLine2')}</p>
        <div className="warning-buttons">
          <button className="warning-btn save" onClick={onSaveAndExit}>
            {t('aiAgents.warningSaveExit')}
          </button>
          <button className="warning-btn discard" onClick={onDiscardAndExit}>
            {t('aiAgents.warningDiscard')}
          </button>
          <button className="warning-btn cancel" onClick={onCancel}>
            {t('aiAgents.warningCancel')}
          </button>
        </div>
      </div>
    </div>
  );
};

interface AgentPreviewPopupProps {
  isOpen: boolean;
  agent: AgentData | null;
  onClose: () => void;
}

const AgentPreviewPopup: React.FC<AgentPreviewPopupProps> = ({ isOpen, agent, onClose }) => {
  const { t } = useLanguage();
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set([0]));
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setPortalContainer(document.body);
    }
  }, []);

  if (!isOpen || !agent || !portalContainer) return null;

  const rawName = (agent.name || '').trim();
  const displayName = formatAgentSidebarLabel(rawName) || t('aiAgents.untitledAgent');

  const toggleStepExpansion = (stepIndex: number) => {
    const newExpandedSteps = new Set(expandedSteps);
    if (newExpandedSteps.has(stepIndex)) {
      newExpandedSteps.delete(stepIndex);
    } else {
      newExpandedSteps.add(stepIndex);
    }
    setExpandedSteps(newExpandedSteps);
  };

  const getHealthStatus = () => {
    if (agent.metadata?.healingInfo) {
      if (agent.metadata.healingInfo.needsHealing) return 'error';
      if (agent.metadata.healingInfo.errors.length > 0 || agent.metadata.healingInfo.changes.length > 0) return 'warning';
    }
    return 'healthy';
  };

  const healthStatus = getHealthStatus();
  const healthLabels = {
    healthy: t('aiAgents.healthHealthy'),
    warning: t('aiAgents.healthMigrated'),
    error: t('aiAgents.healthNeedsHealing')
  };

  const popupContent = (
    <>
      <div className="popup-overlay" onClick={onClose} />
      <div className="agent-preview-popup">
        {}
        <div className="agent-preview-header">
          <h2 className="agent-preview-title">{displayName}</h2>
          <button className="agent-preview-close" onClick={onClose}>
            <FaTimes />
          </button>
        </div>

        {}
        <div className="agent-preview-content">
          <div className="agent-preview-grid">
            {}
            <div className="agent-health" style={{ gridColumn: '1 / -1', width: '100%' }}>
              <h3>{t('aiAgents.previewHealthTitle')}</h3>
              <div className="health-status">
                <div className="status-item">
                  <span className="status-label">{t('aiAgents.previewAgentStatus')}</span>
                  <span className={`status-badge ${healthStatus}`}>
                    {healthLabels[healthStatus]}
                  </span>
                </div>
                {agent.metadata?.healingInfo && (
                  <>
                    {agent.metadata.healingInfo.errors.length > 0 && (
                      <div className="status-item">
                        <span className="status-label">{t('aiAgents.previewErrorsFixed')}</span>
                        <span className="status-badge error">
                          {t('aiAgents.previewIssues', { n: agent.metadata.healingInfo.errors.length })}
                        </span>
                      </div>
                    )}
                    {agent.metadata.healingInfo.changes.length > 0 && (
                      <div className="status-item">
                        <span className="status-label">{t('aiAgents.previewChangesApplied')}</span>
                        <span className="status-badge warning">
                          {t('aiAgents.previewUpdates', { n: agent.metadata.healingInfo.changes.length })}
                        </span>
                      </div>
                    )}
                  </>
                )}
                <div className="status-item">
                  <span className="status-label">{t('aiAgents.previewConfiguration')}</span>
                  <span className="status-badge healthy">
                    {t('aiAgents.previewValid')}
                  </span>
                </div>
              </div>
            </div>

            {}
            <div className="agent-details">
              <h3>{t('aiAgents.previewWorkflowSteps', { n: agent.layers.length })}</h3>
              <div className="steps-accordion">
                {agent.layers.map((step, index) => (
                  <div key={step.id} className={`step-accordion-item ${expandedSteps.has(index) ? 'expanded' : ''}`}>
                    {}
                    <div
                      className="step-accordion-header"
                      onClick={() => toggleStepExpansion(index)}
                    >
                      <div className="step-header-content">
                        <div className="step-number">{index + 1}</div>
                        <div className="step-info">
                          <div className="step-name">{step.name}</div>
                          <div className="step-model">{step.selectedModel || t('aiAgents.previewNoModel')}</div>
                        </div>
                      </div>
                      <div className={`expand-icon ${expandedSteps.has(index) ? 'expanded' : ''}`}>
                        ▼
                      </div>
                    </div>

                    {}
                    {expandedSteps.has(index) && (
                      <div className="step-accordion-content">
                        {step.selectedModel && (
                          <div className="detail-section">
                            <h4>{t('aiAgents.previewModelConfig')}</h4>
                            <div className="detail-content">{step.selectedModel}</div>
                            <div className="detail-tags">
                              <span className="detail-tag">{t('aiAgents.previewAiModel')}</span>
                            </div>
                          </div>
                        )}

                        {step.systemInstruction && (
                          <div className="detail-section">
                            <h4>{t('aiAgents.previewSystemInstruction')}</h4>
                            <div className="detail-content">{step.systemInstruction}</div>
                            <div className="detail-tags">
                              <span className="detail-tag">{t('aiAgents.previewSystemPrompt')}</span>
                            </div>
                          </div>
                        )}

                        {step.userInput && (
                          <div className="detail-section">
                            <h4>{t('aiAgents.previewUserInput')}</h4>
                            <div className="detail-content">{step.userInput}</div>
                            <div className="detail-tags">
                              <span className="detail-tag">{t('aiAgents.previewUserPrompt')}</span>
                            </div>
                          </div>
                        )}

                        {step.referencedSteps && step.referencedSteps.length > 0 && (
                          <div className="detail-section">
                            <h4>{t('aiAgents.previewReferencedSteps')}</h4>
                            <div className="detail-content">{step.referencedSteps.join(', ')}</div>
                            <div className="detail-tags">
                              <span className="detail-tag">{t('aiAgents.previewDependencies')}</span>
                            </div>
                          </div>
                        )}

                        {step.collection && (
                          <div className="detail-section">
                            <h4>{t('aiAgents.previewCollection')}</h4>
                            <div className="detail-content">{t('aiAgents.previewCollectionValue', { n: step.collection })}</div>
                            <div className="detail-tags">
                              <span className="detail-tag">{t('aiAgents.previewKnowledgeBase')}</span>
                            </div>
                          </div>
                        )}

                        {step.imageUrls && step.imageUrls.length > 0 && (
                          <div className="detail-section">
                            <h4>{t('aiAgents.previewAttachedImages')}</h4>
                            <div className="detail-content">{t('aiAgents.previewImagesAttached', { n: step.imageUrls.length })}</div>
                            <div className="detail-tags">
                              <span className="detail-tag">{t('aiAgents.previewMediaTag')}</span>
                            </div>
                          </div>
                        )}

                        {step.urlContent && step.urlContent.length > 0 && (
                          <div className="detail-section">
                            <h4>{t('aiAgents.previewUrlContent')}</h4>
                            <div className="detail-content">{t('aiAgents.previewUrlsReferenced', { n: step.urlContent.length })}</div>
                            <div className="detail-tags">
                              <span className="detail-tag">{t('aiAgents.previewExternalContent')}</span>
                            </div>
                          </div>
                        )}

                        {!step.systemInstruction && !step.userInput && !step.referencedSteps?.length && !step.collection && !step.imageUrls?.length && !step.urlContent?.length && (
                          <div className="detail-section">
                            <h4>{t('aiAgents.previewConfigSection')}</h4>
                            <div className="detail-content">{t('aiAgents.previewNoAdditionalConfig')}</div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );

  return createPortal(popupContent, portalContainer);
};

const AIAgentsDashboard: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const { projectFolder, projectStateHydrated } = useProjectState();
  const { session, status: sessionStatus } = useSharedSession();
  const { signalPageReady, signalPageNotReady } = usePageReady();
  const { t } = useLanguage();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [currentAgent, setCurrentAgent] = useState<AgentData | null>(null);
  const [showWarning, setShowWarning] = useState(false);
  const [agentName] = useState('');
  const [agents, setAgents] = useState<DashboardAgent[]>([]);
  const [isLoadingAgents, setIsLoadingAgents] = useState(true);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [isLoadingFromRemote, setIsLoadingFromRemote] = useState(false);
  const [loadingPhase, setLoadingPhase] = useState(() => t('aiAgents.phaseInitializing'));
  const [lastCacheTime, setLastCacheTime] = useState<string | null>(null);

  const [showPreview, setShowPreview] = useState(false);
  const [previewAgent, setPreviewAgent] = useState<AgentData | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [loadingAgentName, setLoadingAgentName] = useState<string>('');

  const [sortColumn, setSortColumn] = useState<'name' | 'createdDate' | 'updatedDate' | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  const [viewMode, _setViewMode] = useState<'cards' | 'table'>('table');
  const [relativeNowMs, setRelativeNowMs] = useState(Date.now());

  const formatTimeAgoDetailed = useCallback(
    (timestampMs: number | undefined, nowMs: number): string | null => {
      if (!timestampMs || Number.isNaN(timestampMs) || timestampMs <= 0) return null;
      const diffMs = Math.max(0, nowMs - timestampMs);
      const oneHourMs = 60 * 60 * 1000;
      const oneDayMs = 24 * oneHourMs;

      if (diffMs >= oneDayMs) {
        const days = Math.ceil(diffMs / oneDayMs);
        return t('aiAgents.timeDays', { n: days });
      } else {
        const hours = Math.ceil(diffMs / oneHourMs);
        return t('aiAgents.timeHours', { n: hours });
      }
    },
    [t]
  );

  const [tableHoverTooltip, setTableHoverTooltip] = useState<HoverTooltipState>({ visible: false });
  const hideTableTooltipTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [tableToast, setTableToast] = useState<ToastState>({ visible: false });
  const tableToastTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (viewMode !== 'table') return;
    const timer = window.setInterval(() => {
      setRelativeNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [viewMode]);

  const showTableHoverTooltip = useCallback((el: HTMLElement, text: string) => {
    const clean = (text || '').trim();
    if (!clean) return;

    if (hideTableTooltipTimeoutRef.current) {
      clearTimeout(hideTableTooltipTimeoutRef.current);
      hideTableTooltipTimeoutRef.current = null;
    }

    const rect = el.getBoundingClientRect();
    const padding = 10;
    const desiredMaxWidth = 560;
    const gap = 10;

    const placement: 'above' | 'below' = rect.top < 120 ? 'below' : 'above';
    const top = placement === 'below' ? rect.bottom + gap : rect.top - gap;

    const left = Math.min(
      Math.max(padding, rect.left),
      window.innerWidth - desiredMaxWidth - padding
    );

    setTableHoverTooltip({
      visible: true,
      text: clean,
      copyText: clean,
      top,
      left,
      maxWidth: desiredMaxWidth,
      placement,
    });
  }, []);

  const hideTableHoverTooltip = useCallback(() => {
    if (hideTableTooltipTimeoutRef.current) {
      clearTimeout(hideTableTooltipTimeoutRef.current);
      hideTableTooltipTimeoutRef.current = null;
    }

    hideTableTooltipTimeoutRef.current = setTimeout(() => {
      setTableHoverTooltip({ visible: false });
      hideTableTooltipTimeoutRef.current = null;
    }, 2000);
  }, []);

  const showTableToast = useCallback((el: HTMLElement, text: string) => {
    if (tableToastTimeoutRef.current) {
      clearTimeout(tableToastTimeoutRef.current);
      tableToastTimeoutRef.current = null;
    }

    const rect = el?.getBoundingClientRect?.();
    const top = rect.top - 10;
    const left = rect.left;

    setTableToast({ visible: true, text, top, left });
    tableToastTimeoutRef.current = setTimeout(() => {
      setTableToast({ visible: false });
      tableToastTimeoutRef.current = null;
    }, 900);
  }, []);

  const exportAgentJson = useCallback(async (agentId: string, agentName: string) => {
    if (!projectFolder?.projectId) {
      throw new Error('Missing project ID');
    }
    const response = await fetch(`/api/projects/${projectFolder.projectId}/folders/AF/files/${agentId}`);
    if (!response.ok) throw new Error('Failed to fetch agent data');
    const agentData = await response.json();
    const dataStr = JSON.stringify(agentData, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${agentName.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'agent'}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
  }, [projectFolder?.projectId]);

  const [shareModal, setShareModal] = useState<ShareModalState>({ open: false });

  const openShareModal = useCallback(async (agentId: string, agentRawName: string, agentDisplayName: string) => {
    setShareModal({
      open: true,
      agentId,
      agentRawName,
      agentDisplayName,
      loading: true,
      jsonText: '',
      to: '',
      subject: `Agent Corpus: ${agentDisplayName}`,
      message:
        `Hi,\n\nSharing an agent with you.\n\nAgent name: ${agentRawName || agentDisplayName}\n\nNotes:\n- This will be sent directly from your Gmail account.\n- The agent Corpus will be attached as a .json file.\n`,
    });

    try {
      if (!projectFolder?.projectId) throw new Error('Missing project ID');
      const response = await fetch(`/api/projects/${projectFolder.projectId}/folders/AF/files/${agentId}`);
      if (!response.ok) throw new Error('Failed to fetch agent data');
      const agentData = await response.json();
      const jsonText = JSON.stringify(agentData, null, 2);
      setShareModal((prev) =>
        prev.open
          ? {
            ...prev,
            loading: false,
            jsonText,
          }
          : prev
      );
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
          : prev
      );
    }
  }, [projectFolder?.projectId]);

  const closeShareModal = useCallback(() => {
    setShareModal({ open: false });
  }, []);

  const sendEmailNow = useCallback(async () => {
    if (!shareModal.open) return;

    const to = (shareModal.to || '').trim();
    const subject = (shareModal.subject || '').trim();
    const message = (shareModal.message || '').trim();

    if (!to) {
      alert('Please enter at least one recipient email in "To".');
      return;
    }
    if (!subject) {
      alert('Subject cannot be empty.');
      return;
    }
    if (!shareModal.jsonText) {
      alert('Agent Corpus is not ready yet.');
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
        const msg = data?.error || 'Failed to send email';
        alert(msg);
        return;
      }

      alert('Email sent.');
      closeShareModal();
    } catch (err) {
      console.error('Failed to send email:', err);
      alert('Failed to send email.');
    }
  }, [closeShareModal, shareModal]);

  const [showMissingFoldersModal, setShowMissingFoldersModal] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [missingFolders, setMissingFolders] = useState<string[]>([]);

  const [isCreatingAgent, setIsCreatingAgent] = useState(false);
  const [showAgentNameModal, setShowAgentNameModal] = useState(false);
  const [showAIAssistModal, setShowAIAssistModal] = useState(false);
  const [showReportCreationModal, setShowReportCreationModal] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const [vantaEffect, setVantaEffect] = useState<VantaEffect | null>(null);
  const [scriptsReady, setScriptsReady] = useState(false);
  const [loadingState, setLoadingState] = useState<'idle' | 'loading-three' | 'loading-vanta' | 'ready' | 'error'>('idle');
  const vantaRef = useRef<HTMLDivElement>(null);
  const hasInitializedRef = useRef<string | null>(null);
  const agentsFetchInFlightRef = useRef(false);
  const lastDashboardDebugLogRef = useRef<number>(0);
  const DASHBOARD_DEBUG_LOG_INTERVAL_MS = 60 * 1000;
  const AGENTS_LOAD_STUCK_RESET_MS = 10_000;

  const CACHE_TTL = 5 * 60 * 1000;
  const getCacheKey = (projectId: string) => `agents_cache_${projectId}`;

  const getCachedAgents = (projectId: string): { agents: DashboardAgent[], timestamp: number } | null => {
    try {
      const cacheKey = getCacheKey(projectId);
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const parsedCache = JSON.parse(cached);
        const now = Date.now();
        if (now - parsedCache.timestamp < CACHE_TTL) {
          console.log('💾 Using cached agents data');
          return parsedCache;
        } else {
          console.log('🕰️ Cache expired, removing old data');
          localStorage.removeItem(cacheKey);
        }
      }
    } catch (error) {
      console.error('Error reading cache:', error);
    }
    return null;
  };

  const setCachedAgents = (projectId: string, agents: DashboardAgent[]) => {
    try {
      const cacheKey = getCacheKey(projectId);
      const cacheData = {
        agents,
        timestamp: Date.now()
      };
      localStorage.setItem(cacheKey, JSON.stringify(cacheData));
      setLastCacheTime(new Date().toLocaleTimeString());
      console.log('💾 Agents data cached successfully');
    } catch (error) {
      console.error('Error caching agents:', error);
    }
  };

  const clearCache = (projectId?: string) => {
    try {
      if (projectId) {
        localStorage.removeItem(getCacheKey(projectId));
        console.log('🗑️ Cache cleared for project:', projectId);
      } else {
        Object.keys(localStorage).forEach(key => {
          if (key.startsWith('agents_cache_')) {
            localStorage.removeItem(key);
          }
        });
        console.log('🗑️ All agent caches cleared');
      }
      setLastCacheTime(null);
    } catch (error) {
      console.error('Error clearing cache:', error);
    }
  };

  const loadAgentsData = useCallback(async (forceRemote = false) => {
    if (!projectFolder?.projectId) {
      setAgents([]);
      setAgentsError(t('aiAgents.errorNoProject'));
      setLastCacheTime(null);
      setIsLoadingAgents(false);
      setIsLoadingFromRemote(false);
      return;
    }

    if (agentsFetchInFlightRef.current && !forceRemote) {
      console.log('🛡️ Agent fetch already in flight, skipping duplicate call');
      return;
    }

    console.log(`📥 Starting to load agents for project: ${projectFolder.folderName} (${projectFolder.projectId})`);

    if (!forceRemote) {
      const cachedData = getCachedAgents(projectFolder.projectId);
      if (cachedData) {
        setAgents(cachedData.agents);
        setAgentsError(null);
        setLastCacheTime(new Date(cachedData.timestamp).toLocaleTimeString());
        setIsLoadingAgents(false);
        setIsLoadingFromRemote(false);
        console.log(`⚡ Loaded ${cachedData.agents.length} agents from cache instantly`);
        return;
      }
    }

    agentsFetchInFlightRef.current = true;
    if (forceRemote) {
      setIsLoadingFromRemote(true);
      setLoadingPhase(t('aiAgents.phaseRefreshingServer'));
      console.log('🌐 Force loading from remote...');
    } else {
      setIsLoadingAgents(true);
      setLoadingPhase(t('aiAgents.phaseFindingFolders'));
    }
    setAgentsError(null);

    try {
      const loadTimeoutMs = AGENT_FILES_FETCH_TIMEOUT_MS + 5_000;
      setLoadingPhase(t('aiAgents.phaseLoadingFiles'));
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`Loading timeout after ${loadTimeoutMs / 1000} seconds`)),
          loadTimeoutMs
        );
      });

      const agentFiles = await Promise.race([
        fetchAgentFiles(projectFolder.projectId),
        timeoutPromise
      ]);

      const dashboardAgents: DashboardAgent[] = agentFiles.map(file => {
        const createdDate = new Date(file.createdAt);
        const modifiedDate = new Date(file.updatedAt);

        const createdTimestamp = isNaN(createdDate.getTime()) ? 0 : createdDate.getTime();
        const modifiedTimestamp = isNaN(modifiedDate.getTime()) ? 0 : modifiedDate.getTime();

        if (agentFiles.indexOf(file) < 2) {
          const rawName = (file.name || '').trim();
          const cleanedName = rawName
            .replace(/[_-]+/g, ' ')
            .replace(/[^a-zA-Z0-9 ]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          const splitName = cleanedName ? cleanedName.split(/\s+(?:\d{13,}\b|\d{4}\b)/)[0] : '';
          const withoutFilesearch = splitName.replace(/\bfilesearch\b/gi, '').replace(/\s+/g, ' ').trim();
          const displayName = withoutFilesearch || t('aiAgents.untitledAgent');

          console.log('📅 Date parsing debug:', {
            name: displayName,
            createdAt: file.createdAt,
            createdDate: createdDate.toString(),
            createdTimestamp,
            updatedAt: file.updatedAt,
            modifiedDate: modifiedDate.toString(),
            modifiedTimestamp
          });
        }

        return {
          id: file.id,
          name: file.name,
          created: createdDate.toLocaleString(),
          modified: modifiedDate.toLocaleString(),
          createdTimestamp,
          modifiedTimestamp
        };
      });

      console.log(`✅ Loaded ${dashboardAgents.length} agents for project ${projectFolder.folderName}`);
      setAgents(dashboardAgents);

      setCachedAgents(projectFolder.projectId, dashboardAgents);

      setAgentsError(null);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to load agents';

      if (errorMessage.includes('timeout')) {
        console.warn('⏱️ Agent load timed out, will retry:', errorMessage);
        setAgentsError(t('aiAgents.errorTimeoutRetry'));

        console.log('🔄 Auto-retrying after timeout...');
        setLoadingPhase(t('aiAgents.phaseRetrying'));
        try {
          const retryTimeoutMs = AGENT_FILES_FETCH_TIMEOUT_MS + 10_000;
          const retryTimeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error(`Retry timeout after ${retryTimeoutMs / 1000} seconds`)),
              retryTimeoutMs
            );
          });

          const retryAgentFiles = await Promise.race([
            fetchAgentFiles(projectFolder.projectId),
            retryTimeoutPromise
          ]);

          const retryDashboardAgents: DashboardAgent[] = retryAgentFiles.map(file => {
            const createdDate = new Date(file.createdAt);
            const modifiedDate = new Date(file.updatedAt);

            const createdTimestamp = isNaN(createdDate.getTime()) ? 0 : createdDate.getTime();
            const modifiedTimestamp = isNaN(modifiedDate.getTime()) ? 0 : modifiedDate.getTime();

            return {
              id: file.id,
              name: file.name,
              created: createdDate.toLocaleString(),
              modified: modifiedDate.toLocaleString(),
              createdTimestamp,
              modifiedTimestamp
            };
          });

          console.log(`✅ Retry successful! Loaded ${retryDashboardAgents.length} agents`);
          setAgents(retryDashboardAgents);
          setCachedAgents(projectFolder.projectId, retryDashboardAgents);
          setAgentsError(null);

        } catch (retryError) {
          console.error('❌ Retry also failed:', retryError);
          const retryErrorMessage = retryError instanceof Error ? retryError.message : 'Retry failed';
          if (retryErrorMessage.includes('timeout')) {
            setAgentsError(t('aiAgents.errorSlowConnection'));
          } else {
            setAgentsError(t('aiAgents.errorLoadingFailed', { message: retryErrorMessage }));
          }
        }
      } else {
        console.error('❌ Error loading agents:', error);
        setAgentsError(t('aiAgents.errorLoadingFailed', { message: errorMessage }));
      }
    } finally {
      agentsFetchInFlightRef.current = false;
      console.log('🏁 Finished loading agents, setting loading states = false');
      setIsLoadingAgents(false);
      setIsLoadingFromRemote(false);
    }
  }, [projectFolder?.projectId, projectFolder?.folderName, t]);

  useEffect(() => {
    const handleInvalidate = () => {
      console.log('🔄 Agents cache invalidated event received, reloading agents...');
      loadAgentsData(true);
    };
    window.addEventListener('agents-cache-invalidated', handleInvalidate);
    return () => {
      window.removeEventListener('agents-cache-invalidated', handleInvalidate);
    };
  }, [loadAgentsData]);

  // Resolve missing agent versions in a single batched request instead of one
  // full-file Drive download per card (avoids an N+1 fetch on the listing page).
  useEffect(() => {
    if (!session?.accessToken) return;
    const missingIds = agents.filter((a) => a.version === undefined).map((a) => a.id);
    if (missingIds.length === 0) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai-agents/versions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: missingIds }),
        });
        if (!res.ok || cancelled) return;
        const { versions } = (await res.json()) as { versions: Record<string, string | null> };
        if (cancelled) return;
        // Use '' (not undefined) for "resolved, file has no version" so these
        // agents are not re-queued on the next render — avoids a refetch loop.
        setAgents((prev) =>
          prev.map((a) =>
            a.version === undefined && a.id in versions
              ? { ...a, version: versions[a.id] ?? '' }
              : a
          )
        );
      } catch {
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [agents, session?.accessToken]);

  const resetLoadingState = useCallback(() => {
    console.log('🔄 Auto-unsticking loading state');
    agentsFetchInFlightRef.current = false;
    setIsLoadingAgents(false);
    setIsLoadingFromRemote(false);
    setAgentsError(null);
    setLoadingPhase(t('aiAgents.phaseInitializing'));
    hasInitializedRef.current = null;

    console.log('✅ Loading state automatically reset');
  }, [t]);

  const loadFromRemote = useCallback(() => {
    if (projectFolder?.projectId) {
      console.log('🌐 User requested remote refresh');
      clearCache(projectFolder.projectId);
      loadAgentsData(true);
    }
  }, [projectFolder?.projectId, loadAgentsData]);

  useEffect(() => {
    if (isLoadingAgents || isLoadingFromRemote) {
      const timeoutId = setTimeout(() => {
        console.warn(`⚠️ Loading state stuck, auto-resetting after ${AGENTS_LOAD_STUCK_RESET_MS / 1000}s...`);
        resetLoadingState();
      }, AGENTS_LOAD_STUCK_RESET_MS);

      return () => clearTimeout(timeoutId);
    }
  }, [isLoadingAgents, isLoadingFromRemote, resetLoadingState]);

  useEffect(() => {
    const initializeAgents = async () => {
      if (!projectFolder?.projectId) {
        hasInitializedRef.current = null;
        signalPageReady();
        return;
      }

      const isInitialLoad = hasInitializedRef.current !== projectFolder.projectId;

      if (isInitialLoad) {
        signalPageNotReady();

        try {
          await loadAgentsData();
          hasInitializedRef.current = projectFolder.projectId;
        } catch (error) {
          console.error('Failed to initialize agents:', error);
        }

        signalPageReady();
      }
    };

    initializeAgents();
  }, [projectFolder?.projectId, loadAgentsData]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const cacheKeys = Object.keys(localStorage).filter(key => key.startsWith('agents_cache_'));
      console.log(`📊 Cache Status: ${cacheKeys.length} projects cached`);
    }
  }, [agents]);

  const loadVantaScripts = React.useCallback(async (): Promise<void> => {
    if (loadingState !== 'idle') return;

    setLoadingState('loading-three');
    console.log('🔄 Starting dependency chain loading...');

    try {
      await new Promise<void>((resolve, reject) => {
        if (window.THREE) {
          console.log('✅ Three.js already loaded');
          resolve();
          return;
        }

        const threeScript = document.createElement('script');
        threeScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r134/three.min.js';
        threeScript.onload = () => {
          if (window.THREE) {
            console.log('✅ Three.js loaded and verified');
            resolve();
          } else {
            reject(new Error('Three.js loaded but not available on window'));
          }
        };
        threeScript.onerror = () => reject(new Error('Failed to load Three.js'));
        document.head.appendChild(threeScript);
      });

      setLoadingState('loading-vanta');

      await new Promise<void>((resolve, reject) => {
        if (window.VANTA?.CLOUDS) {
          console.log('✅ Vanta CLOUDS already loaded');
          resolve();
          return;
        }

        const vantaScript = document.createElement('script');
        vantaScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/vanta/0.5.24/vanta.clouds.min.js';
        vantaScript.onload = () => {
          if (window.VANTA?.CLOUDS) {
            console.log('✅ Vanta CLOUDS loaded and verified');
            resolve();
          } else {
            reject(new Error('Vanta script loaded but CLOUDS not available'));
          }
        };
        vantaScript.onerror = () => reject(new Error('Failed to load Vanta CLOUDS'));
        document.head.appendChild(vantaScript);
      });

      setLoadingState('ready');
      setScriptsReady(true);
      console.log('✅ All dependencies loaded successfully');

    } catch (error) {
      console.error('❌ Dependency loading failed:', error);
      setLoadingState('error');
    }
  }, [loadingState]);

  useEffect(() => {
    loadVantaScripts();
  }, [loadVantaScripts]);

  useEffect(() => {
    if (scriptsReady && vantaRef.current && !vantaEffect && loadingState === 'ready') {
      try {
        const effect = window.VANTA!.CLOUDS({
          el: vantaRef.current,
          mouseControls: true,
          touchControls: true,
          gyroControls: false,
          minHeight: 200.00,
          minWidth: 200.00,
          backgroundColor: 0xffffff,
          skyColor: 0x68b8d7,
          cloudColor: 0xadc1de,
          cloudShadowColor: 0x183550,
          sunColor: 0xff9919,
          sunGlareColor: 0xff6633,
          sunlightColor: 0xff9933,
          speed: 1
        });
        setVantaEffect(effect);
        console.log('✅ Vanta CLOUDS effect initialized successfully');
      } catch (error) {
        console.error('❌ Failed to initialize Vanta CLOUDS effect:', error);
        setLoadingState('error');
      }
    }
  }, [scriptsReady, vantaEffect, loadingState]);

  useEffect(() => {
    return () => {
      if (vantaEffect) {
        vantaEffect.destroy();
        console.log('🧹 Vanta CLOUDS effect cleaned up');
      }
    };
  }, [vantaEffect]);

  const handleCreateNewAgent = () => {
    if (!projectFolder?.projectId) {
      alert('Please select a project folder before creating an agent.');
      return;
    }

    if (!session?.accessToken) {
      alert('Please sign in to create an agent.');
      return;
    }

    setShowAgentNameModal(true);
  };

  const handleCreateAgentWithName = async (agentName: string) => {
    setIsCreatingAgent(true);

    try {
      const { createAgent } = await import('../lib/versionUtils');
      const { createDefaultAgent } = await import('../lib/agentLayer');

      const defaultAgent = createDefaultAgent(agentName);

      console.log(`🚀 Creating agent: ${agentName}`);
      const result = await createAgent(projectFolder!.projectId, agentName, defaultAgent);

      if (result.success && result.fileId) {
        console.log(`✅ Agent "${agentName}" created successfully, opening for editing`);
        if (projectFolder?.projectId) {
          clearCache(projectFolder.projectId);
        }
        router.push(`/ai-agents/edit/${encodeURIComponent(result.fileId)}`);
      } else if (result.success && result.fileName) {
        console.warn('Agent created but no fileId returned, trying fileName as fallback');
        if (projectFolder?.projectId) {
          clearCache(projectFolder.projectId);
        }
        router.push(`/ai-agents/edit/${encodeURIComponent(result.fileName)}`);
      } else {
        throw new Error(result.error || 'Failed to create agent');
      }

    } catch (error) {
      console.error('Failed to create agent:', error);
      alert(`Failed to create agent: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsCreatingAgent(false);
    }
  };

  const handleImportAgent = () => {
    fileInputRef.current?.click();
  };

  const handleAIAssistCreateAgent = () => {
    if (!projectFolder?.projectId) {
      alert('Please select a project folder before creating an agent.');
      return;
    }
    if (!session?.accessToken) {
      alert('Please sign in to create an agent.');
      return;
    }
    setShowAIAssistModal(true);
  };

  const handleReportCreation = () => {
    if (!projectFolder?.projectId) {
      alert('Please select a project folder before creating an agent.');
      return;
    }
    if (!session?.accessToken) {
      alert('Please sign in to create an agent.');
      return;
    }
    setShowReportCreationModal(true);
  };

  const tryOpenSct272ReportModal = useCallback(() => {
    if (!projectStateHydrated) return;
    if (sessionStatus === 'loading') return;
    if (!projectFolder?.projectId) {
      alert('Please select a project folder before creating an agent.');
      return;
    }
    if (!session?.accessToken) {
      alert('Please sign in to create an agent.');
      return;
    }
    setShowReportCreationModal(true);
  }, [
    projectStateHydrated,
    sessionStatus,
    projectFolder?.projectId,
    session?.accessToken,
  ]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const legacy = new URLSearchParams(window.location.search).get('reportCreation');
      if (legacy === '1' && pathname === '/ai-agents') {
        router.replace('/SCT272', { scroll: false });
        return;
      }
      if (legacy === '1' && isSct272Pathname(pathname)) {
        router.replace('/SCT272', { scroll: false });
        return;
      }
    }
    if (!isSct272Pathname(pathname)) return;
    const timer = window.setTimeout(() => {
      tryOpenSct272ReportModal();
    }, 0);
    return () => clearTimeout(timer);
  }, [pathname, router, tryOpenSct272ReportModal]);

  useEffect(() => {
    if (!isSct272Pathname(pathname)) return;
    const onReopen = () => {
      tryOpenSct272ReportModal();
    };
    window.addEventListener(SCT272_REOPEN_EVENT, onReopen);
    return () => window.removeEventListener(SCT272_REOPEN_EVENT, onReopen);
  }, [pathname, tryOpenSct272ReportModal]);

  const handleFileImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!projectFolder?.projectId) {
      alert('No project selected');
      return;
    }

    if (!session?.accessToken) {
      alert('Not authenticated');
      return;
    }

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch(`/api/projects/${projectFolder.projectId}/folders/AF/files`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.accessToken}`
        },
        body: formData
      });

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
      }

      console.log(`✅ Agent "${file.name}" uploaded successfully to AF folder`);

      loadAgentsData(true);

    } catch (error) {
      console.error('Upload error:', error);
      alert(`Failed to upload: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    if (event.target) event.target.value = '';
  };

  const handleLoadAgent = async (agentId: string) => {
    if (projectFolder?.projectId) {
      recordAgentOpened(agentId, projectFolder.projectId);
    }

    setTimeout(() => {
      router.push(`/ai-agents/edit/${agentId}`);
    }, 100);
  };

  const handlePreviewAgent = async (agentId: string) => {
    const agent = agents.find(a => a.id === agentId);
    const rawName = (agent?.name || 'Agent').trim();

    const cleanedName = rawName
      .replace(/[_-]+/g, ' ')
      .replace(/[^a-zA-Z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const splitName = cleanedName ? cleanedName.split(/\s+(?:\d{13,}\b|\d{4}\b)/)[0] : '';
    const withoutFilesearch = splitName.replace(/\bfilesearch\b/gi, '').replace(/\s+/g, ' ').trim();
    const displayName = withoutFilesearch || 'Agent';

    setLoadingAgentName(displayName);
    setIsLoadingPreview(true);

    if (!projectFolder?.projectId) {
      alert('No project selected');
      setIsLoadingPreview(false);
      return;
    }

    if (!session?.accessToken) {
      alert('Not authenticated');
      setIsLoadingPreview(false);
      return;
    }

    try {
      const response = await fetch(`/api/projects/${projectFolder.projectId}/folders/AF/files/${agentId}`, {
        mode: 'cors',
        headers: {
          'Authorization': `Bearer ${session.accessToken}`
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch agent data: ${response.status} ${response.statusText}`);
      }

      const agentData = await response.json();

      const { isVersionedAgent, getCurrentVersionLayers } = await import('../lib/versionUtils');

      let agentToPreview;

      if (isVersionedAgent(agentData)) {
        const currentLayers = getCurrentVersionLayers(agentData);
        agentToPreview = {
          name: agentData.agentName,
          layers: currentLayers,
          metadata: {
            ...agentData.metadata,
            currentVersion: agentData.currentVersion,
            totalVersions: agentData.totalVersions
          }
        };

      } else {
        agentToPreview = agentData;
      }

      const { agent: migratedAgent, changes, errors, needsHealing } = migrateAgent(agentToPreview);

      if (needsHealing) {
        migratedAgent.metadata = {
          ...migratedAgent.metadata,
          healingInfo: {
            needsHealing,
            changes,
            errors,
            originalVersion: agentToPreview.version || "1.0"
          }
        };
      }

      setPreviewAgent(migratedAgent);

    } catch (error) {
      console.error('Error loading agent for preview:', error);
      alert(`Failed to load agent preview: ${error instanceof Error ? error.message : String(error)}`);
      setIsLoadingPreview(false);
    }
  };

  const handleSaveAgent = async () => {
    if (!currentAgent || !projectFolder?.projectId) {
      alert('No agent or project selected');
      return;
    }

    try {
      const { saveAgentWithVersioning } = await import('../lib/versionUtils');

      const timestamp = new Date().toISOString();
      const agentToSave = {
        ...currentAgent,
        name: agentName,
        metadata: {
          ...currentAgent.metadata,
          modified: timestamp
        }
      };

      const result = await saveAgentWithVersioning(projectFolder.projectId, agentName, agentToSave);

      if (result.success) {
        try {
          await loadAgentsData();
          console.log('✅ Agents list refreshed after save');
        } catch (refreshError) {
          console.error('Error refreshing agents list:', refreshError);
        }
      } else {
        throw new Error(result.error || 'Save failed');
      }

    } catch (error) {
      console.error('Save failed:', error);
      alert(`Save error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleSaveAndExit = () => {
    console.log('💾 handleSaveAndExit called');
    handleSaveAgent();
    setShowWarning(false);
    setIsModalOpen(false);
    setCurrentAgent(null);
  };

  const handleDiscardAndExit = () => {
    console.log('🗑️ handleDiscardAndExit called');
    setShowWarning(false);
    setIsModalOpen(false);
    setCurrentAgent(null);

  };

  const handleCancelExit = () => {
    console.log('❌ handleCancelExit called');
    setShowWarning(false);
  };

  const handleSort = (column: 'name' | 'createdDate' | 'updatedDate') => {
    if (sortColumn === column) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const sortedAgents = React.useMemo(() => {
    if (!sortColumn) {
      const lastOpenedIndex =
        projectFolder?.projectId ? getAgentLastOpenedIndexForProject(projectFolder.projectId) : {};

      return [...agents].sort((a, b) => {
        const aLastOpened = lastOpenedIndex[a.id] ?? 0;
        const bLastOpened = lastOpenedIndex[b.id] ?? 0;

        const aActivity = Math.max(aLastOpened, a.modifiedTimestamp || 0, a.createdTimestamp || 0);
        const bActivity = Math.max(bLastOpened, b.modifiedTimestamp || 0, b.createdTimestamp || 0);

        if (bActivity !== aActivity) return bActivity - aActivity;

        if (bLastOpened !== aLastOpened) return bLastOpened - aLastOpened;
        if ((b.modifiedTimestamp || 0) !== (a.modifiedTimestamp || 0)) {
          return (b.modifiedTimestamp || 0) - (a.modifiedTimestamp || 0);
        }
        return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
      });
    }

    const sorted = [...agents].sort((a, b) => {
      let comparison = 0;

      switch (sortColumn) {
        case 'name': {
          const aName = (a.name || '').toLowerCase();
          const bName = (b.name || '').toLowerCase();
          comparison = aName.localeCompare(bName);
          break;
        }
        case 'createdDate': {
          const aCreated = a.createdTimestamp || 0;
          const bCreated = b.createdTimestamp || 0;
          comparison = aCreated - bCreated;
          break;
        }
        case 'updatedDate': {
          const aModified = a.modifiedTimestamp || 0;
          const bModified = b.modifiedTimestamp || 0;
          comparison = aModified - bModified;
          break;
        }
        default:
          return 0;
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });

    if ((sortColumn === 'createdDate' || sortColumn === 'updatedDate') && sorted.length > 0) {
      console.log('🔍 Date sorting debug:', {
        sortColumn,
        sortDirection,
        totalAgents: sorted.length,
        firstThree: sorted.slice(0, 3).map(a => ({
          name: a.name,
          created: a.created,
          createdTimestamp: a.createdTimestamp,
          modified: a.modified,
          modifiedTimestamp: a.modifiedTimestamp
        })),
        lastThree: sorted.slice(-3).map(a => ({
          name: a.name,
          created: a.created,
          createdTimestamp: a.createdTimestamp,
          modified: a.modified,
          modifiedTimestamp: a.modifiedTimestamp
        }))
      });
    }

    return sorted;
  }, [agents, projectFolder?.projectId, sortColumn, sortDirection]);

  const getSortArrow = (column: 'name' | 'createdDate' | 'updatedDate') => {
    return sortColumn === column ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : '';
  };

  if (typeof window !== 'undefined' && Date.now() - lastDashboardDebugLogRef.current >= DASHBOARD_DEBUG_LOG_INTERVAL_MS) {
    lastDashboardDebugLogRef.current = Date.now();
    console.log('🔄 MAIN RENDER STATE:', {
      isModalOpen,
      currentAgent: currentAgent?.name || 'none',
      agentsCount: agents.length,
      isLoadingAgents,
      renderDashboard: !isModalOpen,
      renderModal: isModalOpen && currentAgent,
      timestamp: new Date().toISOString()
    });
  }

  return (
    <>
      {}
      <input
        type="file"
        ref={fileInputRef}
        style={{ display: 'none' }}
        accept=".json"
        onChange={handleFileImport}
      />

      {}
      <div
        ref={vantaRef}
        className="ai-agents-hero"
        style={{
          position: 'relative',
          color: 'var(--alma-on-accent)',
          padding: 'clamp(2rem, 5vw, 4rem) clamp(1rem, 4vw, 2rem)',
          borderRadius: '0px',
          margin: '0',
          width: '100%',
          minHeight: 'min(360px, 50vh)',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <div style={{
          margin: '0',
          padding: '0 2rem',
          position: 'relative',
          zIndex: 2,
          width: '100%',
          boxSizing: 'border-box',
          textAlign: 'center',
          maxWidth: '800px'
        }}>
          <h1 style={{
            fontSize: 'clamp(1.5rem, 5vw, 3rem)',
            fontWeight: '700',
            margin: '0 0 1rem',
            lineHeight: '1.2',
            color: 'var(--alma-on-accent)'
          }}>
            {t('aiAgents.heroTitle')}
          </h1>
          <p style={{
            fontSize: 'clamp(0.875rem, 2.5vw, 1.25rem)',
            margin: '0 0 2rem',
            opacity: '0.9',
            lineHeight: '1.6',
            color: 'var(--alma-on-accent)'
          }}>
            {t('aiAgents.heroSubtitle')}
          </p>
          <div style={{
            display: 'flex',
            gap: '1.25rem',
            marginTop: '1.5rem',
            justifyContent: 'center',
            flexWrap: 'wrap'
          }}>
            {projectFolder && (
              <div style={{
                backgroundColor: 'rgba(255, 255, 255, 0.2)',
                border: '1px solid rgba(175, 168, 186, 0.2)',
                borderRadius: '14px',
                padding: '1.25rem',
                minWidth: '100px',
                textAlign: 'center',
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.1)',
                backdropFilter: 'blur(20px)'
              }}>
                <div style={{
                  fontSize: '1.5rem',
                  fontWeight: '700',
                  color: 'var(--alma-on-accent)',
                  marginBottom: '0.375rem'
                }}>
                  {(() => {
                    const rawFolderName = projectFolder.folderName || '';
                    const cleanedFolderName = rawFolderName
                      .replace(/[_-]+/g, ' ')
                      .replace(/[^a-zA-Z0-9 ]+/g, ' ')
                      .replace(/\s+/g, ' ')
                      .trim();
                    const splitFolderName = cleanedFolderName ? cleanedFolderName.split(/\s+(?:\d{13,}\b|\d{4}\b)/)[0] : '';
                    const withoutFilesearch = splitFolderName.replace(/\bfilesearch\b/gi, '').replace(/\s+/g, ' ').trim();
                    const base = withoutFilesearch || rawFolderName.replace(/^alma_/, '').replace(/_\d{10,}(_iso)?$/, '');
                    const display = base.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                    return display.length > 10 ? `${display.slice(0, 10)}...` : display;
                  })()}
                </div>
                <div style={{
                  fontSize: '0.8rem',
                  color: 'rgba(255, 255, 255, 0.8)',
                  fontWeight: '500',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em'
                }}>
                  {t('aiAgents.statProject')}
                </div>
              </div>
            )}

            <div style={{
              backgroundColor: 'rgba(255, 255, 255, 0.2)',
              border: '1px solid rgba(175, 168, 186, 0.2)',
              borderRadius: '14px',
              padding: '1.25rem',
              minWidth: '100px',
              textAlign: 'center',
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.1)',
              backdropFilter: 'blur(20px)'
            }}>
              <div style={{
                fontSize: '2rem',
                fontWeight: '700',
                color: 'var(--alma-on-accent)',
                marginBottom: '0.375rem'
              }}>
                {isLoadingAgents ? '...' : agents.length}
              </div>
              <div style={{
                fontSize: '0.8rem',
                color: 'rgba(255, 255, 255, 0.8)',
                fontWeight: '500',
                textTransform: 'uppercase',
                letterSpacing: '0.05em'
              }}>
                {t('aiAgents.statAgents')}
              </div>
            </div>

            {(lastCacheTime || (!lastCacheTime && !isLoadingAgents && agents.length > 0)) && (
              <div style={{
                backgroundColor: 'rgba(255, 255, 255, 0.2)',
                border: '1px solid rgba(175, 168, 186, 0.2)',
                borderRadius: '14px',
                padding: '1.25rem',
                minWidth: '100px',
                textAlign: 'center',
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.1)',
                backdropFilter: 'blur(20px)'
              }}>
                <div style={{
                  fontSize: '1.25rem',
                  fontWeight: '700',
                  color: 'var(--alma-on-accent)',
                  marginBottom: '0.375rem'
                }}>
                  {lastCacheTime || t('aiAgents.live')}
                </div>
                <div style={{
                  fontSize: '0.8rem',
                  color: 'rgba(255, 255, 255, 0.8)',
                  fontWeight: '500',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em'
                }}>
                  {lastCacheTime ? t('aiAgents.cached') : t('aiAgents.status')}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {}
      {!isModalOpen && (
        <div className="dashboard-container">
          <div className="dashboard-main-content">
            {}
            {(() => {
              if (typeof window !== 'undefined' && Date.now() - lastDashboardDebugLogRef.current >= DASHBOARD_DEBUG_LOG_INTERVAL_MS) {
                lastDashboardDebugLogRef.current = Date.now();
                console.log('🏠 DASHBOARD RENDERING:', {
                  isModalOpen,
                  agentsCount: agents.length,
                  isLoadingAgents,
                  timestamp: new Date().toISOString()
                });
              }
              return null;
            })()}

            {}
            {agentsError && (
              <div className={`info-message error`}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ fontSize: '1.2rem' }}>⚠️</span>
                  <p style={{ margin: 0 }}>{agentsError}</p>
                </div>
                <button
                  onClick={() => loadAgentsData()}
                  style={{
                    marginTop: '0.5rem',
                    padding: '0.5rem 1rem',
                    background: 'var(--alma-danger)',
                    color: 'var(--alma-on-accent)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  {t('aiAgents.tryAgain')}
                </button>
              </div>
            )}

            {viewMode === 'cards' ? (
              <div className="agents-grid" data-tour="agent-create-btn">
                {}
                <CreateNewAgentCard onClick={handleCreateNewAgent} isCreating={isCreatingAgent} />
                <ImportAgentCard onClick={handleImportAgent} />
                <AIAssistCreateAgentCard onClick={handleAIAssistCreateAgent} />
                <ReportCreationCard onClick={handleReportCreation} />

                {!isLoadingAgents && !isLoadingFromRemote && sortedAgents.map((agent) => {
                  const lastOpenedIndex = projectFolder?.projectId
                    ? getAgentLastOpenedIndexForProject(projectFolder.projectId)
                    : {};
                  return (
                    <AgentCard
                      key={agent.id}
                      agent={{
                        ...agent,
                        lastOpenedTimestamp: lastOpenedIndex[agent.id],
                      }}
                      onLoadAgent={handleLoadAgent}
                      onPreviewAgent={handlePreviewAgent}
                      projectId={projectFolder?.projectId}
                      onShare={openShareModal}
                    />
                  );
                })}

                {(isLoadingAgents || isLoadingFromRemote) && (
                  <div className="loading-placeholder" style={{
                    gridColumn: '1 / -1',
                    textAlign: 'center',
                    padding: '3rem',
                    background: isLoadingFromRemote ? 'var(--alma-surface-sunken)' : 'var(--alma-surface-sunken)',
                    borderRadius: '8px',
                    border: `1px solid ${isLoadingFromRemote ? 'var(--alma-border)' : 'var(--alma-border)'}`
                  }}>
                    <div style={{
                      width: '32px',
                      height: '32px',
                      border: '3px solid var(--alma-border)',
                      borderTop: `3px solid ${isLoadingFromRemote ? 'var(--alma-accent)' : 'var(--alma-accent)'}`,
                      borderRadius: '50%',
                      animation: 'spin 1s linear infinite',
                      margin: '0 auto 1rem'
                    }}></div>
                    <p style={{ color: 'var(--alma-text-muted)', fontSize: '1rem', margin: 0 }}>
                      {isLoadingFromRemote ? t('aiAgents.loadingRefreshingRemote') : (() => {
                        const rawFolderName = projectFolder?.folderName || t('aiAgents.projectFallback');
                        const cleanedFolderName = rawFolderName
                          .replace(/[_-]+/g, ' ')
                          .replace(/[^a-zA-Z0-9 ]+/g, ' ')
                          .replace(/\s+/g, ' ')
                          .trim();
                        const splitFolderName = cleanedFolderName ? cleanedFolderName.split(/\s+(?:\d{13,}\b|\d{4}\b)/)[0] : '';
                        const withoutFilesearch = splitFolderName.replace(/\bfilesearch\b/gi, '').replace(/\s+/g, ' ').trim();
                        const displayFolderName = withoutFilesearch || t('aiAgents.projectFallback');
                        return t('aiAgents.loadingAgentsFor', { folder: displayFolderName });
                      })()}
                    </p>
                    <p style={{ color: 'var(--alma-text-muted)', fontSize: '0.875rem', margin: '0.5rem 0 1rem 0' }}>
                      {loadingPhase}
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ padding: '0 2rem 2rem 2rem' }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  flexWrap: 'wrap',
                  marginBottom: '1rem'
                }}>
                  <button
                    onClick={handleCreateNewAgent}
                    disabled={isCreatingAgent}
                    style={{
                      padding: '0.75rem 1rem',
                      backgroundColor: isCreatingAgent ? 'var(--alma-text-muted)' : 'var(--alma-accent)',
                      color: 'var(--alma-on-accent)',
                      borderRadius: '10px',
                      border: 'none',
                      cursor: isCreatingAgent ? 'not-allowed' : 'pointer',
                      fontWeight: 600
                    }}
                  >
                    {isCreatingAgent ? t('aiAgents.tableCreating') : t('aiAgents.tableCreateNew')}
                  </button>
                  {/* <button
                    onClick={handleAIAssistCreateAgent}
                    style={{
                      padding: '0.75rem 1rem',
                      backgroundColor: 'var(--alma-surface)',
                      color: 'var(--alma-accent)',
                      borderRadius: '10px',
                      border: '1px solid var(--alma-border)',
                      cursor: 'pointer',
                      fontWeight: 600
                    }}
                  >
                    {t('aiAgents.tableAiAssist')}
                  </button> */}
                  <button
                    onClick={handleImportAgent}
                    style={{
                      padding: '0.75rem 1rem',
                      backgroundColor: 'var(--alma-surface)',
                      color: 'var(--alma-accent)',
                      borderRadius: '10px',
                      border: '1px solid var(--alma-border)',
                      cursor: 'pointer',
                      fontWeight: 600
                    }}
                  >
                    {t('aiAgents.tableImport')}
                  </button>
                  {projectFolder && (
                    <button
                      onClick={loadFromRemote}
                      disabled={isLoadingAgents || isLoadingFromRemote}
                      className={`alma-refresh-button alma-refresh-button--icon-only ${isLoadingFromRemote ? 'loading' : ''}`}
                      title={isLoadingFromRemote ? t('aiAgents.refreshingShort') : t('aiAgents.refreshAgentsTitle')}
                      aria-label={isLoadingFromRemote ? t('aiAgents.refreshingAria') : t('aiAgents.refreshAgentsTitle')}
                    >
                      <FaCloud size={14} />
                    </button>
                  )}
                </div>

                <div style={{
                  background: 'var(--alma-surface)',
                  border: '1px solid var(--alma-border)',
                  borderRadius: '14px',
                  overflow: 'hidden'
                }}>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ background: 'var(--alma-surface-sunken)', borderBottom: '1px solid var(--alma-border)' }}>
                          <th
                            onClick={() => handleSort('name')}
                            style={{ textAlign: 'left', padding: '12px 14px', fontSize: '12px', color: 'var(--alma-text-muted)', fontWeight: 700, cursor: 'pointer', userSelect: 'none' }}
                            title={t('aiAgents.sortByName')}
                          >
                            {t('aiAgents.colName')}{getSortArrow('name')}
                          </th>
                          <th
                            onClick={() => handleSort('createdDate')}
                            style={{ textAlign: 'left', padding: '12px 14px', fontSize: '12px', color: 'var(--alma-text-muted)', fontWeight: 700, cursor: 'pointer', userSelect: 'none' }}
                            title={t('aiAgents.sortByCreated')}
                          >
                            {t('aiAgents.colCreatedTime')}{getSortArrow('createdDate')}
                          </th>
                          <th
                            onClick={() => handleSort('updatedDate')}
                            style={{ textAlign: 'left', padding: '12px 14px', fontSize: '12px', color: 'var(--alma-text-muted)', fontWeight: 700, cursor: 'pointer', userSelect: 'none' }}
                            title={t('aiAgents.sortByUpdated')}
                          >
                            {t('aiAgents.colUpdatedTime')}{getSortArrow('updatedDate')}
                          </th>
                          <th style={{ textAlign: 'left', padding: '12px 14px', fontSize: '12px', color: 'var(--alma-text-muted)', fontWeight: 700 }}>{t('aiAgents.colActions')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {!isLoadingAgents && !isLoadingFromRemote && sortedAgents.map((agent) => {
                          const cleanedName =
                            (agent.name || '')
                              .trim()
                              .replace(/[_-]+/g, ' ')
                              .replace(/[^a-zA-Z0-9 ]+/g, ' ')
                              .replace(/\s+/g, ' ')
                              .trim();
                          
                          const splitName = cleanedName ? cleanedName.split(/\s+(?:\d{13,}\b|\d{4}\b)/)[0] : '';
                          const withoutFilesearch = splitName.replace(/\bfilesearch\b/gi, '').replace(/\s+/g, ' ').trim();
                          const displayName = withoutFilesearch || t('aiAgents.untitledAgent');
                          const createdAgoDetailed = formatTimeAgoDetailed(agent.createdTimestamp, relativeNowMs);
                          const updatedAgoDetailed = formatTimeAgoDetailed(agent.modifiedTimestamp, relativeNowMs);

                          return (
                            <tr key={agent.id} style={{ borderBottom: '1px solid var(--alma-border)' }}>
                              <td
                                style={{ padding: '12px 14px', maxWidth: 520, cursor: 'default' }}
                                onMouseEnter={(e) => showTableHoverTooltip(e.currentTarget, agent.name || displayName)}
                                onMouseLeave={hideTableHoverTooltip}
                              >
                                <div
                                  style={{ fontWeight: 600, color: 'var(--alma-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    const anchorEl = e.currentTarget as HTMLElement;
                                    try {
                                      await navigator.clipboard.writeText(agent.name || displayName);
                                      showTableToast(anchorEl, t('aiAgents.nameCopied'));
                                    } catch (err) {
                                      console.error('Failed to copy agent name:', err);
                                    }
                                  }}
                                >
                                  {displayName}
                                </div>
                              </td>
                              <td style={{ padding: '12px 14px', color: 'var(--alma-text-muted)', fontSize: '13px', whiteSpace: 'nowrap' }} title={agent.created}>
                                {createdAgoDetailed ?? agent.created}
                              </td>
                              <td style={{ padding: '12px 14px', color: 'var(--alma-text-muted)', fontSize: '13px', whiteSpace: 'nowrap' }} title={agent.modified}>
                                {updatedAgoDetailed ?? agent.modified}
                              </td>
                              <td style={{ padding: '12px 14px' }}>
                                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                                  <button
                                    onClick={async () => {
                                      openShareModal(agent.id, agent.name || displayName, displayName);
                                    }}
                                    style={{ padding: '8px 10px', borderRadius: '10px', border: '1px solid var(--alma-border)', background: 'var(--alma-surface)', cursor: 'pointer', fontWeight: 600, color: 'var(--alma-accent)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                                    title={t('aiAgents.shareViaGmailTitle')}
                                  >
                                    <FaShareAlt size={14} />
                                    {t('aiAgents.share')}
                                  </button>
                                  <button
                                    onClick={() => handleLoadAgent(agent.id)}
                                    style={{ padding: '8px 10px', borderRadius: '10px', border: 'none', background: 'var(--alma-accent)', cursor: 'pointer', fontWeight: 700, color: 'var(--alma-on-accent)' }}
                                  >
                                    {t('aiAgents.load')}
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}

                        {(isLoadingAgents || isLoadingFromRemote) && (
                          <tr>
                            <td colSpan={4} style={{ padding: '18px 14px', color: 'var(--alma-text-muted)' }}>
                              {isLoadingFromRemote ? t('aiAgents.tableLoadingRemote') : t('aiAgents.tableLoadingAgents')}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {tableHoverTooltip.visible &&
                  createPortal(
                    <div
                      style={{
                        position: 'fixed',
                        top: tableHoverTooltip.top,
                        left: tableHoverTooltip.left,
                        maxWidth: `${tableHoverTooltip.maxWidth}px`,
                        transform: tableHoverTooltip.placement === 'above' ? 'translateY(-100%)' : undefined,
                        backgroundColor: 'var(--alma-text)',
                        color: 'var(--alma-on-accent)',
                        padding: '8px 10px',
                        borderRadius: '10px',
                        fontSize: '12px',
                        lineHeight: 1.25,
                        zIndex: 100000,
                        boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
                        border: '1px solid rgba(255,255,255,0.12)',
                        whiteSpace: 'normal',
                        wordBreak: 'break-word',
                        pointerEvents: 'auto',
                      }}
                      role="tooltip"
                      onClick={async (e) => {
                        e.stopPropagation();
                        try {
                          await navigator.clipboard.writeText(tableHoverTooltip.text);
                          showTableToast(e.currentTarget as HTMLElement, t('aiAgents.nameCopied'));
                        } catch (err) {
                          console.error('Failed to copy tooltip text:', err);
                        }
                      }}
                    >
                      {tableHoverTooltip.text}
                    </div>,
                    document.body
                  )}

                {tableToast.visible &&
                  createPortal(
                    <div
                      style={{
                        position: 'fixed',
                        top: tableToast.top,
                        left: tableToast.left,
                        backgroundColor: 'var(--alma-surface)',
                        color: 'var(--alma-text)',
                        padding: '6px 10px',
                        borderRadius: '10px',
                        fontSize: '12px',
                        fontWeight: 700,
                        zIndex: 100000,
                        boxShadow: '0 10px 30px rgba(0,0,0,0.15)',
                        border: '1px solid var(--alma-border)',
                        pointerEvents: 'none',
                      }}
                      role="status"
                      aria-live="polite"
                    >
                      {tableToast.text}
                    </div>,
                    document.body
                  )}
              </div>
            )}
          </div>
        </div>
      )}

      {}
      {shareModal.open &&
        createPortal(
          <div
            onClick={closeShareModal}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'var(--alma-overlay)',
              zIndex: 100000,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '24px',
              backdropFilter: 'blur(6px)',
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: 'min(720px, 95vw)',
                background: 'var(--alma-surface)',
                borderRadius: '16px',
                border: '1px solid var(--alma-border)',
                boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.35)',
                overflow: 'hidden',
                fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
              }}
            >
              <div
                style={{
                  padding: '14px 16px',
                  borderBottom: '1px solid var(--alma-border)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                }}
              >
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--alma-accent)' }}>{t('aiAgents.shareModalTitle')}</div>
                  <div style={{ fontSize: '12px', color: 'var(--alma-text-muted)', marginTop: '2px' }}>
                    {t('aiAgents.shareModalAgent')} <span style={{ fontWeight: 700, color: 'var(--alma-text)' }}>{shareModal.agentDisplayName}</span>
                  </div>
                </div>
                <button
                  onClick={closeShareModal}
                  style={{
                    height: '34px',
                    width: '34px',
                    borderRadius: '10px',
                    border: '1px solid var(--alma-border)',
                    background: 'var(--alma-surface)',
                    cursor: 'pointer',
                    color: 'var(--alma-text-muted)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  title={t('aiAgents.close')}
                >
                  <FaTimes />
                </button>
              </div>

              <div style={{ padding: '16px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '12px' }}>
                  <div>
                    <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--alma-text-muted)', marginBottom: '6px' }}>{t('aiAgents.fieldTo')}</div>
                    <input
                      value={shareModal.to}
                      onChange={(e) =>
                        setShareModal((prev) => (prev.open ? { ...prev, to: e.target.value } : prev))
                      }
                      placeholder={t('aiAgents.placeholderEmails')}
                      style={{
                        width: '100%',
                        height: '40px',
                        borderRadius: '10px',
                        border: '1px solid var(--alma-border)',
                        padding: '0 12px',
                        fontSize: '13px',
                      }}
                    />
                  </div>

                  <div>
                    <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--alma-text-muted)', marginBottom: '6px' }}>{t('aiAgents.fieldSubject')}</div>
                    <input
                      value={shareModal.subject}
                      onChange={(e) =>
                        setShareModal((prev) => (prev.open ? { ...prev, subject: e.target.value } : prev))
                      }
                      style={{
                        width: '100%',
                        height: '40px',
                        borderRadius: '10px',
                        border: '1px solid var(--alma-border)',
                        padding: '0 12px',
                        fontSize: '13px',
                      }}
                    />
                  </div>

                  <div>
                    <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--alma-text-muted)', marginBottom: '6px' }}>{t('aiAgents.fieldMessage')}</div>
                    <textarea
                      value={shareModal.message}
                      onChange={(e) =>
                        setShareModal((prev) => (prev.open ? { ...prev, message: e.target.value } : prev))
                      }
                      rows={6}
                      style={{
                        width: '100%',
                        borderRadius: '10px',
                        border: '1px solid var(--alma-border)',
                        padding: '10px 12px',
                        fontSize: '13px',
                        resize: 'vertical',
                      }}
                    />
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      gap: '10px',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginTop: '6px',
                    }}
                  >
                    <div style={{ fontSize: '12px', color: 'var(--alma-text-muted)' }}>
                      {shareModal.loading
                        ? t('aiAgents.shareLoadingJson')
                        : shareModal.jsonText
                          ? t('aiAgents.shareJsonReady')
                          : t('aiAgents.shareJsonNotAvailable')}
                    </div>

                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                      <button
                        disabled={shareModal.loading || !shareModal.jsonText}
                        onClick={async () => {
                          if (!shareModal.open || !shareModal.jsonText) return;
                          try {
                            await navigator.clipboard.writeText(shareModal.jsonText);
                          } catch (err) {
                            console.error('Failed to copy JSON:', err);
                          }
                        }}
                        style={{
                          height: '40px',
                          padding: '0 12px',
                          borderRadius: '10px',
                          border: '1px solid var(--alma-border)',
                          background: 'var(--alma-surface)',
                          cursor: shareModal.loading || !shareModal.jsonText ? 'not-allowed' : 'pointer',
                          color: 'var(--alma-accent)',
                          fontWeight: 800,
                          opacity: shareModal.loading || !shareModal.jsonText ? 0.6 : 1,
                        }}
                      >
                        {t('aiAgents.copyJson')}
                      </button>

                      <button
                        disabled={shareModal.loading || !shareModal.jsonText}
                        onClick={async () => {
                          if (!shareModal.open) return;
                          try {
                            await exportAgentJson(shareModal.agentId, shareModal.agentDisplayName);
                          } catch (err) {
                            alert('Failed to export agent Corpus: ' + (err instanceof Error ? err.message : String(err)));
                          }
                        }}
                        style={{
                          height: '40px',
                          padding: '0 12px',
                          borderRadius: '10px',
                          border: '1px solid var(--alma-border)',
                          background: 'var(--alma-surface)',
                          cursor: shareModal.loading || !shareModal.jsonText ? 'not-allowed' : 'pointer',
                          color: 'var(--alma-accent)',
                          fontWeight: 800,
                          opacity: shareModal.loading || !shareModal.jsonText ? 0.6 : 1,
                        }}
                      >
                        {t('aiAgents.downloadJson')}
                      </button>

                      <button
                        onClick={sendEmailNow}
                        style={{
                          height: '40px',
                          padding: '0 14px',
                          borderRadius: '10px',
                          border: 'none',
                          background: 'var(--alma-accent)',
                          cursor: 'pointer',
                          color: 'var(--alma-on-accent)',
                          fontWeight: 900,
                        }}
                        title={t('aiAgents.sendEmailTitle')}
                      >
                        {t('aiAgents.sendEmail')}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}

      {}
      <WarningDialog
        isOpen={showWarning}
        agentName={agentName}
        onSaveAndExit={handleSaveAndExit}
        onDiscardAndExit={handleDiscardAndExit}
        onCancel={handleCancelExit}
      />

      {}
      <FullScreenCubeLoader
        isVisible={isLoadingPreview}
        agentName={loadingAgentName}
        onComplete={() => {
          setIsLoadingPreview(false);
          setShowPreview(true);
        }}
        duration={1200}
      />

      {}
      <AgentPreviewPopup
        isOpen={showPreview}
        agent={previewAgent}
        onClose={() => {
          setShowPreview(false);
          setPreviewAgent(null);
        }}
      />

      {}
      <MissingFoldersModal
        isOpen={showMissingFoldersModal}
        onClose={() => setShowMissingFoldersModal(false)}
        projectId={projectFolder?.projectId || ''}
        missingFolders={missingFolders}
        totalFolders={getRequiredFoldersCount()}
      />

      {}
      {loadingState !== 'idle' && loadingState !== 'ready' && (
        <div style={{
          position: 'fixed',
          top: '10px',
          right: '10px',
          background: 'rgba(0,0,0,0.8)',
          color: 'var(--alma-on-accent)',
          padding: '8px 12px',
          borderRadius: '4px',
          fontSize: '12px',
          zIndex: 9999
        }}>
          Loading Vanta: {loadingState}
        </div>
      )}

      {}
      <AIAssistCreateAgentModal
        isOpen={showAIAssistModal}
        onClose={() => setShowAIAssistModal(false)}
        projectId={projectFolder?.projectId || ''}
        onSaved={() => {
          if (projectFolder?.projectId) clearCache(projectFolder.projectId);
        }}
      />

      {}
      <ReportCreationModal
        isOpen={showReportCreationModal}
        onClose={() => setShowReportCreationModal(false)}
        projectId={projectFolder?.projectId || ''}
        onSaved={() => {
          if (projectFolder?.projectId) clearCache(projectFolder.projectId);
        }}
      />

      {}
      {showAgentNameModal && (
        <AgentNameModal
          onClose={() => setShowAgentNameModal(false)}
          onCreateAgent={async (agentName) => {
            setShowAgentNameModal(false);
            await handleCreateAgentWithName(agentName);
          }}
          isSubmitting={isCreatingAgent}
        />
      )}
    </>
  );

};

export default function Home() {
  return (
    <CollectionContextProvider>
      <Suspense fallback={null}>
        <AIAgentsDashboard />
      </Suspense>
    </CollectionContextProvider>
  );
}
