import { google } from 'googleapis';
import type { OAuth2Client } from 'googleapis-common';
import { CorpusRegistry, CorpusEntry } from './types';

const REGISTRY_FILE_NAME = 'rag_corpus_registry.json';
const REGISTRY_FOLDER_NAME = '.alma_rag';

async function getOrCreateRegistryFolder(auth: OAuth2Client): Promise<string> {
  const drive = google.drive({ version: 'v3', auth });

  try {
    const response = await drive.files.list({
      q: `name='${REGISTRY_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)',
      spaces: 'drive',
    });

    if (response.data.files && response.data.files.length > 0) {
      return response.data.files[0].id!;
    }

    const createResponse = await drive.files.create({
      requestBody: {
        name: REGISTRY_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
      },
      fields: 'id',
    });

    return createResponse.data.id!;
  } catch (error) {
    console.error('Failed to get/create registry folder:', error);
    throw error;
  }
}

async function getRegistryFileId(auth: OAuth2Client): Promise<string | null> {
  const drive = google.drive({ version: 'v3', auth });

  try {
    const folderId = await getOrCreateRegistryFolder(auth);

    const response = await drive.files.list({
      q: `name='${REGISTRY_FILE_NAME}' and '${folderId}' in parents and trashed=false`,
      fields: 'files(id)',
      spaces: 'drive',
    });

    if (response.data.files && response.data.files.length > 0) {
      return response.data.files[0].id!;
    }

    return null;
  } catch (error) {
    console.error('Failed to get registry file ID:', error);
    return null;
  }
}

async function createRegistryFile(auth: OAuth2Client): Promise<string> {
  const drive = google.drive({ version: 'v3', auth });

  const emptyRegistry: CorpusRegistry = {
    version: '1.0',
    corpora: [],
    lastUpdated: new Date().toISOString(),
  };

  try {
    const folderId = await getOrCreateRegistryFolder(auth);

    const response = await drive.files.create({
      requestBody: {
        name: REGISTRY_FILE_NAME,
        mimeType: 'application/json',
        parents: [folderId],
      },
      media: {
        mimeType: 'application/json',
        body: JSON.stringify(emptyRegistry, null, 2),
      },
      fields: 'id',
    });

    return response.data.id!;
  } catch (error) {
    console.error('Failed to create registry file:', error);
    throw error;
  }
}

export async function loadRegistry(auth: OAuth2Client): Promise<CorpusRegistry> {
  const drive = google.drive({ version: 'v3', auth });

  try {
    let fileId = await getRegistryFileId(auth);

    if (!fileId) {
      fileId = await createRegistryFile(auth);
      return {
        version: '1.0',
        corpora: [],
        lastUpdated: new Date().toISOString(),
      };
    }

    const response = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'text' }
    );

    const registry = JSON.parse(response.data as string) as CorpusRegistry;
    return registry;
  } catch (error) {
    console.error('Failed to load registry:', error);
    throw error;
  }
}

export async function saveRegistry(
  registry: CorpusRegistry,
  auth: OAuth2Client
): Promise<void> {
  const drive = google.drive({ version: 'v3', auth });

  try {
    let fileId = await getRegistryFileId(auth);

    if (!fileId) {
      fileId = await createRegistryFile(auth);
    }

    registry.lastUpdated = new Date().toISOString();

    await drive.files.update({
      fileId,
      media: {
        mimeType: 'application/json',
        body: JSON.stringify(registry, null, 2),
      },
    });
  } catch (error) {
    console.error('Failed to save registry:', error);
    throw error;
  }
}

export async function addOrUpdateCorpus(
  entry: CorpusEntry,
  auth: OAuth2Client
): Promise<void> {
  const registry = await loadRegistry(auth);

  const existingIndex = registry.corpora.findIndex((c) => c.id === entry.id);

  if (existingIndex >= 0) {
    registry.corpora[existingIndex] = entry;
  } else {
    registry.corpora.push(entry);
  }

  await saveRegistry(registry, auth);
}

export async function getCorpusById(
  corpusId: string,
  auth: OAuth2Client
): Promise<CorpusEntry | null> {
  const registry = await loadRegistry(auth);
  return (
    registry.corpora.find((c) => c.id === corpusId) ||
    registry.corpora.find((c) => c.corpusId === corpusId) ||
    null
  );
}

export async function deleteCorpusFromRegistry(
  corpusId: string,
  auth: OAuth2Client
): Promise<void> {
  const registry = await loadRegistry(auth);
  registry.corpora = registry.corpora.filter((c) => c.id !== corpusId);
  await saveRegistry(registry, auth);
}

export async function renameCorpus(
  corpusId: string,
  newDisplayName: string,
  auth: OAuth2Client
): Promise<void> {
  const registry = await loadRegistry(auth);
  const corpus = registry.corpora.find((c) => c.id === corpusId);
  
  if (!corpus) {
    throw new Error(`Corpus ${corpusId} not found`);
  }
  
  corpus.displayName = newDisplayName;
  await saveRegistry(registry, auth);
}
