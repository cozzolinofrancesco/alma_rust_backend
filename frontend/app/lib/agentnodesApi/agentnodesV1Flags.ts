
export function agentnodesV1ApiEnabled(): boolean {
  return typeof process !== 'undefined' && process.env.NEXT_PUBLIC_AGENTNODES_V1 === '1';
}

export function agentnodesGraphServerSyncEnabled(): boolean {
  return (
    agentnodesV1ApiEnabled() ||
    (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_AGENTNODES_SERVER_GRAPH === '1')
  );
}

export function agentnodesV1BasePath(projectId: string): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/agentnodes`;
}
