'use client';

import { useRouter } from 'next/navigation';
import { useAgentNodesData } from '../agentnodes/hooks/useAgentNodesData';
import WorkspaceNav from './WorkspaceNav';
import '../canvas-272/style.css';
import './workspace.css';

export default function AgentWorkspaceIndexPage() {
  const router = useRouter();
  const { agentList, agentListLoading, agentListError } = useAgentNodesData();

  const openAgent = (agentId: string) => {
    router.push(`/agent-workspace/${encodeURIComponent(agentId)}?view=output`);
  };

  return (
    <div className="aw-bg">
      <div className="aw-card aw-card--main">
        <WorkspaceNav
          agents={agentList}
          loading={agentListLoading}
          error={agentListError}
          selectedId={null}
          onSelect={openAgent}
        />
        <main className="aw-center">
          <div className="aw-center__body">
            <div className="aw-state">Select an agent to open its workspace.</div>
          </div>
        </main>
      </div>
    </div>
  );
}
