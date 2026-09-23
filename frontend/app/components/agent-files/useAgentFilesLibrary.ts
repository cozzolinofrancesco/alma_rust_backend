'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentFile } from '../../lib/agentFiles';
import { deleteAgentFileEntry, fetchAgentFileLibrary, saveAgentFile } from '../../lib/agentFilesApi';

export function useAgentFilesLibrary(enabled: boolean, scope: string) {
  const [library, setLibrary] = useState<AgentFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const mutations = useRef(new Set<AbortController>());
  const lifecycle = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    try {
      const files = await fetchAgentFileLibrary(controller.signal);
      if (!controller.signal.aborted) setLibrary(files);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to load files.');
    } finally {
      if (!controller.signal.aborted) { setLoading(false); request.current = null; }
    }
  }, [enabled]);

  useEffect(() => {
    setLibrary([]);
    setLoading(false);
    setError(null);
    void refresh();
    const pending = mutations.current;
    return () => {
      lifecycle.current += 1;
      request.current?.abort();
      pending.forEach(controller => controller.abort());
      pending.clear();
    };
  }, [refresh, scope]);

  const create = useCallback(async (input: File | { sourceId: string }) => {
    const generation = lifecycle.current;
    const controller = new AbortController();
    mutations.current.add(controller);
    try {
      const entry = await saveAgentFile(input, controller.signal);
      if (generation !== lifecycle.current || controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      request.current?.abort();
      setLoading(false);
      setError(null);
      setLibrary(previous => [...previous.filter(file => file.id !== entry.id), entry]);
      return entry;
    } finally { mutations.current.delete(controller); }
  }, []);

  const remove = useCallback(async (id: string) => {
    const generation = lifecycle.current;
    const controller = new AbortController();
    mutations.current.add(controller);
    try {
      await deleteAgentFileEntry(id, controller.signal);
      if (generation !== lifecycle.current || controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      request.current?.abort();
      setLoading(false);
      setError(null);
      setLibrary(previous => previous.filter(file => file.id !== id));
    } finally { mutations.current.delete(controller); }
  }, []);

  return { library, loading, error, refresh, create, remove };
}