'use client';

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import nextDynamic from 'next/dynamic';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { PanelLeftOpen, PanelRightOpen } from 'lucide-react';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { IntegrityChainProvider } from '../../contexts/IntegrityChainContext';
import { CollectionContextProvider } from '../../components/CollectionContext';
import {
  AgentEditorProvider,
  useAgentEditor,
  type Layer,
} from '../../ai-agents/edit/[agent-id]/AgentEditorContext';
import { OutputWorkspaceProvider, useOptionalOutputWorkspace } from '../OutputWorkspaceContext';
import { useAgentNodesData } from '../../agentnodes/hooks/useAgentNodesData';
import WorkspaceNav from '../WorkspaceNav';
import WorkspaceStepsPanel from '../WorkspaceStepsPanel';
import '../../canvas-272/style.css';
import '../../agentnodes/style.css';
import '../workspace.css';
import { useVoiceModalOpen } from '../../lib/voice/voiceModalEvents';

const AgentNodesView = nextDynamic(() => import('../../agentnodes/components/AgentNodesView'), { ssr: false });
const OutputView = nextDynamic(() => import('../../ai-agents/edit/[agent-id]/OutputView'), { ssr: false });
const DocumentPreviewModal = nextDynamic(() => import('../../canvas-272/components/DocumentPreviewModal'), { ssr: false });

// In-place views live inside the workspace; Form opens the (identically-styled)
// classic editor because EditAgentPage owns the route's page lifecycle and
// cannot be legally exported from its page.tsx.
type InPlaceView = 'graph' | 'output';
type View = 'form' | InPlaceView;

const VIEWS: ReadonlyArray<{ id: View; label: string }> = [
  { id: 'form', label: 'Form' },
  { id: 'graph', label: 'Graph' },
  { id: 'output', label: 'Output' },
];

// Loads the selected agent (via the shared data hook) and bridges it into the
// AgentEditorContext, so the in-place views + right panel read one source.
function AgentLoader({ agentId }: { agentId: string }) {
  const { selectAgent, loadedAgent } = useAgentNodesData();
  const { setAgent } = useAgentEditor();

  useEffect(() => {
    if (agentId) void selectAgent(agentId);
  }, [agentId, selectAgent]);

  useEffect(() => {
    if (!loadedAgent) return;
    setAgent({
      version: loadedAgent.currentVersion,
      name: loadedAgent.name,
      // Canvas272Layer <-> editor Layer are parallel loose types (both index
      // signatures); the provider already casts the other direction.
      layers: loadedAgent.layers as unknown as Layer[],
      metadata: loadedAgent.metadata
        ? {
            created: loadedAgent.metadata.created ?? '',
            modified: loadedAgent.metadata.modified ?? '',
            description: loadedAgent.metadata.description,
            skillIds: loadedAgent.metadata.skillIds,
          }
        : undefined,
    });
  }, [loadedAgent, setAgent]);

  return null;
}

function ViewPill({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const voiceModalOpen = useVoiceModalOpen();
  if (voiceModalOpen) return null;

  return (
    <div className="aw-viewpill" role="tablist" aria-label="Editor view">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          type="button"
          role="tab"
          aria-selected={view === v.id}
          className={`aw-viewpill__btn${view === v.id ? ' aw-viewpill__btn--active' : ''}`}
          onClick={() => onChange(v.id)}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

// Toast + document-preview modal for the output view. Reads the output
// workspace context; renders nothing on views/routes without the provider.
function OutputOverlays() {
  const ctx = useOptionalOutputWorkspace();
  if (!ctx) return null;
  return (
    <>
      <DocumentPreviewModal
        open={ctx.previewDoc !== null}
        doc={ctx.previewDoc}
        exporting={ctx.exporting}
        onClose={ctx.closePreview}
        onExportGoogleDoc={ctx.handleGoogleDoc}
        onExportPdf={ctx.handlePdf}
        onExportDocx={ctx.handleDocx}
      />
      {ctx.toast && typeof document !== 'undefined'
        ? createPortal(<div className="c272-toast">{ctx.toast}</div>, document.body)
        : null}
    </>
  );
}

function WorkspaceShell() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { agentList, agentListLoading, agentListError } = useAgentNodesData();

  const currentId = decodeURIComponent((pathname ?? '').split('/').filter(Boolean).pop() || '');

  const rawView = searchParams?.get('view');
  const view: InPlaceView =
    rawView === 'graph' ? 'graph' : 'output';

  const [navOpen, setNavOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  const setView = (next: View) => {
    if (next === 'form') {
      router.push(`/ai-agents/edit/${encodeURIComponent(currentId)}?view=form`);
      return;
    }
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.set('view', next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const openAgent = (agentId: string) => {
    router.push(`/agent-workspace/${encodeURIComponent(agentId)}?view=${view}`);
  };

  return (
    <div className="aw-bg">
      <AgentLoader agentId={currentId} />

      <div className="aw-card aw-card--main">
        {navOpen ? (
          <WorkspaceNav
            agents={agentList}
            loading={agentListLoading}
            error={agentListError}
            selectedId={currentId || null}
            onSelect={openAgent}
            onCollapse={() => setNavOpen(false)}
          />
        ) : (
          <button
            type="button"
            className="aw-reopen aw-reopen--left"
            onClick={() => setNavOpen(true)}
            aria-label="Show agents list"
            title="Show agents list"
          >
            <PanelLeftOpen size={16} aria-hidden />
          </button>
        )}

        <div className="aw-surfaces">
          <div className="aw-pane aw-pane--graph" style={{ display: view === 'graph' ? 'block' : 'none' }}>
            <AgentNodesView embedded />
          </div>
          <div className="aw-pane aw-pane--output" style={{ display: view === 'output' ? 'block' : 'none' }}>
            <OutputView />
          </div>

          <ViewPill view={view} onChange={setView} />
        </div>
      </div>

      {rightOpen ? (
        <WorkspaceStepsPanel view={view} onClose={() => setRightOpen(false)} />
      ) : (
        <button
          type="button"
          className="aw-reopen aw-reopen--right"
          onClick={() => setRightOpen(true)}
          aria-label="Show steps panel"
          title="Show steps panel"
        >
          <PanelRightOpen size={16} aria-hidden />
        </button>
      )}

      <OutputOverlays />
    </div>
  );
}

export default function AgentWorkspaceAgentPage() {
  return (
    <ThemeProvider initialDark={false}>
      <IntegrityChainProvider>
        <CollectionContextProvider>
          <AgentEditorProvider>
            <OutputWorkspaceProvider>
              <React.Suspense fallback={null}>
                <WorkspaceShell />
              </React.Suspense>
            </OutputWorkspaceProvider>
          </AgentEditorProvider>
        </CollectionContextProvider>
      </IntegrityChainProvider>
    </ThemeProvider>
  );
}
