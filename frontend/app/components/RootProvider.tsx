'use client';

import React, { ReactNode, createContext, useContext, useMemo, useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { SessionProvider, useSession } from "next-auth/react";
import type { Session } from 'next-auth';
import AutoRefreshToken from "./AutoRefreshToken";
import { LanguageProvider } from '../contexts/LanguageContext';
import { AppBusyProvider } from '../contexts/AppBusyContext';
import JaLocaleWelcomeModal from './JaLocaleWelcomeModal';
import { ThemeProvider } from '../contexts/ThemeContext';
import { MagnifierProvider } from '../contexts/MagnifierContext';

import { Project } from '../lib/types';
import { createSessionRefresher, readBrowserSession, SessionRefreshCancelledError, SessionRequestError } from '../lib/clientSession';

interface ProjectFolder {
  projectId: string;
  folderName: string;
  folderId?: string;
  files?: Array<{ id: string; name: string; size: number; type: string }>;
}

interface UserInfo {
  id: string;
  email: string;
  name: string;
}

interface Extract {
  fileId: string;
  fileName: string;
  pageNumber: string;
  content: string;
  PDFName: string;
  collection?: number;
}

interface UnifiedAppContext {
  session: Session | null;
  status: 'loading' | 'authenticated' | 'unauthenticated';
  refreshSession: (force?: boolean) => Promise<Session | null>;
  getCurrentSession: () => Session | null;
  sessionRefreshError: string | null;
  
  projectFolder: ProjectFolder | null;
  projectStateHydrated: boolean;
  setProjectFolder: (folder: ProjectFolder | null) => void;
  token: string | null;
  setToken: (token: string | null) => void;
  user: UserInfo | null;
  setUser: (user: UserInfo | null) => void;
  workflowId: string;
  setWorkflowId: (id: string) => void;
  projects: Project[];
  setProjects: (projects: Project[]) => void;
  
  masterContext: string;
  setMasterContext: (context: string) => void;
  
  collections: Extract[][];
  setCollections: (collections: Extract[][]) => void;
}

const UnifiedAppContext = createContext<UnifiedAppContext | undefined>(undefined);

export function useAppContext() {
  const context = useContext(UnifiedAppContext);
  if (!context) {
    throw new Error('useAppContext must be used within RootProvider');
  }
  return context;
}

function UnifiedProvider({ children }: { children: ReactNode }) {
  const { data: session, status, update } = useSession();
  
  const [projectFolder, setProjectFolder] = useState<ProjectFolder | null>(null);
  const [projectStateHydrated, setProjectStateHydrated] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [sessionRefreshError, setSessionRefreshError] = useState<string | null>(null);
  const sessionState = useRef({ session, update });
  const latestSession = useRef<Session | null>(session);
  const identityVersion = useRef(0);
  const observedIdentity = useRef(session?.user?.email);

  useLayoutEffect(() => {
    if (observedIdentity.current !== session?.user?.email) {
      observedIdentity.current = session?.user?.email;
      identityVersion.current += 1;
      latestSession.current = session;
      setToken(session?.accessToken ?? null);
    }
    sessionState.current = { session, update };
    if (!session || !latestSession.current ||
      (session.accessTokenExpires ?? 0) >= (latestSession.current.accessTokenExpires ?? 0)) {
      latestSession.current = session;
    }
  }, [session, update]);

  const getCurrentSession = useCallback(() => latestSession.current, []);
  const [refreshSession] = useState(() => createSessionRefresher(async force => {
    const version = identityVersion.current;
    const current = sessionState.current;
    try {
      if (!navigator.onLine) throw new SessionRequestError();
      const updated = current.session
        ? await current.update(force ? { refresh: true } : undefined)
        : null;
      const refreshed = updated || await readBrowserSession();
      if (version !== identityVersion.current) throw new SessionRefreshCancelledError();
      latestSession.current = refreshed;
      setToken(refreshed?.accessToken ?? null);
      setSessionRefreshError(null);
      return refreshed;
    } catch (error) {
      if (!(error instanceof SessionRefreshCancelledError)) setSessionRefreshError('SessionUnavailable');
      throw error;
    }
  }, () => latestSession.current?.accessToken));
  const [user, setUser] = useState<UserInfo | null>(null);
  const [workflowId, setWorkflowId] = useState<string>('');
  const [projects, setProjects] = useState<Project[]>([]);
  
  const [masterContext, setMasterContext] = useState<string>('');
  
  const [collections, setCollections] = useState<Extract[][]>([[], [], [], []]);
  
  useLayoutEffect(() => {
    try {
      const storedFolder = localStorage.getItem('projectFolder');
      if (storedFolder) {
        setProjectFolder(JSON.parse(storedFolder) as ProjectFolder);
      }
      const storedToken = localStorage.getItem('projectToken');
      if (storedToken) {
        setToken(storedToken);
      }
    } finally {
      setProjectStateHydrated(true);
    }
  }, []);
  
  useEffect(() => {
    if (projectFolder) {
      localStorage.setItem('projectFolder', JSON.stringify(projectFolder));
    } else {
      localStorage.removeItem('projectFolder');
    }
  }, [projectFolder]);
  
  useEffect(() => {
    if (token) {
      localStorage.setItem('projectToken', token);
    } else {
      localStorage.removeItem('projectToken');
    }
  }, [token]);
  
  const contextValue = useMemo(() => ({
    session,
    status,
    refreshSession,
    getCurrentSession,
    sessionRefreshError,
    
    projectFolder,
    projectStateHydrated,
    setProjectFolder,
    token,
    setToken,
    user,
    setUser,
    workflowId,
    setWorkflowId,
    projects,
    setProjects,
    
    masterContext,
    setMasterContext,
    
    collections,
    setCollections,
  }), [
    session,
    status,
    refreshSession,
    getCurrentSession,
    sessionRefreshError,
    projectFolder,
    projectStateHydrated,
    token,
    user,
    workflowId,
    projects,
    masterContext,
    collections,
  ]);
  
  return (
    <UnifiedAppContext.Provider value={contextValue}>
      <AutoRefreshToken />
      {children}
    </UnifiedAppContext.Provider>
  );
}

export function RootProvider({ children }: { children: ReactNode }) {
  return (
    <SessionProvider refetchOnWindowFocus={false} refetchWhenOffline={false}>
      <ThemeProvider>
        <LanguageProvider>
          <AppBusyProvider>
            <MagnifierProvider>
              <>
                <UnifiedProvider>{children}</UnifiedProvider>
                <JaLocaleWelcomeModal />
              </>
            </MagnifierProvider>
          </AppBusyProvider>
        </LanguageProvider>
      </ThemeProvider>
    </SessionProvider>
  );
} 