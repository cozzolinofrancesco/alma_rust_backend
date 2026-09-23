import { BibliographyItem } from './types';
import { sanitizeAgentName, MAX_AGENT_NAME_LENGTH } from './agentLayer';
import type { AgentOutputVersion } from './agentOutputHistory';
import { queueAgentFileSave } from './agentSaveQueue';
import type { SkillRef } from './projectSkills';
import { normalizeAgentInputMetadata, type AgentCorpusRef, type AgentInputMetadata } from './agentFiles';

interface BaseLayer {
  id: string;
  name: string;
  outputHistory?: AgentOutputVersion[];
  ragKnowledge?: unknown;
  bibliography?: BibliographyItem[];
  corpusId?: string;
  documentSelections?: string[];
  [key: string]: unknown;
}

export interface AgentData {
  version?: string;
  name: string;
  layers: BaseLayer[];
  metadata?: {
    created?: string;
    modified?: string;
    description?: string;
    notes?: { username: string; text: string; timestamp: string }[];
    skillIds?: string[];
    skillRefs?: SkillRef[];
    fileIds?: string[];
    corpusRefs?: AgentCorpusRef[];
  };
}

export interface AgentVersion {
  version: string;
  timestamp: string;
  hash: string;
  name: string;
  layers: BaseLayer[];
  metadata?: {
    created?: string;
    modified?: string;
    description?: string;
    notes?: { username: string; text: string; timestamp: string }[];
    skillIds?: string[];
    skillRefs?: SkillRef[];
    fileIds?: string[];
    corpusRefs?: AgentCorpusRef[];
  };
}

export interface VersionedAgentData {
  agentName: string;
  currentVersion: string;
  totalVersions: number;
  versions: AgentVersion[];
  ragKnowledge?: Array<Record<string, unknown>>;
  metadata?: {
    created?: string;
    lastModified?: string;
    description?: string;
    notes?: { username: string; text: string; timestamp: string }[];
    skillIds?: string[];
    skillRefs?: SkillRef[];
    fileIds?: string[];
    corpusRefs?: AgentCorpusRef[];
  };
  [key: string]: unknown;
}

// Carry the in-memory agent's skillIds over the Drive copy when present, so a
// concurrent /api/skills PATCH (the other writer of skillIds) can't be lost to a
// read-modify-write save. Absent skillIds leaves the existing value untouched.
const carrySkillIds = (incoming: AgentData['metadata']): AgentInputMetadata & { skillIds?: string[]; skillRefs?: SkillRef[] } => ({
  ...(incoming?.skillIds !== undefined ? { skillIds: [...incoming.skillIds] } : {}),
  ...(incoming?.skillRefs !== undefined ? { skillRefs: incoming.skillRefs.map((ref) => ({ ...ref })) } : {}),
  ...normalizeAgentInputMetadata(incoming),
});

export function getAgentVersionMetadata(agent: VersionedAgentData, version = agent.currentVersion): AgentData['metadata'] {
  const snapshot = agent.versions.find((entry) => entry.version === version);
  const metadata = { ...agent.metadata, ...snapshot?.metadata };
  if (version !== agent.currentVersion && snapshot?.metadata?.skillRefs === undefined) delete metadata.skillRefs;
  if (version !== agent.currentVersion && snapshot?.metadata?.fileIds === undefined) delete metadata.fileIds;
  if (version !== agent.currentVersion && snapshot?.metadata?.corpusRefs === undefined) delete metadata.corpusRefs;
  return JSON.parse(JSON.stringify(metadata));
}

export async function generateSHA(name: string, timestamp: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto API is not available; cannot generate agent file hash.');
  }
  const data = new TextEncoder().encode(name + timestamp);
  const buf = await subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .substring(0, 8);
}

export async function generateFileName(agentName: string, timestamp: string): Promise<string> {
  const hash = await generateSHA(agentName, timestamp);
  return `${agentName}_${timestamp}_${hash}.json`;
}

