
const GOOGLE_WORKSPACE_EXPORTABLE: Record<string, string> = {
  'application/vnd.google-apps.document': 'application/pdf',
  'application/vnd.google-apps.presentation': 'application/pdf',
  'application/vnd.google-apps.drawing': 'application/pdf',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
};

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'tif'];
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'wma'];
const VIDEO_EXTENSIONS = ['mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', 'mkv', '3gp'];

export function isPickableFile(mimeType: string, fileName?: string): boolean {
  if (mimeType) {
    if (mimeType.startsWith('image/')) return true;
    if (mimeType.startsWith('audio/')) return true;
    if (mimeType.startsWith('video/')) return true;
    if (mimeType.includes('pdf')) return true;
    if (mimeType in GOOGLE_WORKSPACE_EXPORTABLE) return true;
  }

  if (fileName) {
    const ext = fileName.toLowerCase().split('.').pop();
    if (ext) {
      if (IMAGE_EXTENSIONS.includes(ext)) return true;
      if (ext === 'pdf') return true;
      if (AUDIO_EXTENSIONS.includes(ext)) return true;
      if (VIDEO_EXTENSIONS.includes(ext)) return true;
    }
  }

  return false;
}

export function isGoogleWorkspaceFile(mimeType: string): boolean {
  return mimeType in GOOGLE_WORKSPACE_EXPORTABLE;
}

export function getExportMimeType(mimeType: string): string | null {
  return GOOGLE_WORKSPACE_EXPORTABLE[mimeType] ?? null;
}

export function getGoogleDriveDownloadUrl(fileId: string, mimeType?: string): string {
  if (mimeType && mimeType in GOOGLE_WORKSPACE_EXPORTABLE) {
    const exportMime = GOOGLE_WORKSPACE_EXPORTABLE[mimeType];
    return `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`;
  }
  return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
}

export const MAX_FILE_SIZE_BYTES = 30 * 1024 * 1024;

export function validateFileSize(file: File | Blob, fileName?: string): { isValid: boolean; error?: string } {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    const fileSizeMB = (file.size / 1024 / 1024).toFixed(1);
    const name = fileName ? `"${fileName}"` : (file instanceof File ? `"${file.name}"` : "the file");
    return {
      isValid: false,
      error: `File ${name} (${fileSizeMB}MB) exceeds the 30MB limit and is not currently supported.`
    };
  }
  return { isValid: true };
}

export async function detectPdfPageCount(file: File | Blob): Promise<number> {
  try {
    const pdfLibModule = await import('pdf-lib');
    const { PDFDocument } = pdfLibModule;
    const arrayBuffer = await file.arrayBuffer();
    const pdfDoc = await PDFDocument.load(arrayBuffer);
    return pdfDoc.getPageCount();
  } catch (error) {
    console.warn('Could not detect PDF page count:', error);
    return 0;
  }
}

