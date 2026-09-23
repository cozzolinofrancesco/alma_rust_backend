import { FileConflict } from '../components/DuplicateFileModal';

export interface FileItem {
  id: string;
  name: string;
  folder: string;
  size: number;
  type: string;
  uploadDate: string;
  lastModified: string;
  tags?: string[];
  aiDescription?: string;
}

export function checkForDuplicate(
  fileName: string, 
  targetFolder: string, 
  existingFiles: FileItem[]
): boolean {
  return existingFiles.some(
    file => file.name === fileName && file.folder === targetFolder
  );
}

export function generateUniqueFileName(
  originalName: string,
  targetFolder: string,
  existingFiles: FileItem[]
): string {
  let counter = 1;
  let newName = originalName;

  while (checkForDuplicate(newName, targetFolder, existingFiles)) {
    const fileExtension = originalName.includes('.') 
      ? originalName.substring(originalName.lastIndexOf('.'))
      : '';
    const nameWithoutExtension = originalName.includes('.')
      ? originalName.substring(0, originalName.lastIndexOf('.'))
      : originalName;
    
    newName = `(${counter}) ${nameWithoutExtension}${fileExtension}`;
    counter++;
  }

  return newName;
}

export function determineTargetFolder(file: File): string {
  if (file.type.startsWith('image/')) return 'Images';
  if (file.type.startsWith('audio/')) return 'Audio';
  if (file.type.startsWith('video/')) return 'Video';
  if (file.type.includes('doc') || file.type.includes('text')) return 'Docs';
  if (file.type === 'application/pdf') return 'PDFs';
  if (file.name.match(/\.(js|ts|py|java|cpp|c|html|css|json|xml)$/i)) return 'Code';
  return 'Others';
}

export function scanForConflicts(
  filesToUpload: File[],
  existingFiles: FileItem[]
): FileConflict[] {
  const conflicts: FileConflict[] = [];

  for (const file of filesToUpload) {
    const targetFolder = determineTargetFolder(file);
    
    if (checkForDuplicate(file.name, targetFolder, existingFiles)) {
      const suggestedName = generateUniqueFileName(file.name, targetFolder, existingFiles);
      
      conflicts.push({
        file,
        targetFolder,
        suggestedName
      });
    }
  }

  return conflicts;
}

export function getFinalFileName(
  originalFile: File,
  conflict?: FileConflict
): string {
  if (!conflict) {
    return originalFile.name;
  }

  switch (conflict.resolution) {
    case 'rename':
      return conflict.suggestedName;
    case 'cancel':
      return '';
    default:
      return originalFile.name;
  }
}

export function filterUploadableFiles(
  filesToUpload: File[],
  resolvedConflicts: FileConflict[]
): { file: File; finalName: string; targetFolder: string }[] {
  const conflictMap = new Map(
    resolvedConflicts.map(conflict => [conflict.file.name, conflict])
  );

  return filesToUpload
    .map(file => {
      const conflict = conflictMap.get(file.name);
      const finalName = getFinalFileName(file, conflict);
      
      return {
        file,
        finalName,
        targetFolder: conflict?.targetFolder || determineTargetFolder(file)
      };
    })
    .filter(item => item.finalName !== '');
} 