export const findExistingAgentFile = async (projectId: string, agentName: string): Promise<{ id: string; name: string } | null> => {
  try {
    const response = await fetch(`/api/projects/${projectId}/folders/AF/files`, { credentials: 'include' });
    if (!response.ok) return null;

    const data = await response.json();
    const files = data.files || [];

    console.log('🔍 All files in AF folder:', files.map((f: { id: string; name: string }) => ({ id: f.id, name: f.name })));

    const matchingFiles = files.filter((file: { id: string; name: string }) =>
      file.name.startsWith(`${agentName}_`) &&
      file.name.endsWith('.json')
    );

    console.log('🔍 Files matching agent name:', matchingFiles);

    const escapedName = agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const existingFile = files.find((file: { id: string; name: string }) =>
      file.name.startsWith(`${agentName}_`) &&
      file.name.endsWith('.json') &&
      file.name.match(new RegExp(`^${escapedName}_\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z_[a-f0-9]{8}\\.json$`))
    );

    return existingFile ? { id: existingFile.id, name: existingFile.name } : null;
  } catch (error) {
    console.error('Error finding existing agent file:', error);
    return null;
  }
};

export const loadExistingAgentFile = async (projectId: string, fileId: string): Promise<VersionedAgentData | null> => {
  try {
    const fileResponse = await fetch(`/api/projects/${projectId}/files/${fileId}`, { credentials: 'include' });
    if (!fileResponse.ok) return null;

    const fileData = await fileResponse.json();
    return JSON.parse(fileData.content);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const isAborted = (error instanceof DOMException && error.name === 'AbortError');
    const isNetworkError = isAborted || msg === 'Failed to fetch' || msg.includes('NetworkError') || msg.includes('Load failed');
    if (isNetworkError) {
      console.warn('Network error loading agent file (transient):', msg);
    } else {
      console.error('Error loading existing agent file:', error);
    }
    return null;
  }
};

export const updateExistingAgentFile = async (
  projectId: string,
  fileId: string,
  agentData: VersionedAgentData | AgentData
): Promise<boolean> => {
  try {
    const jsonContent = JSON.stringify(agentData, null, 2);
    const blob = new Blob([jsonContent], { type: 'application/json' });
    const formData = new FormData();
    formData.append('file', blob);

    const response = await fetch(`/api/projects/${projectId}/files/${fileId}`, {
      method: 'POST',
      body: formData,
      credentials: 'include',
    });
    return response.ok;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const isAborted = (error instanceof DOMException && error.name === 'AbortError');
    const isNetworkError = isAborted || msg === 'Failed to fetch' || msg.includes('NetworkError') || msg.includes('Load failed');
    if (isNetworkError) {
      console.warn('Network error updating agent file (transient):', msg);
    } else {
      console.error('Error updating existing agent file:', error);
    }
    return false;
  }
};

export const createNewVersionedAgent = async (
  agentName: string,
  agentData: AgentData,
  timestamp: string
): Promise<VersionedAgentData> => {
  const snapshot = JSON.parse(JSON.stringify(agentData)) as AgentData;
  const hash = await generateSHA(agentName, timestamp);

  const newVersion: AgentVersion = {
    version: 'v1',
    timestamp,
    hash,
    name: agentName,
    layers: snapshot.layers,
    metadata: {
      ...snapshot.metadata,
      modified: timestamp
    }
  };

  return {
    agentName,
    currentVersion: 'v1',
    totalVersions: 1,
    versions: [newVersion],
    metadata: {
      ...snapshot.metadata,
      created: snapshot.metadata?.created || timestamp,
      lastModified: timestamp,
      notes: snapshot.metadata?.notes || []
    }
  };
};

export const addVersionToAgent = async (
  existingAgent: VersionedAgentData,
  agentData: AgentData,
  agentName: string,
  timestamp: string
): Promise<VersionedAgentData> => {
  const snapshot = JSON.parse(JSON.stringify(agentData)) as AgentData;
  const inputMetadata = { ...normalizeAgentInputMetadata(existingAgent.metadata), ...normalizeAgentInputMetadata(snapshot.metadata) };
  const hash = await generateSHA(agentName, timestamp);
  const highestVersion = existingAgent.versions.reduce(
    (highest, version) => Math.max(highest, Number(version.version.match(/^v(\d+)$/)?.[1] ?? 0)),
    existingAgent.versions.length
  );
  const newVersionNumber = `v${highestVersion + 1}`;

  const newVersion: AgentVersion = {
    version: newVersionNumber,
    timestamp,
    hash,
    name: agentName,
    layers: snapshot.layers,
    metadata: {
      ...snapshot.metadata,
      ...inputMetadata,
      modified: timestamp
    }
  };

  return {
    ...existingAgent,
    agentName,
    currentVersion: newVersionNumber,
    totalVersions: existingAgent.versions.length + 1,
    versions: [...existingAgent.versions, newVersion],
    metadata: {
      ...existingAgent.metadata,
      ...carrySkillIds(snapshot.metadata),
      lastModified: timestamp,
      notes: snapshot.metadata?.notes || existingAgent.metadata?.notes || []
    }
  };
};

