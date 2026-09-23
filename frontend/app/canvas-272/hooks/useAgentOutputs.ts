'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from 'next-auth/react';
import { fetchAgentFiles } from '../../lib/api';
import { useProjectState } from '../../components/ProjectStateContext';
import type { AgentFile } from '../../lib/types';
import type { Canvas272Agent, Canvas272Layer, Canvas272SidecarV1 } from '../lib/types';
import {
  fetchDriveSidecar,
  readLocalSidecar,
  saveDriveSidecar,
  updateLocalOutput,
} from '../lib/sidecar';
import { describeLayerOutputFields, getLayerOutputText } from '../lib/layerOutput';

interface LoadedAgent {
  agent: Canvas272Agent;
  sidecarOutputs: Record<string, string>;
}

interface VersionedAgentJson {
  agentName?: string;
  name?: string;
  currentVersion?: string;
  versions?: Array<{ version: string; layers?: Canvas272Layer[] }>;
  layers?: Canvas272Layer[];
  metadata?: Canvas272Agent['metadata'];
}

function extractLayersFromJson(raw: VersionedAgentJson): Canvas272Layer[] {
  if (Array.isArray(raw?.versions) && raw?.currentVersion) {
    const current = raw.versions.find((v) => v.version === raw.currentVersion);
    if (current && Array.isArray(current.layers)) return current.layers;
  }
  if (Array.isArray(raw?.layers)) return raw.layers;
  return [];
}

export function useAgentOutputs() {
  const { data: session, status } = useSession();
  const { projectFolder } = useProjectState();

  const [agentList, setAgentList] = useState<AgentFile[]>([]);
  const [agentListError, setAgentListError] = useState<string | null>(null);
  const [agentListLoading, setAgentListLoading] = useState<boolean>(false);

  const [loaded, setLoaded] = useState<LoadedAgent | null>(null);
  const [loadingAgent, setLoadingAgent] = useState<boolean>(false);
  const [agentError, setAgentError] = useState<string | null>(null);

  const projectId = useMemo(() => projectFolder?.projectId ?? null, [projectFolder?.projectId]);
  const accessToken = useMemo(
    () => (typeof session?.accessToken === 'string' ? session.accessToken : null),
    [session?.accessToken]
  );

  const refreshAgentList = useCallback(async () => {
    if (status === 'loading') return;
    if (!projectId) {
      setAgentList([]);
      setAgentListError('No project selected');
      return;
    }
    if (!accessToken) {
      setAgentList([]);
      setAgentListError('Please sign in to load agents');
      return;
    }
    setAgentListLoading(true);
    setAgentListError(null);
    try {
      const files = await fetchAgentFiles(projectId);
      const filtered = files.filter((f) => !/\.canvas272(\.json)?$/i.test(f.name));
      setAgentList(filtered);
    } catch (err) {
      setAgentList([]);
      setAgentListError(err instanceof Error ? err.message : 'Failed to load agents');
    } finally {
      setAgentListLoading(false);
    }
  }, [projectId, accessToken, status]);

  useEffect(() => {
    refreshAgentList();
  }, [refreshAgentList]);

  const selectAgent = useCallback(
    async (agentId: string) => {
      if (!projectId) {
        setAgentError('No project selected');
        return;
      }
      if (!accessToken) {
        setAgentError('Please sign in to load agent details');
        return;
      }
      setLoadingAgent(true);
      setAgentError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/folders/AF/files/${agentId}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) throw new Error(`Failed to load agent (HTTP ${res.status})`);
        const body = await res.json();

        let raw: VersionedAgentJson;
        if (typeof body?.content === 'string') {
          raw = JSON.parse(body.content);
        } else {
          raw = body as VersionedAgentJson;
        }

        const layers = extractLayersFromJson(raw);
        const agent: Canvas272Agent = {
          id: agentId,
          name: (raw.name || raw.agentName || 'Untitled agent') as string,
          layers,
          metadata: raw.metadata,
        };

        if (process.env.NODE_ENV !== 'production') {
          console.info(
            '[canvas-272] loaded agent',
            agent.name,
            '— layers:',
            layers.length,
            '— top-level keys sample:',
            layers[0] ? Object.keys(layers[0]).slice(0, 20) : [],
          );
          console.table(
            layers.map((l) => ({
              id: l.id,
              name: l.name,
              resolvedLen: getLayerOutputText(l).length,
              ...describeLayerOutputFields(l),
            })),
          );
        }

        const [driveSidecar, localSidecar] = await Promise.all([
          fetchDriveSidecar(projectId, agentId),
          Promise.resolve(readLocalSidecar(projectId, agentId)),
        ]);
        const mergedOutputs: Record<string, string> = {
          ...(driveSidecar?.outputs ?? {}),
          ...(localSidecar?.outputs ?? {}),
        };

        setLoaded({ agent, sidecarOutputs: mergedOutputs });
      } catch (err) {
        setLoaded(null);
        setAgentError(err instanceof Error ? err.message : 'Failed to load agent');
      } finally {
        setLoadingAgent(false);
      }
    },
    [projectId, accessToken]
  );

  const clearSelection = useCallback(() => {
    setLoaded(null);
    setAgentError(null);
  }, []);

  const setOutput = useCallback(
    (layerId: string, value: string) => {
      if (!loaded || !projectId) return;
      const sidecar = updateLocalOutput(projectId, loaded.agent.id, loaded.agent.name, layerId, value);
      setLoaded({ agent: loaded.agent, sidecarOutputs: sidecar.outputs });
    },
    [loaded, projectId]
  );

  const persistToDrive = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (!loaded || !projectId) {
      return { ok: false, error: 'no agent loaded' };
    }
    const sidecar: Canvas272SidecarV1 = {
      version: 1,
      agentId: loaded.agent.id,
      agentName: loaded.agent.name,
      updatedAt: new Date().toISOString(),
      outputs: loaded.sidecarOutputs,
    };
    return saveDriveSidecar(projectId, sidecar);
  }, [loaded, projectId]);

  return {
    agentList,
    agentListLoading,
    agentListError,
    refreshAgentList,
    loaded,
    loadingAgent,
    agentError,
    selectAgent,
    clearSelection,
    setOutput,
    persistToDrive,
  };
}
