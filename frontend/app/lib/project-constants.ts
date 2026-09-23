
export const REQUIRED_FOLDERS = [
  'Config',
  'Workflows', 
  'Chats',
  'Images',
  'Created-images',
  'PDFs',
  'Audio',
  'Video',
  'Code',
  'Docs',
  'AF',
  'report_creation_corpus',
  'Extracts',
  'LatexFullDocs',
  'Collections',
  'Analysis',
  'Analysis-output',
  'Scripts',
  'Scripts-output',
  'Reports-output',
  'Incseqdiag-output',
  'Incgraph-output',
  'Agents',
  'Agents-output',
  'Prompts',
  'RAG-Knowledge',
  'Others',
  'Logs',
  'Orders',
  'stl',
  'json3dprojects',
  'QC-reports',
  'Integrity-Keys',
] as const;

export type RequiredFolder = typeof REQUIRED_FOLDERS[number];

export const getRequiredFoldersCount = (): number => REQUIRED_FOLDERS.length;

export const isRequiredFolder = (folderName: string): folderName is RequiredFolder => {
  return REQUIRED_FOLDERS.includes(folderName as RequiredFolder);
};

export const getMissingFolders = (existingFolders: string[]): RequiredFolder[] => {
  return REQUIRED_FOLDERS.filter(folder => !existingFolders.includes(folder));
};

export const MAX_PROJECT_NAME_LENGTH = 60 as const;

/**
 * Strip the ALMA wrapper from a project folder name: removes the `alma_` prefix
 * and a trailing `_<13-digit timestamp>` (the suffix added at creation). Single
 * source of truth — used by the API routes and the UI so the displayed/base
 * name is computed consistently.
 */
export const getCleanProjectName = (almaName: string): string => {
  if (!almaName) return almaName;
  if (!almaName.toLowerCase().startsWith('alma_')) return almaName;

  const withoutPrefix = almaName.substring(5);
  const lastUnderscoreIndex = withoutPrefix.lastIndexOf('_');
  if (lastUnderscoreIndex === -1) return withoutPrefix;

  const possibleTimestamp = withoutPrefix.substring(lastUnderscoreIndex + 1);
  if (/^\d{13}$/.test(possibleTimestamp)) {
    return withoutPrefix.substring(0, lastUnderscoreIndex);
  }
  return withoutPrefix;
};