export const getCurrentVersionLayers = (versionedAgent: VersionedAgentData): BaseLayer[] => {
  const currentVersion = versionedAgent.versions.find(
    v => v.version === versionedAgent.currentVersion
  );
  return currentVersion ? JSON.parse(JSON.stringify(currentVersion.layers)) as BaseLayer[] : [];
};

export const getVersionLayers = (versionedAgent: VersionedAgentData, version: string): BaseLayer[] => {
  const targetVersion = versionedAgent.versions.find(v => v.version === version);
  return targetVersion ? JSON.parse(JSON.stringify(targetVersion.layers)) as BaseLayer[] : [];
};

export const canAutosaveAgentVersion = (
  versionedAgent: VersionedAgentData | null,
  selectedVersion: string,
  _layers?: BaseLayer[]
): boolean => {
  return !versionedAgent || selectedVersion === versionedAgent.currentVersion;
};

export const isVersionedAgent = (data: unknown): data is VersionedAgentData => {
  return Boolean(data &&
    typeof data === 'object' &&
    data !== null &&
    'agentName' in data &&
    'versions' in data &&
    Array.isArray((data as Record<string, unknown>).versions));
};

export const convertLegacyToVersioned = async (
  legacyData: AgentData,
  agentName: string
): Promise<VersionedAgentData> => {
  const timestamp = legacyData.metadata?.modified || legacyData.metadata?.created || new Date().toISOString();
  return createNewVersionedAgent(agentName, legacyData, timestamp);
};

export interface AgentVersionSaveResult {
  success: boolean;
  skipped?: boolean;
  versionId?: string;
  fileName?: string;
  fileId?: string;
  error?: string;
  versionedAgent?: VersionedAgentData;
}

const saveAgentWithVersioningUnqueued = async (
  projectId: string,
  agentName: string,
  agentData: AgentData,
  existingFileId?: string,
  options: { shouldSave?: () => boolean } = {}
): Promise<AgentVersionSaveResult> => {
  try {
    if (options.shouldSave && !options.shouldSave()) return { success: false, skipped: true };
    const timestamp = new Date().toISOString();

    let existingFile: { id: string; name: string } | null = null;
    let preloadedData: VersionedAgentData | AgentData | null = null;
    if (existingFileId) {
      preloadedData = await loadExistingAgentFile(projectId, existingFileId);
      if (!preloadedData) throw new Error('Could not load existing agent file');
      existingFile = { id: existingFileId, name: `${agentName}_*.json` };
    }
    if (!existingFile) {
      existingFile = await findExistingAgentFile(projectId, agentName);
    }
    console.log('🔍 Existing file search result:', existingFile);

    let versionedAgent: VersionedAgentData;

    if (existingFile) {
      const existingData = preloadedData ?? await loadExistingAgentFile(projectId, existingFile.id);
      console.log('🔍 Loaded existing data:', existingData);

      if (existingData && isVersionedAgent(existingData)) {
        console.log('✅ Found versioned agent with', existingData.versions.length, 'versions');
        versionedAgent = await addVersionToAgent(existingData, agentData, agentName, timestamp);
        console.log('✅ Added new version, now has', versionedAgent.versions.length, 'versions');
      } else if (existingData) {
        console.log('🔄 Converting legacy agent to versioned format');
        const convertedAgent = await convertLegacyToVersioned(existingData as AgentData, agentName);
        versionedAgent = await addVersionToAgent(convertedAgent, agentData, agentName, timestamp);
      } else {
        throw new Error('Could not load existing agent file');
      }

      if (options.shouldSave && !options.shouldSave()) return { success: false, skipped: true };
      console.log('💾 Updating existing file with versioned agent:', versionedAgent);
      const updateSuccess = await updateExistingAgentFile(projectId, existingFile.id, versionedAgent);
      console.log('💾 Update result:', updateSuccess);

      if (!updateSuccess) {
        throw new Error('Failed to update existing agent file');
      }

      return {
        success: true,
        versionId: versionedAgent.currentVersion,
        fileName: existingFile.name,
        fileId: existingFile.id,
        versionedAgent,
      };
    } else {
      versionedAgent = await createNewVersionedAgent(agentName, agentData, timestamp);

      const newFileName = await generateFileName(agentName, timestamp);

      const jsonContent = JSON.stringify(versionedAgent, null, 2);
      const blob = new Blob([jsonContent], { type: 'application/json' });
      const formData = new FormData();
      formData.append('file', blob, newFileName);

      if (options.shouldSave && !options.shouldSave()) return { success: false, skipped: true };
      const response = await fetch(`/api/projects/${projectId}/folders/AF/files`, {
        method: 'POST',
        mode: 'cors',
        body: formData,
        credentials: 'include',
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: response.statusText }));
        throw new Error(`Save error: ${response.status} - ${errorData.message || response.statusText}`);
      }

      const responseData = await response.json();
      const fileId = responseData.file_id;

      return {
        success: true,
        versionId: versionedAgent.currentVersion,
        fileName: newFileName,
        fileId: fileId,
        versionedAgent,
      };
    }

  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
};

