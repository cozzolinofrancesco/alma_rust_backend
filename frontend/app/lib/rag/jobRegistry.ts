import type { CorpusVerification } from './types';
import { googleAuthFailure } from '../googleAuthErrors';

export interface JobFileInfo {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  pageRange?: { startPage: number; endPage: number };
}

export type JobFileStatusType = 'pending' | 'indexing' | 'indexed' | 'error' | 'skipped';

export interface JobFileStatus extends JobFileInfo {
  status: JobFileStatusType;
  error?: string;
  updatedAt?: string;
}

export interface JobLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  file?: string;
}

export interface JobStatus {
  jobId: string;
  ownerEmail?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'completed_with_errors' | 'cancelled';
  displayName: string;
  folderId: string;
  totalFiles: number;
  processedFiles: number;
  createdAt: string;
  updatedAt: string;
  corpusId?: string;
  error?: string;
  errorCode?: string;
  errorDetails?: unknown;
  allowPartialSuccess?: boolean;
  selectedFiles?: JobFileInfo[];
  files?: JobFileStatus[];
  skipFileIds?: string[];
  currentFileId?: string;
  
  startedAt?: string;
  currentFile?: string;
  currentFileIndex?: number;
  currentOperation?: string;
  // Chunk-level progress for the file currently indexing. Reset to 0/0 between files
  // so the UI sub-bar only shows while a file is actively importing chunks.
  processedChunks?: number;
  totalChunks?: number;
  logs?: JobLogEntry[];
  verification?: CorpusVerification;
}

export function jobBelongsTo(job: JobStatus | null, email?: string | null): job is JobStatus {
  return Boolean(job?.ownerEmail && email && job.ownerEmail === email.trim().toLowerCase());
}

export function jobView(job: JobStatus): Omit<JobStatus, 'errorDetails'> {
  const view = { ...job };
  delete view.errorDetails;
  return view;
}

const MAX_LOG_ENTRIES = 50;
const MAX_JOBS = 100;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;

const globalForJobs = global as unknown as { jobRegistry?: Map<string, JobStatus> };
const jobs = globalForJobs.jobRegistry || new Map<string, JobStatus>();

if (process.env.NODE_ENV !== 'production') {
  globalForJobs.jobRegistry = jobs;
}

