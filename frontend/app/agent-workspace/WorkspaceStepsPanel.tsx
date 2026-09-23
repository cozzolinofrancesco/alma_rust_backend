'use client';

import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useAgentEditor } from '../ai-agents/edit/[agent-id]/AgentEditorContext';
import { getLayerOutputText } from '../canvas-272/lib/layerOutput';
import { extractActiveSortedLayers } from '../canvas-272/lib/sections';
import { stripSectionMarkerFromExportLabel } from '../canvas-272/lib/exportFormatter';
import type { Canvas272Layer } from '../canvas-272/lib/types';
import SectionReviewPanel from '../agentnodes/components/export/SectionReviewPanel';
import { useOptionalOutputWorkspace, type OutputTab, type OutputWorkspaceValue } from './OutputWorkspaceContext';

type View = 'form' | 'graph' | 'output';
type Tab =
  | 'steps'
  | 'log'
  | 'messages'
  | 'environment'
  | 'review'
  | 'preview'
  | 'edit'
  | 'validation'
  | 'export';

const TAB_LABELS: Record<Tab, string> = {
  steps: 'Steps',
  log: 'Execution Log',
  messages: 'Messages',
  environment: 'Environment',
  review: 'Review',
  preview: 'Preview',
  edit: 'Edit',
  validation: 'Validation',
  export: 'Export',
};

const TABS_BY_VIEW: Record<View, ReadonlyArray<Tab>> = {
  form: ['steps', 'environment', 'review'],
  graph: ['steps', 'log', 'review'],
  output: ['preview', 'edit', 'validation', 'export'],
};

