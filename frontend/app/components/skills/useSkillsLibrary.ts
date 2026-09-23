'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type Skill,
  type SkillCreateInput,
  type SkillUpdateInput,
  resolveSkillTexts,
  skillsByIdMap,
} from '../../lib/agentSkills';
import { fetchSkills, createSkillApi, updateSkillApi, deleteSkillApi } from '../../lib/skillsApi';

// Shared owner of the global skills library: loads and refreshes it, exposes CRUD that
// keeps local state in sync, and resolves an agent's skillIds to texts. Used by
// both the form and graph editor surfaces so neither duplicates fetching.
export function useSkillsLibrary(enabled: boolean) {
  const [library, setLibrary] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const lifecycleRef = useRef(0);

  const cancelLoad = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = null;
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    cancelLoad();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const skills = await fetchSkills(controller.signal);
      if (!controller.signal.aborted) {
        setLibrary(skills);
      }
    } catch (err: unknown) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Failed to load skills');
      }
    } finally {
      if (!controller.signal.aborted) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }, [enabled, cancelLoad]);

  useEffect(() => {
    if (enabled) {
      void refresh();
    } else {
      setLibrary([]);
      setError(null);
      setLoading(false);
    }
    return () => {
      lifecycleRef.current += 1;
      cancelLoad();
    };
  }, [enabled, refresh, cancelLoad]);

  const create = useCallback(async (input: SkillCreateInput): Promise<Skill> => {
    const lifecycle = lifecycleRef.current;
    const skill = await createSkillApi(input);
    if (lifecycle !== lifecycleRef.current) return skill;
    cancelLoad();
    setLoading(false);
    setError(null);
    setLibrary((prev) => [...prev.filter((existing) => existing.id !== skill.id), skill]);
    return skill;
  }, [cancelLoad]);

  const update = useCallback(async (id: string, patch: SkillUpdateInput): Promise<Skill> => {
    const lifecycle = lifecycleRef.current;
    const skill = await updateSkillApi(id, patch);
    if (lifecycle !== lifecycleRef.current) return skill;
    cancelLoad();
    setLoading(false);
    setError(null);
    setLibrary((prev) => prev.map((s) => (s.id === id ? skill : s)));
    return skill;
  }, [cancelLoad]);

  const remove = useCallback(async (id: string): Promise<void> => {
    const lifecycle = lifecycleRef.current;
    await deleteSkillApi(id);
    if (lifecycle !== lifecycleRef.current) return;
    cancelLoad();
    setLoading(false);
    setError(null);
    setLibrary((prev) => prev.filter((s) => s.id !== id));
  }, [cancelLoad]);

  const skillsById = useMemo(() => skillsByIdMap(library), [library]);

  const resolveTexts = useCallback(
    (skillIds: readonly string[] | undefined): string[] => resolveSkillTexts(skillIds, skillsById),
    [skillsById],
  );

  return { library, loading, error, refresh, create, update, remove, skillsById, resolveTexts };
}

export type SkillsLibrary = ReturnType<typeof useSkillsLibrary>;
