'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { fetchAgentFiles } from '../../lib/api';
import {
  agentnodesV1ApiEnabled,
  v1AutoSaveAgent,
  v1CreateBlankAgent,
  v1GetAgentRaw,
  v1ListAgents,
  v1PostNewVersion,
  v1RenameAgent,
} from '../../lib/agentnodesApi/agentnodesV1Client';
import { useProjectState } from '../../components/ProjectStateContext';
import { syncAgentRenameAcrossStores } from '../../lib/recentItemsManager';
import type { AgentFile } from '../../lib/types';
import type { Canvas272Agent, Canvas272Layer } from '../../canvas-272/lib/types';
import { createDefaultLayer } from '../../lib/agentLayer';
import { applyAgentLayerPatch } from '../../lib/agentOutputHistory';
import { persistAgentInputs } from '../../lib/agentFilesApi';
import { normalizeAgentInputMetadata, type AgentInputMetadata } from '../../lib/agentFiles';
import {
  isSynthesisReportLayer,
  resolveLayerCorpusId,
  stripSynthesisClinicalCorpusBinding,
} from '../lib/corpus';

interface VersionedAgentJson {
  agentName?: string;
  name?: string;
  currentVersion?: string;
  versions?: Array<{ version: string; layers?: Canvas272Layer[] }>;
  layers?: Canvas272Layer[];
  metadata?: Canvas272Agent['metadata'];
}

function extractLayers(raw: VersionedAgentJson): Canvas272Layer[] {
  if (Array.isArray(raw?.versions) && raw?.currentVersion) {
    const current = raw.versions.find((v) => v.version === raw.currentVersion);
    if (current && Array.isArray(current.layers)) return current.layers;
  }
  if (Array.isArray(raw?.layers)) return raw.layers;
  return [];
}

