'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import AgentSidebar from '../../../agentnodes/components/AgentSidebar';
import { useAgentNodesData } from '../../../agentnodes/hooks/useAgentNodesData';
import { useLanguage } from '../../../contexts/LanguageContext';
import { useOptionalAgentEditor } from './AgentEditorContext';

const COLLAPSE_KEY = 'agentEditor:sidebarCollapsed';

export default function AgentEditorSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { t } = useLanguage();
  const editor = useOptionalAgentEditor();

  const currentAgentId = decodeURIComponent(
    (pathname ?? '').split('/').filter(Boolean).pop() || '',
  );

  const {
    agentList,
    agentListLoading,
    agentListError,
    refreshAgentList,
    createBlankAgent,
    renameAgent,
    patchAgentListLabel,
  } = useAgentNodesData();

  const [collapsed, setCollapsed] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(window.sessionStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
    }
  }, []);

  const persistCollapsed = useCallback((next: boolean) => {
    setCollapsed(next);
    try {
      window.sessionStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
    } catch {
    }
  }, []);

  const handleSelect = useCallback(
    (id: string) => {
      const view = searchParams?.get('view') === 'graph' ? 'graph' : 'form';
      persistCollapsed(true);
      router.push(`/ai-agents/edit/${encodeURIComponent(id)}?view=${view}`);
    },
    [router, searchParams, persistCollapsed],
  );

  const handleCreate = useCallback(
    async (name: string) => {
      setIsCreating(true);
      try {
        const res = await createBlankAgent(name);
        if (res.ok) {
          await refreshAgentList();
          if (res.fileId) handleSelect(res.fileId);
        }
        return res;
      } finally {
        setIsCreating(false);
      }
    },
    [createBlankAgent, refreshAgentList, handleSelect],
  );

  const handleRename = useCallback(
    async (agentId: string, newName: string) => {
      const trimmed = newName.trim();
      const res = await renameAgent(agentId, trimmed);
      if (res.ok) {
        await refreshAgentList();
        patchAgentListLabel(agentId, trimmed);
        if (agentId === currentAgentId && editor) {
          editor.updateName(trimmed);
        }
      }
      return res;
    },
    [renameAgent, refreshAgentList, patchAgentListLabel, currentAgentId, editor],
  );

  return (
    <>
      <AgentSidebar
        agents={agentList}
        loading={agentListLoading}
        error={agentListError}
        selectedId={currentAgentId || null}
        hidden={collapsed}
        onSelect={handleSelect}
        onRefresh={refreshAgentList}
        onCreateAgent={handleCreate}
        isCreating={isCreating}
        onRenameAgent={handleRename}
        onRequestCollapse={collapsed ? undefined : () => persistCollapsed(true)}
      />
      {collapsed ? (
        <button
          type="button"
          className="c272-reopen-handle"
          aria-label={t('agentnodesPage.view.reopenAgents')}
          title={t('agentnodesPage.view.reopenAgents')}
          onClick={() => persistCollapsed(false)}
        >
          ›
        </button>
      ) : null}
    </>
  );
}