function previewText(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function StepsTimeline({ steps, nameById }: { steps: Canvas272Layer[]; nameById: Map<string, string> }) {
  if (steps.length === 0) return <div className="aw-state aw-state--muted">No steps in this agent.</div>;
  return (
    <ol className="aw-timeline">
      {steps.map((step, index) => {
        const instruction = typeof step.userInstruction === 'string' ? step.userInstruction : '';
        const body = instruction || getLayerOutputText(step);
        const refs = (step.referencedSteps ?? []).filter((id) => id !== step.id);
        return (
          <li key={step.id} className="aw-tl">
            <div className="aw-tl__rail">
              <span className="aw-tl__num">{index + 1}</span>
            </div>
            <div className="aw-tl__card">
              <div className="aw-tl__head">
                <span className="aw-tl__name">{step.name}</span>
                {step.selectedModel ? <span className="aw-tl__model">{step.selectedModel}</span> : null}
              </div>
              {body ? (
                <p className="aw-tl__preview">{previewText(body)}</p>
              ) : (
                <p className="aw-tl__preview aw-tl__preview--empty">No instruction yet</p>
              )}
              {refs.length > 0 ? (
                <div className="aw-tl__refs">
                  {refs.map((refId) => (
                    <span key={refId} className="aw-ref-chip">↳ {nameById.get(refId) ?? refId}</span>
                  ))}
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function EnvironmentContent({ steps }: { steps: Canvas272Layer[] }) {
  if (steps.length === 0) return <div className="aw-state aw-state--muted">No steps in this agent.</div>;
  return (
    <div className="aw-env">
      {steps.map((step, index) => {
        const files = Array.isArray(step.uploadedFileNames) ? step.uploadedFileNames : [];
        const hasCorpus = typeof step.corpusId === 'string' && step.corpusId.length > 0;
        return (
          <div key={step.id} className="aw-env__row">
            <div className="aw-env__head">
              <span className="aw-env__num">{index + 1}</span>
              <span className="aw-env__name">{step.name}</span>
              {step.selectedModel ? <span className="aw-tl__model">{step.selectedModel}</span> : null}
            </div>
            {hasCorpus || files.length > 0 ? (
              <div className="aw-env__inputs">
                {hasCorpus ? <span className="aw-ref-chip">📎 corpus</span> : null}
                {files.map((f) => (
                  <span key={f} className="aw-ref-chip">{f}</span>
                ))}
              </div>
            ) : (
              <div className="aw-env__none">no inputs</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Output-view tab bodies. Edit only enables the toolbar on the main-pane
// document; Validation picks a section and runs the audit; Export lists the
// destinations. All reuse the shared OutputWorkspaceContext.
function OutputPanelBody({ tab, ctx }: { tab: OutputTab; ctx: OutputWorkspaceValue }) {
  if (tab === 'preview') {
    return (
      <div className="aw-state aw-state--muted">
        Read-only preview of the assembled document. Switch to Edit to make changes.
      </div>
    );
  }

  if (tab === 'edit') {
    return (
      <div className="aw-state aw-state--muted">
        Editing is on — use the toolbar above the document. Your changes are used for validation and export.
      </div>
    );
  }

  const doc = ctx.currentDoc;
  if (!doc) return <div className="aw-state aw-state--muted">Loading agent…</div>;

  if (tab === 'validation') {
    return (
      <div className="aw-validation">
        <div className="an-srev__preset-row">
          <label className="an-srev__preset-label" htmlFor="aw-validation-section">
            Section
          </label>
          <select
            id="aw-validation-section"
            className="an-srev__preset-select"
            value={ctx.activeSection ?? ''}
            onChange={(e) =>
              ctx.setActiveSection(e.target.value === '' ? null : Number(e.target.value))
            }
          >
            <option value="">Select a section…</option>
            {doc.sections.map((section, index) => (
              <option key={index} value={index}>
                {section.heading ? stripSectionMarkerFromExportLabel(section.heading) : 'Prelude'}
              </option>
            ))}
          </select>
        </div>
        <SectionReviewPanel
          sections={doc.sections}
          activeSection={ctx.activeSection}
          lastAnalysedSection={ctx.lastAnalysedSection}
          doc={doc}
          latestRun={ctx.latestRun}
          isStale={ctx.isStale}
          isRunning={ctx.isRunning}
          runError={ctx.runError}
          onRunSection={ctx.runSection}
          onAcknowledge={ctx.acknowledgeComment}
          style={{ width: '100%' }}
        />
      </div>
    );
  }

  return (
    <div className="aw-export-actions" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 8 }}>
      <button type="button" className="c272-btn" onClick={ctx.handleGoogleDoc} disabled={ctx.exporting}>
        Create Google Doc
      </button>
      <button type="button" className="c272-btn" onClick={ctx.handlePdf} disabled={ctx.exporting}>
        Download PDF
      </button>
      <button type="button" className="c272-btn" onClick={ctx.handleDocx} disabled={ctx.exporting}>
        Download DOCX
      </button>
    </div>
  );
}

export default function WorkspaceStepsPanel({ view, onClose }: { view: View; onClose: () => void }) {
  const { graphAgent } = useAgentEditor();
  const outputCtx = useOptionalOutputWorkspace();
  const isOutput = view === 'output' && outputCtx !== null;
  const tabs = TABS_BY_VIEW[view];
  const [localActiveTab, setLocalActiveTab] = useState<Tab>(tabs[0]);

  // When the active view changes, reset to that view's first tab.
  useEffect(() => {
    setLocalActiveTab(TABS_BY_VIEW[view][0]);
  }, [view]);

  // Output-view tab is shared via context so the main pane reacts; other views
  // keep the panel-local tab state.
  const activeTab: Tab = isOutput ? outputCtx.outputTab : localActiveTab;
  const selectTab = (tab: Tab) => {
    if (isOutput) outputCtx.setOutputTab(tab as OutputTab);
    else setLocalActiveTab(tab);
  };

  const steps = useMemo<Canvas272Layer[]>(
    () => (graphAgent ? extractActiveSortedLayers(graphAgent.layers) : []),
    [graphAgent],
  );

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const layer of graphAgent?.layers ?? []) map.set(layer.id, layer.name);
    return map;
  }, [graphAgent]);

  return (
    <aside className="aw-card aw-card--right">
      <header className="aw-right__head">
        <div className="aw-right__titlerow">
          <span className="aw-right__title">{graphAgent ? graphAgent.name : 'Panel'}</span>
          {graphAgent?.currentVersion ? <span className="aw-chip">‹ {graphAgent.currentVersion} ›</span> : null}
          <button type="button" className="aw-right__close" onClick={onClose} aria-label="Close panel" title="Close panel">
            <X size={16} aria-hidden />
          </button>
        </div>
        <nav className="aw-tabs" role="tablist" aria-label="Panel views">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              className={`aw-tab${activeTab === tab ? ' aw-tab--active' : ''}`}
              onClick={() => selectTab(tab)}
            >
              {TAB_LABELS[tab]}
            </button>
          ))}
        </nav>
      </header>

      <div className="aw-right__body">
        {isOutput ? (
          <OutputPanelBody tab={activeTab as OutputTab} ctx={outputCtx} />
        ) : activeTab === 'steps' ? (
          <StepsTimeline steps={steps} nameById={nameById} />
        ) : activeTab === 'environment' ? (
          <EnvironmentContent steps={steps} />
        ) : (
          <div className="aw-state aw-state--muted">Coming soon.</div>
        )}
      </div>
    </aside>
  );
}