export function useAgentNodesData() {
  const { data: session, status } = useSession();
  const { projectFolder } = useProjectState();

  const [agentList, setAgentList] = useState<AgentFile[]>([]);
  const [agentListError, setAgentListError] = useState<string | null>(null);
  const [agentListLoading, setAgentListLoading] = useState<boolean>(false);

  const [loadedAgent, setLoadedAgent] = useState<Canvas272Agent | null>(null);
  const loadedAgentRef = useRef<Canvas272Agent | null>(null);
  useEffect(() => { loadedAgentRef.current = loadedAgent; }, [loadedAgent]);
  const [loadingAgent, setLoadingAgent] = useState<boolean>(false);
  const [agentError, setAgentError] = useState<string | null>(null);

  const projectId = useMemo(
    () => projectFolder?.projectId ?? null,
    [projectFolder?.projectId],
  );
  const accessToken = useMemo(
    () => (typeof session?.accessToken === 'string' ? session.accessToken : null),
    [session?.accessToken],
  );

  const refreshAgentList = useCallback(async () => {
    if (status === 'loading') return;
    if (!projectId) {
      setAgentList([]);
      setAgentListError('No project selected');
      return;
    }

    if (agentnodesV1ApiEnabled()) {
      if (status !== 'authenticated') {
        setAgentList([]);
        setAgentListError('Please sign in to load agents');
        return;
      }
      setAgentListLoading(true);
      setAgentListError(null);
      try {
        const files = await v1ListAgents(projectId);
        setAgentList(files);
      } catch (err) {
        setAgentList([]);
        setAgentListError(err instanceof Error ? err.message : 'Failed to load agents');
      } finally {
        setAgentListLoading(false);
      }
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
      const filtered = files.filter(
        (f) => !/\.canvas272(\.json)?$/i.test(f.name),
      );
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
      if (!projectId) { setAgentError('No project selected'); return; }
      if (!agentnodesV1ApiEnabled() && !accessToken) { setAgentError('Please sign in to load agent details'); return; }
      if (agentnodesV1ApiEnabled() && status !== 'authenticated') {
        setAgentError('Please sign in to load agent details');
        return;
      }
      setLoadingAgent(true);
      setAgentError(null);
      try {
        let raw: VersionedAgentJson;
        if (agentnodesV1ApiEnabled()) {
          raw = (await v1GetAgentRaw(projectId, agentId)) as VersionedAgentJson;
        } else {
          const res = await fetch(
            `/api/projects/${projectId}/folders/AF/files/${agentId}`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
          );
          if (!res.ok) throw new Error(`Failed to load agent (HTTP ${res.status})`);
          const body = await res.json();
          raw =
            typeof body?.content === 'string' ? JSON.parse(body.content) : body;
        }
        const layers = extractLayers(raw);
        const versions = Array.isArray(raw.versions)
          ? raw.versions.map((v) => v.version).filter(Boolean)
          : undefined;
        let mutated = false;
        const strippedLayers = layers.map((l) => {
          const { layer: next, changed } = stripSynthesisClinicalCorpusBinding(l);
          if (changed) mutated = true;
          return next;
        });
        const healedLayers = strippedLayers.map((l) => {
          if (isSynthesisReportLayer(l)) return l;
          if (l.corpusId) return l;
          const resolved = resolveLayerCorpusId(l);
          if (!resolved) return l;
          mutated = true;
          return { ...l, corpusId: resolved };
        });
        const agent: Canvas272Agent = {
          id: agentId,
          name: (raw.name || raw.agentName || 'Untitled agent') as string,
          layers: mutated ? healedLayers : layers,
          currentVersion: raw.currentVersion,
          versions,
          metadata: { ...raw.metadata, ...normalizeAgentInputMetadata(raw.metadata) },
        };
        setLoadedAgent(agent);
      } catch (err) {
        setLoadedAgent(null);
        setAgentError(err instanceof Error ? err.message : 'Failed to load agent');
      } finally {
        setLoadingAgent(false);
      }
    },
    [projectId, accessToken, status],
  );

  const clearSelection = useCallback(() => {
    setLoadedAgent(null);
    setAgentError(null);
  }, []);

  const patchAgentListLabel = useCallback((fileId: string, displayName: string) => {
    setAgentList((prev) =>
      prev.map((f) => (f.id === fileId ? { ...f, name: displayName } : f)),
    );
  }, []);

  const updateLayer = useCallback(
    (layerId: string, patch: Partial<Canvas272Layer>) => {
      const timestamp = new Date().toISOString();
      setLoadedAgent((prev) => {
        if (!prev) return prev;
        const next: Canvas272Agent = {
          ...prev,
          layers: prev.layers.map(layer => layer.id === layerId ? applyAgentLayerPatch(layer, patch, timestamp) : layer),
        };
        loadedAgentRef.current = next;
        return next;
      });
    },
    [],
  );

  const addLayer = useCallback(
    (layerId: string, title: string) => {
      setLoadedAgent((prev) => {
        if (!prev) return prev;
        const newLayer = createDefaultLayer(layerId, title, prev.layers.length) as unknown as Canvas272Layer;
        const next: Canvas272Agent = {
          ...prev,
          layers: prev.layers.concat(newLayer),
        };
        loadedAgentRef.current = next;
        return next;
      });
    },
    [],
  );

  const removeLayer = useCallback(
    (layerId: string) => {
      setLoadedAgent((prev) => {
        if (!prev) return prev;
        const next: Canvas272Agent = {
          ...prev,
          layers: prev.layers
            .filter((l) => l.id !== layerId)
            .map((l) => ({
              ...l,
              referencedSteps: (l.referencedSteps ?? []).filter((id) => id !== layerId),
            })),
        };
        loadedAgentRef.current = next;
        return next;
      });
    },
    [],
  );

  const updateSkillIds = useCallback(
    (skillIds: string[]) => {
      setLoadedAgent((prev) => {
        if (!prev) return prev;
        const next: Canvas272Agent = {
          ...prev,
          metadata: { ...prev.metadata, skillIds },
        };
        loadedAgentRef.current = next;
        return next;
      });
      const agentId = loadedAgentRef.current?.id;
      if (projectId && agentId) {
        import('../../lib/agentSkillsPersistence')
          .then(({ persistAgentSkillIds }) => persistAgentSkillIds(projectId, agentId, skillIds))
          .catch((err) => console.error('Failed to persist agent skills:', err));
      }
    },
    [projectId],
  );

  const updateInputs = useCallback(async (metadata: AgentInputMetadata) => {
    const current = loadedAgentRef.current;
    if (!projectId || !current) throw new Error('Select a saved agent and project first.');
    await persistAgentInputs(projectId, current.id, metadata);
    setLoadedAgent(prev => {
      if (!prev || prev.id !== current.id) return prev;
      const next = { ...prev, metadata: { ...prev.metadata, ...metadata } };
      loadedAgentRef.current = next;
      return next;
    });
  }, [projectId]);

  const saveAgent = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (!projectId) return { ok: false, error: 'No project selected' };
    const agent = loadedAgentRef.current;
    if (!agent) return { ok: false, error: 'No agent loaded' };
    try {
      if (agentnodesV1ApiEnabled()) {
        const { currentVersion } = await v1PostNewVersion(projectId, agent.id, {
          name: agent.name,
          layers: agent.layers,
          metadata: agent.metadata,
        });
        if (currentVersion) {
          setLoadedAgent((prev) => {
            if (!prev) return prev;
            const versions = prev.versions
              ? Array.from(new Set([...prev.versions, currentVersion]))
              : [currentVersion];
            return { ...prev, currentVersion, versions };
          });
        }
        return { ok: true };
      }
      const { saveAgentWithVersioning } = await import('../../lib/versionUtils');
      const res = await saveAgentWithVersioning(
        projectId,
        agent.name,
        agent as unknown as Parameters<typeof saveAgentWithVersioning>[2],
        agent.id,
      );
      if (!res.success) return { ok: false, error: res.error ?? 'Save failed' };
      if (res.versionId) {
        setLoadedAgent((prev) => {
          if (!prev) return prev;
          const versions = prev.versions
            ? Array.from(new Set([...prev.versions, res.versionId!]))
            : [res.versionId!];
          return { ...prev, currentVersion: res.versionId, versions };
        });
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Save failed' };
    }
  }, [projectId]);

  const autoSaveAgent = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (!projectId) return { ok: false, error: 'No project selected' };
    const agent = loadedAgentRef.current;
    if (!agent) return { ok: false, error: 'No agent loaded' };
    try {
      if (agentnodesV1ApiEnabled()) {
        const timestamp = new Date().toISOString();
        const agentToSave = { ...agent, metadata: { ...(agent.metadata ?? {}), modified: timestamp } };
        await v1AutoSaveAgent(projectId, agentToSave);
        return { ok: true };
      }
      const { updateAgentSameVersionByFileId } = await import('../../lib/versionUtils');
      const timestamp = new Date().toISOString();
      const agentToSave = { ...agent, metadata: { ...(agent.metadata ?? {}), modified: timestamp } };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await updateAgentSameVersionByFileId(projectId, agent.id, agentToSave as unknown as any);
      if (!res.success) return { ok: false, error: res.error ?? 'Autosave failed' };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Autosave failed' };
    }
  }, [projectId]);

  const createBlankAgent = useCallback(
    async (name: string): Promise<{ ok: boolean; fileId?: string; error?: string }> => {
      if (!projectId) return { ok: false, error: 'No project selected' };
      const trimmed = name.trim();
      if (!trimmed) return { ok: false, error: 'Name cannot be empty' };
      try {
        const { createAgent, checkAgentNameExists } = await import('../../lib/versionUtils');

        if (agentnodesV1ApiEnabled()) {
          // Reject duplicate names on create (the v1 server path otherwise
          // wouldn't surface this consistently with the form create flow).
          const dup = await checkAgentNameExists(projectId, trimmed);
          if (dup.exists) return { ok: false, error: `An agent named "${trimmed}" already exists` };
          const { fileId } = await v1CreateBlankAgent(projectId, trimmed);
          return { ok: true, fileId };
        }

        const timestamp = new Date().toISOString();
        // Graph "blank" agent: no default step (empty layers), unlike the form
        // create flow. createAgent sanitizes the name and rejects duplicates.
        const agentData = {
          version: '1.0.0',
          name: trimmed,
          layers: [],
          metadata: { created: timestamp, modified: timestamp, description: '', notes: [] },
        };
        const res = await createAgent(projectId, trimmed, agentData);
        if (!res.success) return { ok: false, error: res.error ?? 'Failed to create agent' };

        if (typeof window !== 'undefined') {
          const cacheKeys = Object.keys(window.localStorage).filter(key => key.startsWith('agents_cache_'));
          cacheKeys.forEach(key => window.localStorage.removeItem(key));
          window.dispatchEvent(new CustomEvent('agents-cache-invalidated'));
        }

        return { ok: true, fileId: res.fileId };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Failed to create agent' };
      }
    },
    [projectId],
  );

  const renameAgent = useCallback(
    async (fileId: string, newName: string): Promise<{ ok: boolean; error?: string }> => {
      if (!projectId) return { ok: false, error: 'No project selected' };
      const trimmed = newName.trim();
      if (!trimmed) return { ok: false, error: 'Name cannot be empty' };
      try {
        if (agentnodesV1ApiEnabled()) {
          const cur = loadedAgentRef.current;
          if (cur?.id === fileId) {
            if (cur.name.trim() === trimmed) return { ok: true };
            const timestamp = new Date().toISOString();
            await v1AutoSaveAgent(projectId, {
              ...cur,
              name: trimmed,
              metadata: { ...(cur.metadata ?? {}), modified: timestamp },
            });
            setLoadedAgent((prev) => (prev && prev.id === fileId ? { ...prev, name: trimmed } : prev));
            syncAgentRenameAcrossStores(fileId, trimmed);
            return { ok: true };
          }
          await v1RenameAgent(projectId, fileId, trimmed);
          syncAgentRenameAcrossStores(fileId, trimmed);
          return { ok: true };
        }

        const {
          updateAgentSameVersionByFileId,
          loadExistingAgentFile,
          isVersionedAgent,
          getCurrentVersionLayers,
        } = await import('../../lib/versionUtils');

        if (loadedAgent?.id === fileId) {
          if (loadedAgent.name.trim() === trimmed) return { ok: true };
          const timestamp = new Date().toISOString();
          const agentToSave = {
            ...loadedAgent,
            name: trimmed,
            metadata: { ...(loadedAgent.metadata ?? {}), modified: timestamp },
          };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const res = await updateAgentSameVersionByFileId(projectId, fileId, agentToSave as any);
          if (!res.success) return { ok: false, error: res.error ?? 'Rename failed' };

          const renameRes = await fetch(`/api/projects/${projectId}/files/${fileId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: trimmed }),
          });
          if (!renameRes.ok) {
            const renameErr = await renameRes.json();
            return { ok: false, error: renameErr.error ?? 'Failed to rename physical file' };
          }

          syncAgentRenameAcrossStores(fileId, trimmed);
          setLoadedAgent((prev) => (prev && prev.id === fileId ? { ...prev, name: trimmed } : prev));
          return { ok: true };
        }

        const existing = await loadExistingAgentFile(projectId, fileId);
        if (!existing) return { ok: false, error: 'Failed to load agent' };

        if (isVersionedAgent(existing)) {
          if (String(existing.agentName).trim() === trimmed) return { ok: true };
        } else {
          const leg = existing as { name: string };
          if (String(leg.name).trim() === trimmed) return { ok: true };
        }

        const layers = isVersionedAgent(existing)
          ? getCurrentVersionLayers(existing)
          : (existing as { layers: Canvas272Layer[] }).layers;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const agentData: any = { name: trimmed, layers };
        const res = await updateAgentSameVersionByFileId(projectId, fileId, agentData);
        if (!res.success) return { ok: false, error: res.error ?? 'Rename failed' };

        const renameRes = await fetch(`/api/projects/${projectId}/files/${fileId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        });
        if (!renameRes.ok) {
          const renameErr = await renameRes.json();
          return { ok: false, error: renameErr.error ?? 'Failed to rename physical file' };
        }

        syncAgentRenameAcrossStores(fileId, trimmed);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Rename failed' };
      }
    },
    [projectId, loadedAgent],
  );

  return {
    projectId,
    agentList,
    agentListLoading,
    agentListError,
    refreshAgentList,
    loadedAgent,
    loadingAgent,
    agentError,
    selectAgent,
    clearSelection,
    updateLayer,
    addLayer,
    removeLayer,
    updateSkillIds,
    updateInputs,
    saveAgent,
    autoSaveAgent,
    createBlankAgent,
    renameAgent,
    patchAgentListLabel,
  };
}
