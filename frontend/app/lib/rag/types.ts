
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  parents?: string[];
  createdTime?: string;
  modifiedTime?: string;
  owners?: Array<{ emailAddress?: string; displayName?: string }>;
}

export interface DriveFolder {
  id: string;
  name: string;
  owners?: Array<{ emailAddress?: string; displayName?: string }>;
  shared?: boolean;
  parents?: string[];
  parentNames?: string[];
}

export interface CorpusFile {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  status: 'pending' | 'indexing' | 'indexed' | 'error' | 'skipped';
  error?: string;
  errorDetails?: unknown;
  geminiFileUri?: string;
  indexedAt?: string;
}

export interface CorpusEntry {
  id: string;
  corpusId: string;
  displayName: string;
  source: {
    type: 'drive_folder';
    folderId: string;
    folderName: string;
    ownerEmail?: string;
  };
  files: CorpusFile[];
  createdAt: string;
  updatedAt: string;
  verification?: CorpusVerification;
}

// Metadata verification (see verifyCorpusMetadata.ts). A subset document filter at
// query time matches on the `pdf_name` chunk metadata; if a file's chunks carry a
// missing/mismatched `pdf_name`, the filter silently returns 0 chunks. Verification
// compares each registry file against the `pdf_name` actually stored on its chunks.
export type VerificationIssue =
  | 'ok'
  | 'missing_pdf_name'
  | 'pdf_name_mismatch'
  | 'failed_chunks'
  | 'no_chunks';

export interface FileVerification {
  fileId: string;
  name: string;              // expected pdf_name = CorpusFile.name
  issue: VerificationIssue;
  foundPdfNames: string[];   // distinct pdf_name values seen across this file's chunks
  chunkCount: number;
  failedChunks: number;
  healable: boolean;         // Drive-sourced files can be self-healed (re-imported)
}

export type VerificationStatus = 'verified' | 'needs_repair' | 'unverified';

export interface CorpusVerification {
  status: VerificationStatus;
  checkedAt: string;         // ISO timestamp
  files: FileVerification[]; // only files with a non-'ok' issue, plus a per-file summary
  okCount: number;
  issueCount: number;
}

export interface CorpusRegistry {
  version: string;
  corpora: CorpusEntry[];
  lastUpdated: string;
}