export const saveAgentWithVersioning: typeof saveAgentWithVersioningUnqueued = async (
  projectId,
  agentName,
  agentData,
  existingFileId,
  options,
) => {
  try {
    const snapshot = JSON.parse(JSON.stringify(agentData)) as AgentData;
    const fileId = existingFileId ?? (await findExistingAgentFile(projectId, agentName))?.id;
    return await queueAgentFileSave(projectId, fileId ?? `new:${agentName}`, () =>
      saveAgentWithVersioningUnqueued(projectId, agentName, snapshot, fileId, options)
    );
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
};

/**
 * Create a NEW agent. Unlike saveAgentWithVersioning (which silently appends a
 * version to an existing same-named agent — correct for editing/saving), this
 * sanitizes/validates the name and rejects when an agent with that name already
 * exists, so the create flow never quietly merges into an unrelated agent.
 */
export const createAgent = async (
  projectId: string,
  agentName: string,
  agentData: AgentData
): Promise<{ success: boolean; versionId?: string; fileName?: string; fileId?: string; error?: string }> => {
  const sanitized = sanitizeAgentName(agentName);
  if (!sanitized) {
    return { success: false, error: 'Agent name is required' };
  }
  if (sanitized.length > MAX_AGENT_NAME_LENGTH) {
    return { success: false, error: `Agent name must be at most ${MAX_AGENT_NAME_LENGTH} characters` };
  }
  const check = await checkAgentNameExists(projectId, sanitized);
  if (check.error) {
    return { success: false, error: check.error };
  }
  if (check.exists) {
    return { success: false, error: `An agent named "${sanitized}" already exists` };
  }
  return saveAgentWithVersioning(projectId, sanitized, { ...agentData, name: sanitized });
};

export const loadAgentWithVersions = async (
  projectId: string,
  agentName: string
): Promise<{ success: boolean; versionedAgent?: VersionedAgentData; error?: string }> => {
  try {
    const existingFile = await findExistingAgentFile(projectId, agentName);

    if (!existingFile) {
      return { success: false, error: 'Agent not found' };
    }

    const versionedAgent = await loadExistingAgentFile(projectId, existingFile.id);

    if (!versionedAgent) {
      return { success: false, error: 'Could not load agent data' };
    }

    return { success: true, versionedAgent };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
};

export const updateAgentNotesOnly = async (
  projectId: string,
  agentName: string,
  notes: { username: string; text: string; timestamp: string }[]
): Promise<{ success: boolean; error?: string }> => {
  try {
    const existingFile = await findExistingAgentFile(projectId, agentName);

    if (!existingFile) {
      return { success: false, error: 'Agent not found' };
    }

    const existingData = await loadExistingAgentFile(projectId, existingFile.id);

    if (!existingData) {
      return { success: false, error: 'Could not load agent data' };
    }

    const isVersioned = isVersionedAgent(existingData);

    let updatedAgent: VersionedAgentData | AgentData;

    if (isVersioned) {
      const versionedData = existingData as VersionedAgentData;
      updatedAgent = {
        ...versionedData,
        metadata: {
          ...versionedData.metadata,
          lastModified: new Date().toISOString(),
          notes
        }
      };
    } else {
      const legacyData = existingData as AgentData;
      updatedAgent = {
        ...legacyData,
        metadata: {
          ...legacyData.metadata,
          modified: new Date().toISOString(),
          notes
        }
      };
    }

    const success = await updateExistingAgentFile(projectId, existingFile.id, updatedAgent);

    if (!success) {
      return { success: false, error: 'Failed to update agent file' };
    }

    return { success: true };

  } catch (error) {
    console.error('Error in updateAgentNotesOnly:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
};

export const mergeAgentSameVersion = async (
  existingData: VersionedAgentData | AgentData,
  agentData: AgentData,
  timestamp = new Date().toISOString()
): Promise<VersionedAgentData | AgentData> => {
  const snapshot = JSON.parse(JSON.stringify(agentData)) as AgentData;
  const versionedData = isVersionedAgent(existingData) ? existingData : null;
  const currentVersion = versionedData?.versions.find(
    version => version.version === versionedData.currentVersion
  );
  if (versionedData && !currentVersion) {
    throw new Error('Current version not found in versions array');
  }

  if (versionedData && currentVersion) {
    return {
      ...versionedData,
      agentName: snapshot.name ?? versionedData.agentName,
      versions: versionedData.versions.map(version => version === currentVersion ? {
        ...version,
        name: snapshot.name ?? version.name,
        layers: snapshot.layers,
        metadata: { ...version.metadata, ...carrySkillIds(snapshot.metadata), modified: timestamp },
      } : version),
      metadata: {
        ...versionedData.metadata,
        ...carrySkillIds(snapshot.metadata),
        lastModified: timestamp,
      },
    };
  }

  const legacyData = existingData as AgentData;
  return {
    ...legacyData,
    name: snapshot.name ?? legacyData.name,
    layers: snapshot.layers,
    metadata: {
      ...legacyData.metadata,
      ...carrySkillIds(snapshot.metadata),
      modified: timestamp,
    },
  };
};

export const updateAgentSameVersion = async (
  projectId: string,
  agentName: string,
  agentData: AgentData
): Promise<{ success: boolean; error?: string; versionedAgent?: VersionedAgentData }> => {
  try {
    const snapshot = JSON.parse(JSON.stringify(agentData)) as AgentData;
    const existingFile = await findExistingAgentFile(projectId, agentName);

    if (!existingFile) {
      return { success: false, error: 'Agent not found - cannot autosave non-existent agent' };
    }

    return await updateAgentSameVersionByFileId(projectId, existingFile.id, snapshot);

  } catch (error) {
    console.error('Error in updateAgentSameVersion:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
};

export const updateAgentSameVersionByFileId = async (
  projectId: string,
  fileId: string,
  agentData: AgentData,
  options: { expectedCurrentVersion?: string; shouldSave?: () => boolean } = {}
): Promise<{ success: boolean; skipped?: boolean; error?: string; versionedAgent?: VersionedAgentData }> => {
  try {
    const snapshot = JSON.parse(JSON.stringify(agentData)) as AgentData;
    return await queueAgentFileSave(projectId, fileId, async () => {
      if (options.shouldSave && !options.shouldSave()) return { success: false, skipped: true };
      const timestamp = new Date().toISOString();
      const existingData = await loadExistingAgentFile(projectId, fileId);
      if (!existingData) {
        return { success: false, error: 'Agent not found - cannot autosave non-existent agent' };
      }
      if (options.expectedCurrentVersion && isVersionedAgent(existingData)
        && existingData.currentVersion !== options.expectedCurrentVersion) {
        return { success: false, skipped: true };
      }

      const updatedAgent = await mergeAgentSameVersion(existingData, snapshot, timestamp);
      if (options.shouldSave && !options.shouldSave()) return { success: false, skipped: true };
      const success = await updateExistingAgentFile(projectId, fileId, updatedAgent);
      if (!success) {
        return { success: false, error: 'Failed to update agent file' };
      }

      return { success: true, versionedAgent: isVersionedAgent(updatedAgent) ? updatedAgent : undefined };
    });
  } catch (error) {
    console.error('Error in updateAgentSameVersionByFileId:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

export const checkAgentNameExists = async (
  projectId: string,
  agentName: string
): Promise<{ exists: boolean; versionCount?: number; error?: string }> => {
  try {
    const existingFile = await findExistingAgentFile(projectId, agentName);

    if (!existingFile) {
      return { exists: false };
    }

    const existingData = await loadExistingAgentFile(projectId, existingFile.id);

    if (!existingData) {
      return { exists: false };
    }

    if (isVersionedAgent(existingData)) {
      return {
        exists: true,
        versionCount: existingData.versions.length
      };
    } else {
      return {
        exists: true,
        versionCount: 1
      };
    }

  } catch (error) {
    console.error('Error checking agent name existence:', error);
    return {
      exists: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}; 