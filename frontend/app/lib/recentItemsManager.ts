
const RECENT_PROJECTS_KEY = 'alma_recent_projects';
const RECENT_AGENTS_KEY = 'alma_recent_agents';
const AGENT_ACTIVITY_KEY = 'alma_agent_activity_v1';
const MAX_RECENT_ITEMS = 5;

export interface RecentProject {
  id: string;
  name: string;
  lastUsed: number;
}

export interface RecentAgent {
  id: string;
  name: string;
  lastUsed: number;
  projectId?: string;
}

type AgentActivityByProject = Record<string, Record<string, number>>;

const getAgentActivityStore = (): AgentActivityByProject => {
  if (typeof window === 'undefined') return {};

  try {
    const stored = localStorage.getItem(AGENT_ACTIVITY_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as AgentActivityByProject;
  } catch (error) {
    console.error('Error loading agent activity store:', error);
    return {};
  }
};

const setAgentActivityStore = (store: AgentActivityByProject): void => {
  if (typeof window === 'undefined') return;

  try {
    localStorage.setItem(AGENT_ACTIVITY_KEY, JSON.stringify(store));
  } catch (error) {
    console.error('Error saving agent activity store:', error);
  }
};

export const getRecentProjects = (): RecentProject[] => {
  if (typeof window === 'undefined') return [];
  
  try {
    const stored = localStorage.getItem(RECENT_PROJECTS_KEY);
    if (!stored) return [];
    
    const projects: RecentProject[] = JSON.parse(stored);
    return projects.sort((a, b) => b.lastUsed - a.lastUsed).slice(0, MAX_RECENT_ITEMS);
  } catch (error) {
    console.error('Error loading recent projects:', error);
    return [];
  }
};

export const addRecentProject = (id: string, name: string): void => {
  if (typeof window === 'undefined') return;
  
  try {
    const recent = getRecentProjects();
    
    const filtered = recent.filter(p => p.id !== id);
    
    const updated = [
      { id, name, lastUsed: Date.now() },
      ...filtered
    ].slice(0, MAX_RECENT_ITEMS);
    
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(updated));
  } catch (error) {
    console.error('Error saving recent project:', error);
  }
};

export const getRecentAgents = (): RecentAgent[] => {
  if (typeof window === 'undefined') return [];
  
  try {
    const stored = localStorage.getItem(RECENT_AGENTS_KEY);
    if (!stored) return [];
    
    const agents: RecentAgent[] = JSON.parse(stored);
    return agents.sort((a, b) => b.lastUsed - a.lastUsed).slice(0, MAX_RECENT_ITEMS);
  } catch (error) {
    console.error('Error loading recent agents:', error);
    return [];
  }
};

export const addRecentAgent = (id: string, name: string, projectId?: string): void => {
  if (typeof window === 'undefined') return;
  
  try {
    const recent = getRecentAgents();
    
    const filtered = recent.filter(a => a.id !== id);
    
    const updated = [
      { id, name, lastUsed: Date.now(), projectId },
      ...filtered
    ].slice(0, MAX_RECENT_ITEMS);
    
    localStorage.setItem(RECENT_AGENTS_KEY, JSON.stringify(updated));
    window.dispatchEvent(new CustomEvent('alma:agents-updated'));
  } catch (error) {
    console.error('Error saving recent agent:', error);
  }
};

export const updateRecentAgentName = (id: string, name: string): void => {
  if (typeof window === 'undefined') return;

  try {
    const recent = getRecentAgents();
    const trimmed = name.trim();
    if (!trimmed) return;

    let changed = false;
    const updated = recent.map((agent) => {
      if (agent.id !== id) return agent;
      changed = true;
      return { ...agent, name: trimmed };
    });

    if (changed) {
      localStorage.setItem(RECENT_AGENTS_KEY, JSON.stringify(updated));
    }
  } catch (error) {
    console.error('Error updating recent agent name:', error);
  }
};

export const syncAgentRenameAcrossStores = (id: string, name: string): void => {
  updateRecentAgentName(id, name);
  if (typeof window === 'undefined') return;

  try {
    Object.keys(window.localStorage)
      .filter((key) => key.startsWith('agents_cache_'))
      .forEach((key) => window.localStorage.removeItem(key));
  } catch {
  }

  window.dispatchEvent(
    new CustomEvent('agents-cache-invalidated', { detail: { fileId: id, name: name.trim() } }),
  );
};

export const getRecentAgentsByProject = (projectId: string): RecentAgent[] => {
  if (typeof window === 'undefined') return [];
  
  try {
    const allRecent = getRecentAgents();
    return allRecent.filter(agent => agent.projectId === projectId);
  } catch (error) {
    console.error('Error loading recent agents by project:', error);
    return [];
  }
};

export const recordAgentOpened = (agentId: string, projectId?: string): void => {
  if (typeof window === 'undefined') return;
  if (!agentId || !projectId) return;

  const store = getAgentActivityStore();
  const projectStore = store[projectId] ?? {};
  projectStore[agentId] = Date.now();
  store[projectId] = projectStore;
  setAgentActivityStore(store);
};

export const getAgentLastOpenedIndexForProject = (projectId: string): Record<string, number> => {
  if (typeof window === 'undefined') return {};
  if (!projectId) return {};

  const store = getAgentActivityStore();
  return store[projectId] ?? {};
};

