'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { RefreshIcon } from '@heroicons/react/outline';
import type { AgentFile } from '../../lib/types';
import {
  formatAgentDisplayName,
  formatAgentSidebarLabel,
} from '../../canvas-272/lib/agentDisplayName';
import RecipesList, { type Recipe } from '../../canvas-272/components/RecipesList';
import { useLanguage } from '../../contexts/LanguageContext';
// Carry the sidebar's own styles so it renders correctly regardless of which
// surface mounts it. The `.c272-sidebar*` base rules live in canvas-272/style.css
// and the `.an-sidebar*` overrides in agentnodes/style.css; without these the
// editor's form view (which never mounts the lazy graph that used to be the only
// importer) shows an unstyled list on first load.
import '../../canvas-272/style.css';
import '../style.css';

export type { Recipe };
type SidebarTab = 'agents' | 'training';
type SortColumn = 'name' | 'updatedDate' | 'createdDate';
type SortDirection = 'asc' | 'desc';

interface AgentSidebarProps {
  agents: AgentFile[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  hidden: boolean;
  onSelect: (agentId: string) => void;
  onRefresh: () => void;
  onCreateAgent: (name: string) => Promise<{ ok: boolean; fileId?: string; error?: string }>;
  isCreating?: boolean;
  onRenameAgent: (
    agentId: string,
    newName: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  onRequestCollapse?: () => void;
  onSimulateRecipe?: (recipe: Recipe) => void;
  showTrainingTab?: boolean;
}

function formatDate(input: string): string {
  if (!input) return '';
  try {
    return new Date(input).toLocaleString();
  } catch {
    return input;
  }
}

function timestamp(input: string): number {
  const ms = Date.parse(input);
  return Number.isNaN(ms) ? 0 : ms;
}

export default function AgentSidebar({
  agents,
  loading,
  error,
  selectedId,
  hidden,
  onSelect,
  onRefresh,
  onCreateAgent,
  isCreating = false,
  onRenameAgent,
  onRequestCollapse,
  onSimulateRecipe,
  showTrainingTab = false,
}: AgentSidebarProps) {
  const { t } = useLanguage();
  const [tab, setTab] = useState<SidebarTab>('agents');
  const [formOpen, setFormOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameSubmitting, setRenameSubmitting] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const [sortColumn, setSortColumn] = useState<SortColumn>('updatedDate');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const handleSort = useCallback((column: SortColumn) => {
    setSortColumn((prevColumn) => {
      if (prevColumn === column) {
        setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
        return prevColumn;
      }
      setSortDirection(column === 'name' ? 'asc' : 'desc');
      return column;
    });
  }, []);

  const sortedAgents = useMemo(() => {
    const sorted = [...agents].sort((a, b) => {
      let comparison = 0;
      switch (sortColumn) {
        case 'name':
          comparison = (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
          break;
        case 'createdDate':
          comparison = timestamp(a.createdAt) - timestamp(b.createdAt);
          break;
        case 'updatedDate':
          comparison = timestamp(a.updatedAt) - timestamp(b.updatedAt);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [agents, sortColumn, sortDirection]);

  const sortArrow = useCallback(
    (column: SortColumn) => (sortColumn === column ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''),
    [sortColumn, sortDirection],
  );

  function openForm() {
    setRenameId(null);
    setRenameDraft('');
    setRenameError(null);
    setNewName('');
    setCreateError(null);
    setFormOpen(true);
  }

  function cancelForm() {
    setFormOpen(false);
    setNewName('');
    setCreateError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) {
      setCreateError(t('agentnodesPage.sidebar.pleaseEnterName'));
      return;
    }
    setCreateError(null);
    const res = await onCreateAgent(trimmed);
    if (!res.ok) {
      setCreateError(res.error ?? t('agentnodesPage.sidebar.createFailed'));
      return;
    }
    setFormOpen(false);
    setNewName('');
  }

  function openRename(agent: AgentFile) {
    setFormOpen(false);
    setNewName('');
    setCreateError(null);
    setRenameId(agent.id);
    setRenameDraft(formatAgentSidebarLabel(agent.name));
    setRenameError(null);
  }

  function cancelRename() {
    setRenameId(null);
    setRenameDraft('');
    setRenameError(null);
    setRenameSubmitting(false);
  }

  useLayoutEffect(() => {
    if (!renameId) return;
    const el = renameInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [renameId]);

  useLayoutEffect(() => {
    if (!formOpen) return;
    inputRef.current?.focus();
  }, [formOpen]);

  useEffect(() => {
    if (!renameId) return;
    if (agents.some((a) => a.id === renameId)) return;
    setRenameId(null);
    setRenameDraft('');
    setRenameError(null);
    setRenameSubmitting(false);
  }, [renameId, agents]);

  const className = `c272-sidebar${hidden ? ' c272-sidebar--hidden' : ''}`;
  return (
    <aside
      className={className}
      data-tour="agent-sidebar"
      aria-label={t('agentnodesPage.sidebar.asideAria')}
      aria-hidden={hidden}
    >
      <div className="c272-sidebar__header">
        <div className="c272-sidebar__tabs" role="tablist" aria-label={t('agentnodesPage.sidebar.tabsAria')}>
          <button
            type="button"
            role="tab"
            id="an-tab-agents"
            aria-selected={tab === 'agents'}
            className={`c272-sidebar__tab${tab === 'agents' ? ' c272-sidebar__tab--active' : ''}`}
            onClick={() => setTab('agents')}
          >
            {t('agentnodesPage.sidebar.tabAgents')}
          </button>
          {showTrainingTab && (
            <button
              type="button"
              role="tab"
              id="an-tab-training"
              aria-selected={tab === 'training'}
              className={`c272-sidebar__tab${tab === 'training' ? ' c272-sidebar__tab--active' : ' c272-sidebar__tab--muted'}`}
              onClick={() => setTab('training')}
            >
              {t('agentnodesPage.sidebar.tabTraining')}
            </button>
          )}
        </div>
        {tab === 'agents' && (
          <button
            type="button"
            className="c272-btn c272-sidebar__refresh-btn"
            onClick={onRefresh}
            disabled={loading}
            aria-label={t('agentnodesPage.sidebar.refreshAria')}
            title={t('agentnodesPage.sidebar.refreshTitle')}
          >
            <RefreshIcon
              className={`c272-sidebar__refresh-icon${loading ? ' c272-spin' : ''}`}
              aria-hidden
            />
          </button>
        )}
      </div>

      {showTrainingTab && tab === 'training' && <RecipesList onSimulateRecipe={onSimulateRecipe} />}

      {tab === 'agents' && error ? (
        <div className="c272-sidebar__error" role="alert">
          {error}
        </div>
      ) : null}

      {tab === 'agents' && !error && !loading && agents.length === 0 ? (
        <div className="c272-sidebar__empty">{t('agentnodesPage.sidebar.empty')}</div>
      ) : null}

      {tab === 'agents' && agents.length > 0 ? (
        <div className="c272-sidebar__sort" role="group" aria-label={t('agentnodesPage.sidebar.sortLabel')}>
          <span className="c272-sidebar__sort-label">{t('agentnodesPage.sidebar.sortLabel')}</span>
          <button
            type="button"
            className={`c272-sidebar__sort-btn${sortColumn === 'name' ? ' c272-sidebar__sort-btn--active' : ''}`}
            onClick={() => handleSort('name')}
          >
            {t('agentnodesPage.sidebar.sortName')}{sortArrow('name')}
          </button>
          <button
            type="button"
            className={`c272-sidebar__sort-btn${sortColumn === 'updatedDate' ? ' c272-sidebar__sort-btn--active' : ''}`}
            onClick={() => handleSort('updatedDate')}
          >
            {t('agentnodesPage.sidebar.sortUpdated')}{sortArrow('updatedDate')}
          </button>
          <button
            type="button"
            className={`c272-sidebar__sort-btn${sortColumn === 'createdDate' ? ' c272-sidebar__sort-btn--active' : ''}`}
            onClick={() => handleSort('createdDate')}
          >
            {t('agentnodesPage.sidebar.sortCreated')}{sortArrow('createdDate')}
          </button>
        </div>
      ) : null}

      {tab === 'agents' && <div className="c272-sidebar__list" role="list">
        {sortedAgents.map((agent) => {
          const isActive = selectedId === agent.id;
          const isRenaming = renameId === agent.id;
          if (isRenaming) {
            return (
              <div
                key={agent.id}
                className={`c272-sidebar__item an-sidebar__item--rename${isActive ? ' c272-sidebar__item--active' : ''}`}
                role="listitem"
              >
                <form
                  className="an-sidebar__rename-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const trimmed = renameDraft.trim();
                    if (!trimmed) {
                      setRenameError(t('agentnodesPage.sidebar.pleaseEnterName'));
                      return;
                    }
                    setRenameSubmitting(true);
                    setRenameError(null);
                    try {
                      const res = await onRenameAgent(agent.id, trimmed);
                      if (res.ok) {
                        cancelRename();
                      } else {
                        setRenameError(res.error ?? t('agentnodesPage.sidebar.renameFailed'));
                      }
                    } finally {
                      setRenameSubmitting(false);
                    }
                  }}
                >
                  <input
                    ref={renameInputRef}
                    className="an-sidebar__rename-input"
                    type="text"
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    disabled={renameSubmitting}
                    maxLength={200}
                    aria-label={t('agentnodesPage.sidebar.agentNameAria')}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        cancelRename();
                        return;
                      }
                      e.stopPropagation();
                    }}
                  />
                  {renameError ? (
                    <span className="an-sidebar-create__error">{renameError}</span>
                  ) : null}
                  <div className="an-sidebar-create__actions">
                    <button
                      type="submit"
                      className="an-sidebar-create__confirm"
                      disabled={renameSubmitting || !renameDraft.trim()}
                    >
                      {renameSubmitting ? t('agentnodesPage.sidebar.saving') : t('agentnodesPage.sidebar.save')}
                    </button>
                    <button
                      type="button"
                      className="an-sidebar-create__cancel"
                      onClick={cancelRename}
                      disabled={renameSubmitting}
                    >
                      {t('agentnodesPage.common.cancel')}
                    </button>
                  </div>
                </form>
              </div>
            );
          }
          return (
            <div
              key={agent.id}
              className={`c272-sidebar__item an-sidebar__agent-tile${isActive ? ' c272-sidebar__item--active' : ''}`}
              role="listitem"
            >
              <div
                className="an-sidebar__agent-tile__main"
                title={formatAgentDisplayName(agent.name)}
                onClick={() => onSelect(agent.id)}
              >
                <button
                  type="button"
                  className="an-sidebar__name-btn"
                  title={formatAgentDisplayName(agent.name)}
                  aria-label={t('agentnodesPage.sidebar.renameAria', {
                    name: formatAgentSidebarLabel(agent.name),
                  })}
                  disabled={renameId !== null}
                  onClick={(e) => {
                    e.stopPropagation();
                    openRename(agent);
                  }}
                >
                  <span className="c272-sidebar__name">
                    {formatAgentSidebarLabel(agent.name)}
                  </span>
                </button>
                <span className="c272-sidebar__meta">
                  {t('agentnodesPage.sidebar.modified', { time: formatDate(agent.updatedAt) })}
                </span>
              </div>
            </div>
          );
        })}
      </div>}

      {}
      {tab === 'agents' && <div className="an-sidebar-create">
        {formOpen ? (
          <form className="an-sidebar-create__form" onSubmit={handleSubmit}>
            <input
              ref={inputRef}
              className="an-sidebar-create__input"
              type="text"
              autoFocus
              placeholder={t('agentnodesPage.sidebar.newAgentPlaceholder')}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              disabled={isCreating}
              maxLength={120}
              aria-label={t('agentnodesPage.sidebar.newAgentNameAria')}
            />
            {createError ? (
              <span className="an-sidebar-create__error">{createError}</span>
            ) : null}
            <div className="an-sidebar-create__actions">
              <button
                type="submit"
                className="an-sidebar-create__confirm"
                disabled={isCreating || !newName.trim()}
              >
                {isCreating ? t('agentnodesPage.sidebar.creating') : t('agentnodesPage.sidebar.create')}
              </button>
              <button
                type="button"
                className="an-sidebar-create__cancel"
                onClick={cancelForm}
                disabled={isCreating}
              >
                {t('agentnodesPage.common.cancel')}
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            className="an-sidebar-create__btn"
            onClick={openForm}
            title={t('agentnodesPage.sidebar.newBlankTitle')}
            aria-label={t('agentnodesPage.sidebar.newBlankAria')}
          >
            <span aria-hidden>+</span>
          </button>
        )}
      </div>}

      {onRequestCollapse ? (
        <button
          type="button"
          className="c272-sidebar__collapse-handle"
          onClick={onRequestCollapse}
          aria-label={t('agentnodesPage.sidebar.hideListAria')}
          title={t('agentnodesPage.sidebar.hideListTitle')}
        >
          ‹
        </button>
      ) : null}
    </aside>
  );
}
