
'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  ReportCreationSessionManifest,
  SessionListEntry,
  UpdateSessionPayload,
  ReportCreationStage,
  DriveFileSelection,
} from '../reportCreation/sessionTypes';

export interface StartJobParams {
  stage: 'clinical_corpus' | 'clinical_summary' | 'biomaterial_corpus' | 'biomaterial_summary';
  jobId: string;
  corpusId?: string;
}

export interface UseReportCreationSessionReturn {
  session: ReportCreationSessionManifest | null;
  loading: boolean;
  error: string | null;
  recentSessions: SessionListEntry[];
  createSession: (projectId: string, sessionName: string) => Promise<ReportCreationSessionManifest | null>;
  loadSession: (
    projectId: string,
    sessionId: string,
    options?: { reconcile?: boolean }
  ) => Promise<ReportCreationSessionManifest | null>;
  probeSession: (projectId: string, sessionId: string) => Promise<boolean>;
  listSessions: (projectId: string) => Promise<SessionListEntry[]>;
  bindJob: (projectId: string, params: StartJobParams) => Promise<void>;
  patchSession: (projectId: string, update: UpdateSessionPayload) => Promise<void>;
  saveClinicalFiles: (
    projectId: string,
    files: DriveFileSelection[],
    corpusMode: 'new' | 'existing',
    corpusName: string
  ) => Promise<void>;
  saveBiomaterialFiles: (
    projectId: string,
    files: DriveFileSelection[],
    corpusMode: 'new' | 'existing',
    corpusName: string
  ) => Promise<void>;
  advanceStage: (projectId: string, stage: ReportCreationStage) => Promise<void>;
  deleteSession: (projectId: string, sessionId: string) => Promise<void>;
  clearSession: () => void;
}