function cleanup() {
  const now = Date.now();

  for (const [id, job] of jobs) {
    const updatedAt = new Date(job.updatedAt).getTime();
    if (now - updatedAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }

  if (jobs.size > MAX_JOBS) {
    const toDelete = jobs.size - MAX_JOBS;
    const keys = jobs.keys();
    for (let i = 0; i < toDelete; i++) {
      const key = keys.next().value;
      if (key) jobs.delete(key);
    }
  }
}

function buildInitialFilesFromSelectedFiles(selectedFiles: JobFileInfo[] | undefined): JobFileStatus[] | undefined {
  if (!selectedFiles || selectedFiles.length === 0) return undefined;
  const now = new Date().toISOString();
  return selectedFiles.map((f) => ({
    ...f,
    status: 'pending' as const,
    updatedAt: now,
  }));
}

export async function createJob(
  metadata: Pick<JobStatus, 'displayName' | 'folderId' | 'totalFiles' | 'allowPartialSuccess' | 'ownerEmail'> & { selectedFiles?: JobFileInfo[] }
): Promise<string> {
  const jobId = `job-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  
  const initialFiles = buildInitialFilesFromSelectedFiles(metadata.selectedFiles);

  const newJob: JobStatus = {
    jobId,
    ownerEmail: metadata.ownerEmail?.trim().toLowerCase(),
    status: 'pending',
    displayName: metadata.displayName,
    folderId: metadata.folderId,
    totalFiles: metadata.totalFiles,
    selectedFiles: metadata.selectedFiles,
    files: initialFiles,
    processedFiles: 0,
    allowPartialSuccess: metadata.allowPartialSuccess,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logs: [],
  };

  jobs.set(jobId, newJob);
  cleanup();
  
  return jobId;
}

export async function updateJob(
  jobId: string,
  updates: Partial<Omit<JobStatus, 'jobId' | 'createdAt'>>
): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) {
    console.warn(`Job ${jobId} not found`);
    return;
  }

  const authFailure = googleAuthFailure(updates.errorDetails);
  const updatedJob: JobStatus = {
    ...job,
    ...updates,
    ...(authFailure ? { status: 'failed' as const, error: authFailure.error, errorCode: authFailure.code, errorDetails: undefined,
      currentOperation: undefined, currentFile: undefined } : {}),
    updatedAt: new Date().toISOString(),
  };

  jobs.set(jobId, updatedJob);
}

export async function addJobLog(
  jobId: string,
  entry: Omit<JobLogEntry, 'timestamp'>
): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;
  
  const logEntry: JobLogEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
  };
  
  const logs = job.logs || [];
  logs.push(logEntry);
  
  while (logs.length > MAX_LOG_ENTRIES) {
    logs.shift();
  }
  
  jobs.set(jobId, {
    ...job,
    logs,
    updatedAt: new Date().toISOString(),
  });
}

export async function setJobOperation(
  jobId: string,
  operation: string,
  file?: string,
  fileIndex?: number
): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;
  
  jobs.set(jobId, {
    ...job,
    currentOperation: operation,
    currentFile: file !== undefined ? file : job.currentFile,
    currentFileIndex: fileIndex !== undefined ? fileIndex : job.currentFileIndex,
    updatedAt: new Date().toISOString(),
  });
}

export async function setJobChunkProgress(
  jobId: string,
  done: number,
  total: number
): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;

  jobs.set(jobId, {
    ...job,
    processedChunks: done,
    totalChunks: total,
    updatedAt: new Date().toISOString(),
  });
}

export async function markJobStarted(jobId: string): Promise<void> {
  await updateJob(jobId, {
    status: 'processing',
    startedAt: new Date().toISOString(),
  });
  
  await addJobLog(jobId, {
    level: 'info',
    message: 'Job processing started',
  });
}

export async function skipJobFile(jobId: string, fileId: string): Promise<boolean> {
  const job = jobs.get(jobId);
  if (!job) return false;

  if (job.status !== 'pending' && job.status !== 'processing') return false;

  const ensuredFiles = job.files && job.files.length > 0 ? job.files : buildInitialFilesFromSelectedFiles(job.selectedFiles);

  const skipFileIds = new Set(job.skipFileIds || []);
  skipFileIds.add(fileId);

  const files = ensuredFiles?.map((f) => {
    if (f.id !== fileId) return f;
    return {
      ...f,
      status: 'skipped' as const,
      error: 'Skipped by user',
      updatedAt: new Date().toISOString(),
    };
  });

  jobs.set(jobId, {
    ...job,
    skipFileIds: Array.from(skipFileIds),
    files: files ?? job.files,
    updatedAt: new Date().toISOString(),
  });
  
  return true;
}

export async function isJobFileSkipped(jobId: string, fileId: string): Promise<boolean> {
  const job = jobs.get(jobId);
  return (job?.skipFileIds || []).includes(fileId);
}

export async function setJobFileStatus(
  jobId: string,
  fileId: string,
  updates: Partial<Omit<JobFileStatus, 'id'>>
): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;

  const now = new Date().toISOString();
  const baseFiles = job.files && job.files.length > 0 ? job.files : buildInitialFilesFromSelectedFiles(job.selectedFiles) || [];

  let found = false;
  const nextFiles: JobFileStatus[] = baseFiles.map((f) => {
    if (f.id !== fileId) return f;
    found = true;
    return {
      ...f,
      ...updates,
      id: f.id,
      updatedAt: now,
    };
  });

  if (!found) {
    nextFiles.push({
      id: fileId,
      name: fileId,
      mimeType: 'application/octet-stream',
      size: 0,
      status: (updates.status as JobFileStatusType) || 'pending',
      error: updates.error,
      updatedAt: now,
    });
  }

  jobs.set(jobId, {
    ...job,
    files: nextFiles,
    currentFileId: fileId,
    updatedAt: now,
  });
}

export async function getJob(jobId: string): Promise<JobStatus | null> {
  const job = jobs.get(jobId);
  if (!job) return null;

  if ((job.files == null || job.files.length === 0) && job.selectedFiles && job.selectedFiles.length > 0) {
    const updatedJob = {
      ...job,
      files: buildInitialFilesFromSelectedFiles(job.selectedFiles),
      updatedAt: new Date().toISOString(),
    };
    jobs.set(jobId, updatedJob);
    return updatedJob;
  }

  return job;
}

export async function getAllJobs(): Promise<JobStatus[]> {
  const allJobs = Array.from(jobs.values());
  
  for (const job of allJobs) {
    if ((job.files == null || job.files.length === 0) && job.selectedFiles && job.selectedFiles.length > 0) {
       job.files = buildInitialFilesFromSelectedFiles(job.selectedFiles);
       job.updatedAt = new Date().toISOString();
       jobs.set(job.jobId, job);
    }
  }

  return allJobs.sort((a, b) => 
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export async function isJobCancelled(jobId: string): Promise<boolean> {
  const job = jobs.get(jobId);
  return job?.status === 'cancelled';
}

export async function cancelJob(jobId: string): Promise<boolean> {
  const job = jobs.get(jobId);
  if (!job) return false;
  
  if (job.status !== 'pending' && job.status !== 'processing') {
    return false;
  }
  
  await updateJob(jobId, { 
    status: 'cancelled',
    error: 'Job cancelled by user'
  });
  
  await addJobLog(jobId, {
    level: 'info',
    message: 'Job cancelled by user',
  });
  
  return true;
}

export async function deleteJob(jobId: string): Promise<boolean> {
  return jobs.delete(jobId);
}

export async function flushPendingWrites(): Promise<void> {
}

export function invalidateCache(): void {
}
