'use client';

import { useAppContext } from './RootProvider';

export function useSharedSession() {
  const { session, status } = useAppContext();
  return { session, status };
}

export function useProjectState() {
  const {
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
  } = useAppContext();
  
  return {
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
  };
}

export function useMasterContext() {
  const { masterContext, setMasterContext } = useAppContext();
  return { 
    masterContextString: masterContext, 
    setMasterContextString: setMasterContext 
  };
}

export function useCollectionContext() {
  const {
    collections,
    setCollections,
  } = useAppContext();
  
  return {
    collections,
    setCollections,
  };
} 