export function useReportCreationSession(): UseReportCreationSessionReturn {
  const [session, setSession] = useState<ReportCreationSessionManifest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentSessions, setRecentSessions] = useState<SessionListEntry[]>([]);

  const sessionRef = useRef<ReportCreationSessionManifest | null>(null);
  sessionRef.current = session;

  const sessionReadyResolveRef = useRef<((m: ReportCreationSessionManifest | null) => void) | null>(null);
  const sessionReadyPromiseRef = useRef<Promise<ReportCreationSessionManifest | null>>(
    Promise.resolve(null)
  );

  const handleResponse = useCallback(async <T>(res: Response): Promise<T | null> => {
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      const msg = body.error ?? `Request failed (${res.status})`;
      setError(msg);
      return null;
    }
    setError(null);
    return (await res.json()) as T;
  }, []);

  const createSession = useCallback(
    async (projectId: string, sessionName: string): Promise<ReportCreationSessionManifest | null> => {
      sessionReadyPromiseRef.current = new Promise<ReportCreationSessionManifest | null>((resolve) => {
        sessionReadyResolveRef.current = resolve;
      });
      setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/ai-agents/report-creation/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ projectId, sessionName }),
        });
        const data = await handleResponse<{ session: ReportCreationSessionManifest }>(res);
        if (data) {
          setSession(data.session);
          sessionRef.current = data.session;
          sessionReadyResolveRef.current?.(data.session);
          return data.session;
        }
        sessionReadyResolveRef.current?.(null);
        return null;
      } catch (err) {
        sessionReadyResolveRef.current?.(null);
        const msg = err instanceof Error ? err.message : 'Failed to create session';
        setError(msg);
        console.warn('[useReportCreationSession] createSession failed:', msg);
        return null;
      } finally {
        setLoading(false);
        sessionReadyResolveRef.current = null;
      }
    },
    [handleResponse]
  );

  const loadSession = useCallback(
    async (
      projectId: string,
      sessionId: string,
      options?: { reconcile?: boolean }
    ): Promise<ReportCreationSessionManifest | null> => {
      const reconcile = options?.reconcile !== false;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/ai-agents/report-creation/sessions/${sessionId}?projectId=${encodeURIComponent(projectId)}&reconcile=${reconcile}`,
          { credentials: 'include' }
        );
        const data = await handleResponse<{ session: ReportCreationSessionManifest }>(res);
        if (data) {
          setSession(data.session);
          sessionRef.current = data.session;
          return data.session;
        }
        return null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to load session';
        setError(msg);
        console.warn('[useReportCreationSession] loadSession failed:', msg);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [handleResponse]
  );

  const probeSession = useCallback(async (projectId: string, sessionId: string): Promise<boolean> => {
    try {
      const res = await fetch(
        `/api/ai-agents/report-creation/sessions/${sessionId}?projectId=${encodeURIComponent(projectId)}&reconcile=false`,
        { credentials: 'include' }
      );
      return res.ok;
    } catch {
      return false;
    }
  }, []);

  const listSessions = useCallback(
    async (projectId: string): Promise<SessionListEntry[]> => {
      try {
        const res = await fetch(
          `/api/ai-agents/report-creation/sessions?projectId=${encodeURIComponent(projectId)}`,
          { credentials: 'include' }
        );
        const data = await handleResponse<{ sessions: SessionListEntry[] }>(res);
        const sessions = data?.sessions ?? [];
        setRecentSessions(sessions);
        return sessions;
      } catch {
        return [];
      }
    },
    [handleResponse]
  );

  const bindJob = useCallback(
    async (projectId: string, params: StartJobParams): Promise<void> => {
      const current = sessionRef.current;
      if (!current) return;
      try {
        const res = await fetch(
          `/api/ai-agents/report-creation/sessions/${current.sessionId}/start?projectId=${encodeURIComponent(projectId)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(params),
          }
        );
        const data = await handleResponse<{ session: ReportCreationSessionManifest }>(res);
        if (data) {
          setSession(data.session);
        }
      } catch (err) {
        console.error('[useReportCreationSession] bindJob failed:', err);
      }
    },
    [handleResponse]
  );

  const patchSession = useCallback(
    async (projectId: string, update: UpdateSessionPayload): Promise<void> => {
      await sessionReadyPromiseRef.current;
      const current = sessionRef.current;
      if (!current) return;
      try {
        const res = await fetch(
          `/api/ai-agents/report-creation/sessions/${current.sessionId}?projectId=${encodeURIComponent(projectId)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(update),
          }
        );
        const data = await handleResponse<{ session: ReportCreationSessionManifest }>(res);
        if (data) {
          setSession(data.session);
          sessionRef.current = data.session;
        }
      } catch (err) {
        console.error('[useReportCreationSession] patchSession failed:', err);
      }
    },
    [handleResponse]
  );

  const saveClinicalFiles = useCallback(
    async (
      projectId: string,
      files: DriveFileSelection[],
      corpusMode: 'new' | 'existing',
      corpusName: string
    ): Promise<void> => {
      await patchSession(projectId, {
        clinical: { selectedFiles: files, corpusMode, corpusName },
      });
    },
    [patchSession]
  );

  const saveBiomaterialFiles = useCallback(
    async (
      projectId: string,
      files: DriveFileSelection[],
      corpusMode: 'new' | 'existing',
      corpusName: string
    ): Promise<void> => {
      await patchSession(projectId, {
        biomaterial: { selectedFiles: files, corpusMode, corpusName },
      });
    },
    [patchSession]
  );

  const advanceStage = useCallback(
    async (projectId: string, stage: ReportCreationStage): Promise<void> => {
      await patchSession(projectId, {
        currentStage: stage,
        lastCompletedStage: sessionRef.current?.currentStage,
      });
    },
    [patchSession]
  );

  const deleteSession = useCallback(
    async (projectId: string, sessionId: string): Promise<void> => {
      const res = await fetch(
        `/api/ai-agents/report-creation/sessions/${sessionId}?projectId=${encodeURIComponent(projectId)}`,
        { method: 'DELETE', credentials: 'include' }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Delete failed (${res.status})`);
      }
      setRecentSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
      if (sessionRef.current?.sessionId === sessionId) {
        setSession(null);
        sessionRef.current = null;
      }
    },
    []
  );

  const clearSession = useCallback(() => {
    setSession(null);
    setError(null);
  }, []);

  return useMemo(
    (): UseReportCreationSessionReturn => ({
      session,
      loading,
      error,
      recentSessions,
      createSession,
      loadSession,
      probeSession,
      listSessions,
      bindJob,
      patchSession,
      saveClinicalFiles,
      saveBiomaterialFiles,
      advanceStage,
      deleteSession,
      clearSession,
    }),
    [
      session,
      loading,
      error,
      recentSessions,
      createSession,
      loadSession,
      probeSession,
      listSessions,
      bindJob,
      patchSession,
      saveClinicalFiles,
      saveBiomaterialFiles,
      advanceStage,
      deleteSession,
      clearSession,
    ]
  );
}
