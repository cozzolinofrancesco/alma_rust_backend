'use client';

import { useState } from 'react';
import { Plus, FileText, Users, Settings, PanelLeftClose } from 'lucide-react';
import type { AgentFile } from '../lib/types';
import { formatAgentSidebarLabel } from '../canvas-272/lib/agentDisplayName';
import WorkspaceFilesList from './WorkspaceFilesList';
import WorkspaceProjectSwitcher from './WorkspaceProjectSwitcher';

interface WorkspaceNavProps {
  agents: AgentFile[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (agentId: string) => void;
  onCollapse?: () => void;
}

type ListMode = 'agents' | 'files';

// Curated Claude-Science-style left rail: brand, project switcher, actions,
// and a list that switches between Agents and Files (RAG databases). Shared by
// the workspace index and the per-agent shell.
export default function WorkspaceNav({
  agents,
  loading,
  error,
  selectedId,
  onSelect,
  onCollapse,
}: WorkspaceNavProps) {
  const [mode, setMode] = useState<ListMode>('agents');

  return (
    <nav className="aw-nav">
      <div className="aw-brand">
        <span className="aw-brand__name">Alma Studio</span>
        <span className="aw-brand__tag">Beta</span>
        {onCollapse ? (
          <button
            type="button"
            className="aw-nav__collapse"
            onClick={onCollapse}
            aria-label="Hide agents list"
            title="Hide agents list"
          >
            <PanelLeftClose size={16} aria-hidden />
          </button>
        ) : null}
      </div>

      <WorkspaceProjectSwitcher />

      <div className="aw-nav__actions">
        <button type="button" className="aw-nav__action" onClick={() => setMode('agents')}>
          <Plus size={15} aria-hidden /> New
        </button>
        <button
          type="button"
          className={`aw-nav__action${mode === 'files' ? ' aw-nav__action--active' : ''}`}
          onClick={() => setMode((m) => (m === 'files' ? 'agents' : 'files'))}
        >
          <FileText size={15} aria-hidden /> Files
        </button>
      </div>

      {mode === 'files' ? (
        <>
          <div className="aw-nav__section">
            <button type="button" className="aw-nav__section-back" onClick={() => setMode('agents')}>
              <Users size={12} aria-hidden /> Agents
            </button>
            <span>Files</span>
          </div>
          <div className="aw-nav__list">
            <WorkspaceFilesList />
          </div>
        </>
      ) : (
        <>
          <div className="aw-nav__section">Agents</div>
          <div className="aw-nav__list">
            {loading ? (
              <div className="aw-nav__hint">Loading…</div>
            ) : error ? (
              <div className="aw-nav__hint aw-nav__hint--error">{error}</div>
            ) : agents.length === 0 ? (
              <div className="aw-nav__hint">No agents in this project.</div>
            ) : (
              agents.map((agent) => {
                const active = selectedId === agent.id;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    className={`aw-nav__item${active ? ' aw-nav__item--active' : ''}`}
                    onClick={() => onSelect(agent.id)}
                    title={agent.name}
                  >
                    <span className="aw-nav__dot" aria-hidden />
                    <span className="aw-nav__label">{formatAgentSidebarLabel(agent.name)}</span>
                  </button>
                );
              })
            )}
          </div>
        </>
      )}

      <button type="button" className="aw-nav__settings" aria-label="Settings">
        <Settings size={16} aria-hidden />
      </button>
    </nav>
  );
}
