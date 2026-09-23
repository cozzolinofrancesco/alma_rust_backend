'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';

export interface ProjectListItem {
  id: string;
  name: string;
  displayName: string;
}

interface RawProject {
  id?: string | null;
  name?: string | null;
  displayName?: string | null;
}

// Single owner of the Alma Studio left-bar project list. Fetches the same
// `/api/list-projects` endpoint the /projects page uses, but exposes only the
// minimal shape the switcher needs and a `refresh(bustCache)` for post-create
// reloads. Deduped by id so the endpoint's owned+shared merge can't double up.
export function useProjectList() {
  const { status } = useSession();
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    async (bustCache = false) => {
      if (status !== 'authenticated') return;
      setLoading(true);
      setError(null);
      try {
        const path = bustCache
          ? `/api/list-projects?_cacheBust=${Date.now()}`
          : '/api/list-projects';
        const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) {
          throw new Error(`Failed to load projects (${res.status})`);
        }
        const data: { projects?: RawProject[] } = await res.json();

        const seen = new Set<string>();
        const items: ProjectListItem[] = [];
        for (const raw of data.projects ?? []) {
          const id = raw.id ?? '';
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const name = raw.name ?? id;
          items.push({ id, name, displayName: raw.displayName || name });
        }

        setProjects(items);
      } catch (err) {
        setProjects([]);
        setError(err instanceof Error ? err.message : 'Failed to load projects');
      } finally {
        setLoading(false);
      }
    },
    [status],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { projects, loading, error, refresh };
}
