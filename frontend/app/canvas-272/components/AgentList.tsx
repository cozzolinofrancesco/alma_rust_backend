'use client';

import { RefreshIcon } from '@heroicons/react/outline';
import { ChevronLeft } from 'lucide-react';
import { FaShareAlt } from 'react-icons/fa';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentFile } from '../../lib/types';
import { useLanguage } from '../../contexts/LanguageContext';
import { formatAgentDisplayName, formatAgentSidebarLabel } from '../lib/agentDisplayName';
import { listLocalDraftsForProject, type Canvas272DraftSummary } from '../lib/sidecar';
import RecipesList, { type Recipe } from './RecipesList';

type SidebarTab = 'agents' | 'drafts' | 'recipes';
type SortColumn = 'name' | 'updatedDate' | 'createdDate';
type SortDirection = 'asc' | 'desc';

interface AgentListProps {
  projectId: string | null;
  agents: AgentFile[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  hidden: boolean;
  onSelect: (agentId: string) => void;
  onRefresh: () => void;
  onShare?: (agent: AgentFile) => void;
  onRequestCollapse?: () => void;
  onSimulateRecipe?: (recipe: Recipe) => void;
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

export default function AgentList({
  projectId,
  agents,
  loading,
  error,
  selectedId,
  hidden,
  onSelect,
  onRefresh,
  onShare,
  onRequestCollapse,
  onSimulateRecipe,
}: AgentListProps) {
  const { t } = useLanguage();
  const [tab, setTab] = useState<SidebarTab>('agents');
  const [drafts, setDrafts] = useState<Canvas272DraftSummary[]>([]);
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

  const reloadDrafts = useCallback(() => {
    if (!projectId) {
      setDrafts([]);
      return;
    }
    setDrafts(listLocalDraftsForProject(projectId));
  }, [projectId]);

  useEffect(() => {
    if (tab !== 'drafts' || hidden) return;
    reloadDrafts();
  }, [tab, hidden, reloadDrafts]);

  const className = `c272-sidebar${hidden ? ' c272-sidebar--hidden' : ''}`;
  return (
    <aside className={className} aria-label={t('canvas272Page.sidebarLabel')} aria-hidden={hidden}>
      <div className="c272-sidebar__header">
        <div
          className="c272-sidebar__tabs"
          role="tablist"
          aria-label={t('canvas272Page.sidebarSection')}
        >
          <button
            type="button"
            role="tab"
            id="c272-tab-agents"
            aria-selected={tab === 'agents'}
            className={`c272-sidebar__tab${tab === 'agents' ? ' c272-sidebar__tab--active' : ''}`}
            onClick={() => setTab('agents')}
          >
            {t('canvas272Page.tabAgents')}
          </button>
          <button
            type="button"
            role="tab"
            id="c272-tab-drafts"
            aria-selected={tab === 'drafts'}
            className={`c272-sidebar__tab${tab === 'drafts' ? ' c272-sidebar__tab--active' : ''}`}
            onClick={() => setTab('drafts')}
          >
            {t('canvas272Page.tabDrafts')}
          </button>
          <button
            type="button"
            role="tab"
            id="c272-tab-recipes"
            aria-selected={tab === 'recipes'}
            className={`c272-sidebar__tab${tab === 'recipes' ? ' c272-sidebar__tab--active' : ''}`}
            onClick={() => setTab('recipes')}
          >
            {t('canvas272Page.tabRecipes')}
          </button>
        </div>
        {tab !== 'recipes' && (
          <button
            type="button"
            className="c272-btn c272-sidebar__refresh-btn"
            onClick={() => {
              if (tab === 'agents') onRefresh();
              else reloadDrafts();
            }}
            disabled={tab === 'agents' && loading}
            aria-label={tab === 'agents' ? t('canvas272Page.refreshAgents') : t('canvas272Page.refreshDrafts')}
            title={tab === 'agents' ? t('canvas272Page.refreshAgents') : t('canvas272Page.refreshDrafts')}
          >
            <RefreshIcon
              className={`c272-sidebar__refresh-icon${tab === 'agents' && loading ? ' c272-spin' : ''}`}
              aria-hidden
            />
          </button>
        )}
      </div>

      {tab === 'agents' && (
        <>
          {error ? (
            <div className="c272-sidebar__error" role="alert">
              {error}
            </div>
          ) : null}

          {!error && !loading && agents.length === 0 ? (
            <div className="c272-sidebar__empty">{t('canvas272Page.noAgents')}</div>
          ) : null}

          {agents.length > 0 ? (
            <div className="c272-sidebar__sort" role="group" aria-label={t('canvas272Page.sortLabel')}>
              <span className="c272-sidebar__sort-label">{t('canvas272Page.sortLabel')}</span>
              <button
                type="button"
                className={`c272-sidebar__sort-btn${sortColumn === 'name' ? ' c272-sidebar__sort-btn--active' : ''}`}
                onClick={() => handleSort('name')}
              >
                {t('canvas272Page.sortName')}{sortArrow('name')}
              </button>
              <button
                type="button"
                className={`c272-sidebar__sort-btn${sortColumn === 'updatedDate' ? ' c272-sidebar__sort-btn--active' : ''}`}
                onClick={() => handleSort('updatedDate')}
              >
                {t('canvas272Page.sortUpdated')}{sortArrow('updatedDate')}
              </button>
              <button
                type="button"
                className={`c272-sidebar__sort-btn${sortColumn === 'createdDate' ? ' c272-sidebar__sort-btn--active' : ''}`}
                onClick={() => handleSort('createdDate')}
              >
                {t('canvas272Page.sortCreated')}{sortArrow('createdDate')}
              </button>
            </div>
          ) : null}

          <div
            className="c272-sidebar__list"
            role="tabpanel"
            id="c272-panel-agents"
            aria-labelledby="c272-tab-agents"
          >
            {sortedAgents.map((agent) => {
              const isActive = selectedId === agent.id;
              return (
                <div
                  key={agent.id}
                  className={`c272-sidebar__item${isActive ? ' c272-sidebar__item--active' : ''}`}
                >
                  <button
                    type="button"
                    className="c272-sidebar__item-main"
                    onClick={() => onSelect(agent.id)}
                    title={formatAgentDisplayName(agent.name)}
                  >
                    <span className="c272-sidebar__name">{formatAgentSidebarLabel(agent.name)}</span>
                    <span className="c272-sidebar__meta">{t('canvas272Page.modified', { date: formatDate(agent.updatedAt) })}</span>
                  </button>
                  {onShare ? (
                    <button
                      type="button"
                      className="c272-sidebar__share-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onShare(agent);
                      }}
                      aria-label={t('canvas272Page.shareAgent')}
                      title={t('canvas272Page.shareAgent')}
                    >
                      <FaShareAlt size={13} aria-hidden />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      )}

      {tab === 'drafts' && (
        <>
          {!projectId ? (
            <div className="c272-sidebar__empty">{t('canvas272Page.selectProjectDrafts')}</div>
          ) : drafts.length === 0 ? (
            <div className="c272-sidebar__empty">
              {t('canvas272Page.noDrafts')}
            </div>
          ) : null}

          <div
            className="c272-sidebar__list"
            role="tabpanel"
            id="c272-panel-drafts"
            aria-labelledby="c272-tab-drafts"
          >
            {drafts.map((d) => {
              const isActive = selectedId === d.agentId;
              return (
                <button
                  type="button"
                  key={d.agentId}
                  className={`c272-sidebar__item${isActive ? ' c272-sidebar__item--active' : ''}`}
                  onClick={() => onSelect(d.agentId)}
                  title={formatAgentDisplayName(d.agentName)}
                >
                  <span className="c272-sidebar__name">{formatAgentSidebarLabel(d.agentName)}</span>
                  <span className="c272-sidebar__meta">
                    {d.editedStepCount === 1
                      ? t('canvas272Page.editedStepSingle', { n: d.editedStepCount })
                      : t('canvas272Page.editedStepPlural', { n: d.editedStepCount })}
                    {d.updatedAt ? ` · ${formatDate(d.updatedAt)}` : ''}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}

      {tab === 'recipes' && <RecipesList onSimulateRecipe={onSimulateRecipe} />}

      {onRequestCollapse ? (
        <button
          type="button"
          className="c272-sidebar__collapse-handle"
          onClick={onRequestCollapse}
          aria-label={t('canvas272Page.hideAgentsList')}
          title={t('canvas272Page.hideAgentsList')}
        >
          <ChevronLeft size={16} aria-hidden />
        </button>
      ) : null}
    </aside>
  );
}
