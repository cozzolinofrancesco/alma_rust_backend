
import type { OAuth2Client } from 'googleapis-common';
import { CorpusEntry, CorpusFile } from './types';
import { downloadFileStream, getFolderMetadata } from './drive';
import { addOrUpdateCorpus, loadRegistry, getCorpusById } from './registry';
import { GEMINI_MODELS, isValidModel, DEFAULT_API_TIMEOUT_MS, getModelInfo } from '@/app/lib/modelConfig';
import { normaliseDocumentState, aggregateDocumentStates, type DocumentState } from './documentState';
import { parseGroundingMetadata, type DebugAnswerSupport, type DebugSourceChunk } from '@/app/lib/answerDebug';
import { createWriteStream } from 'fs';
import { unlink, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { splitPdfIfNecessary, PageRange } from './pdfSplitter';
import { classifyPdf, extractPdfText, looksLikeGarbledPdfText } from './pdfClassifier';
import { buildFileIdFilter, buildPdfNameFilter } from '@/app/rag-optimization/lib/metadataFilter';
import { 
  updateJob, 
  isJobCancelled, 
  isJobFileSkipped, 
  setJobFileStatus, 
  markJobStarted,
  setJobOperation,
  setJobChunkProgress,
  addJobLog
} from './jobRegistry';
import { ensureFreshToken } from './auth';
import { createLimiter, createRateLimiter, type Limiter } from '@/app/lib/concurrency';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

const FILE_SEARCH_MODEL = GEMINI_MODELS.flash;

const RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 180000,
  rateLimitInitialDelayMs: 30000,   // 429 backoff base (quota resets in <=60s; see fetchWithRetry)
  maxDelayMs: 300000,
  timeoutMs: DEFAULT_API_TIMEOUT_MS,   // global API timeout (see modelConfig.ts)
  delayBetweenChunksMs: 2000,
  delayBetweenFilesMs: 5000,
  // Gemini :importFile is an LRO with a per-minute submission quota (~60 RPM) and the
  // embedding model has a TPM cap — these are RATE limits, not concurrency limits. A single
  // shared rate limiter paces ALL chunk imports across the whole job so we run just under
  // the cap and never trip the 429 -> long backoff. This is the real governor of ingest
  // speed; chunkConcurrency/fileConcurrency below only shape how work feeds into it.
  importRatePerMin: 50,      // under the ~60 RPM cap, with margin. Lower if 429/503 appear.
  importMaxConcurrent: 4,    // socket/in-flight bound; secondary to the rate.
  // How many file pipelines (download/split/preflight/verify) run at once — overlaps that
  // NON-import latency across files. Imports still share the one rate limiter, so this does
  // NOT raise import throughput; keep small.
  fileConcurrency: 3,
  // Per-file cap on chunks fed into the shared import limiter at once (fairness so one big
  // file can't hog the queue). The shared rate limiter is the real cap.
  chunkConcurrency: 4,
  // Transient chunk-level re-upload retries. A genuine outage ("503 service
  // unavailable" / fresh-upload 404) is recoverable by re-uploading a fresh file
  // resource and importing again. This is deliberately a SHORT backoff (unlike the
  // 3-min initialDelayMs above, which governs the fetchWithRetry 429/5xx path): a
  // blip should cost seconds, not minutes.
  transientMaxRetries: 4,
  transientInitialDelayMs: 3000,
  transientMaxDelayMs: 30000,
  transientTotalBudgetMs: 120000,
  // Post-import LRO verification: wait for a file's documents to reach ACTIVE.
  lroVerifyTimeoutMs: 120000,
  lroVerifyIntervalMs: 5000,
  // Job-level auto-retry of transient-only file failures (beats a Google blip
  // without the manual /restart endpoint).
  jobRetryRounds: 1,
  jobRetryBackoffMs: 30000,
};

const DEFAULT_PAGES_PER_CHUNK = 300;
// Keep each chunk's text/plain payload comfortably under the empirical :importFile
// size limit (~0.85 MB imports fine, ~1.15 MB deterministically 503s). Chunks above
// this are recursively page-halved by the splitter; a residual 503 is split again at
// import time (see importPdfPageRange).
const DEFAULT_MAX_CHUNK_BYTES = 800 * 1024;

// Retrieval chunking applied by Gemini at :importFile (see modelConfig.ts).
export interface ChunkingOptions {
  maxTokensPerChunk: number;
  maxOverlapTokens: number;
}

// Per-chunk metadata attached at import. The three core string fields
// (source/chunk_name/pdf_name) are always sent; numeric page bounds and any
// `extra` fields enrich filtering + citations. numeric_value enables AIP-160
// range filters at query time.
export interface ImportMetadata {
  pdfName: string;
  chunkName: string;
  fileId?: string;
  source?: string;
  pageStart?: number;
  pageEnd?: number;
  ingestedAt?: number;
  mimeType?: string;
  extra?: Array<{ key: string; stringValue?: string; numericValue?: number }>;
}

// Optional tuning threaded through every ingestion orchestrator. All fields are
// optional so the default ingestion path is unchanged; the RAG optimizer sets
// `chunking` + `embeddingModel` per index config.
export interface IngestTuning {
  allowPartialSuccess?: boolean;
  chunking?: ChunkingOptions;
  embeddingModel?: string;
  // Verify each file's documents reach ACTIVE (not async-FAILED) before finalizing.
  // Defaults to true for the three orchestrators; the optimizer polls itself and
  // does not use processOneFile, so this does not affect it.
  verifyActive?: boolean;
  // After a PDF indexes, probe it and — if Gemini stored unreadable binary instead of
  // text — auto-rescue by re-importing pdfjs-extracted text. Defaults to true.
  verifyReadable?: boolean;
}

function buildChunkMetadata(
  pdfName: string,
  chunkName: string,
  pageStart: number,
  pageEnd: number,
  mimeType: string | undefined,
  source: string,
  fileId?: string,
): ImportMetadata {
  return {
    pdfName,
    chunkName,
    fileId,
    source,
    pageStart,
    pageEnd,
    ingestedAt: Date.now(),
    mimeType,
  };
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  context: string = 'request',
  retryPolicy?: {
    maxRetries?: number;
    noRetryStatuses?: number[];
  }
): Promise<Response> {
  let lastError: Error | null = null;

  const effectiveMaxRetries = retryPolicy?.maxRetries ?? RETRY_CONFIG.maxRetries;
  const noRetryStatuses = new Set<number>(retryPolicy?.noRetryStatuses ?? []);

  for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RETRY_CONFIG.timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        if (noRetryStatuses.has(response.status)) {
          return response;
        }

        const retryAfter = response.headers.get('Retry-After');
        // A 429 is a per-minute rate quota that resets in <=60s, so a 3-min base backoff is
        // wasteful — use the shorter rate-limit base. 5xx keeps the longer base. Retry-After,
        // when present, always wins.
        const base = response.status === 429
          ? RETRY_CONFIG.rateLimitInitialDelayMs
          : RETRY_CONFIG.initialDelayMs;
        const delay = retryAfter
          ? parseInt(retryAfter) * 1000
          : Math.min(base * Math.pow(2, attempt), RETRY_CONFIG.maxDelayMs);
        
        console.log(`⚠️ [Retry] ${context}: ${response.status} - waiting ${delay}ms (attempt ${attempt + 1}/${effectiveMaxRetries})`);
        
        if (attempt < effectiveMaxRetries) {
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }

      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error instanceof Error ? error : new Error(String(error));

      const isRetryable = 
        lastError.name === 'AbortError' || 
        lastError.message.includes('ECONNRESET') ||
        lastError.message.includes('ETIMEDOUT') ||
        lastError.message.includes('ECONNREFUSED') ||
        lastError.message.includes('fetch failed');

      if (isRetryable && attempt < effectiveMaxRetries) {
        const delay = Math.min(
          RETRY_CONFIG.initialDelayMs * Math.pow(2, attempt),
          RETRY_CONFIG.maxDelayMs
        );
        console.log(`⚠️ [Retry] ${context}: ${lastError.message} - waiting ${delay}ms (attempt ${attempt + 1}/${effectiveMaxRetries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      throw lastError;
    }
  }

  throw lastError || new Error(`Max retries exceeded for ${context}`);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Rough "time remaining" for the chunk import loop, from elapsed-so-far extrapolated
// over the remaining chunks. Returns undefined at the boundaries (nothing to show).
function etaString(startedAt: number, done: number, total: number): string | undefined {
  if (done <= 0 || done >= total) return undefined;
  const perItem = (Date.now() - startedAt) / done;
  const s = Math.round((perItem * (total - done)) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

// Thrown by importFileToStore so callers can classify by HTTP status/body instead
// of parsing a stringified message. bodyText is read from the Response exactly once.
export class GeminiImportError extends Error {
  readonly status: number;
  readonly bodyText: string;
  constructor(status: number, bodyText: string) {
    super(`Gemini import failed (${status}): ${bodyText.slice(0, 400)}`);
    this.name = 'GeminiImportError';
    this.status = status;
    this.bodyText = bodyText;
  }
}

export type ImportErrorClass = 'TRANSIENT' | 'PERMANENT';

// Carries the final classification of a chunk import failure up to the file loop.
// `importClass` drives job-level retry (only TRANSIENT is retried). `sizeSplittable`
// is set for a 503, which — as reproduced against the live API — is a DETERMINISTIC
// size failure (a text/plain payload too large for :importFile; Gemini reports it
// inconsistently as "Failed to count tokens" or "service currently unavailable").
// The caller resolves it by importing a smaller page range, not by plain retry.
export class ChunkImportError extends Error {
  readonly importClass: ImportErrorClass;
  readonly sizeSplittable: boolean;
  constructor(message: string, importClass: ImportErrorClass, sizeSplittable = false) {
    super(message);
    this.name = 'ChunkImportError';
    this.importClass = importClass;
    this.sizeSplittable = sizeSplittable;
  }
}

// A 503 is the size-limit signal (see ChunkImportError). Importing a smaller page
// range fixes it; a plain re-import of the same bytes will not.
export function isSizeLimitError(err: unknown): boolean {
  if (err instanceof ChunkImportError) return err.sizeSplittable;
  return err instanceof GeminiImportError && err.status === 503;
}

// Classify an import error for retry purposes. 429/5xx (incl. 503) and network
// errors are TRANSIENT (worth a bounded retry); 4xx (400 / invalid PDF / the
// pdf_name guard) are PERMANENT. Note: `application/pdf` files are NOT importable
// via :importFile (they return 404 "entity not found" even when ACTIVE), which is
// why PDFs are uploaded as text/plain and oversized ones are split. Genuinely
// scanned/image PDFs (no text layer) are blocked earlier by the preflight classifier.
export function classifyImportError(err: unknown): ImportErrorClass {
  if (err instanceof ChunkImportError) return err.importClass;

  if (!(err instanceof GeminiImportError)) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/AbortError|ECONNRESET|ETIMEDOUT|ECONNREFUSED|fetch failed/i.test(msg)) return 'TRANSIENT';
    return 'PERMANENT';
  }

  const { status } = err;
  if (status === 429) return 'TRANSIENT';
  if (status >= 500 && status < 600) return 'TRANSIENT';
  return 'PERMANENT'; // 400 / invalid PDF / other 4xx
}

function generateStoreName(folderId: string): string {
  const normalized = folderId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `fileSearchStores/folder-${normalized}`;
}

async function getOrCreateFileSearchStore(
  folderId: string,
  displayName: string,
  embeddingModel?: string
): Promise<string> {
  const storeName = generateStoreName(folderId);

  try {
    const checkUrl = `${GEMINI_BASE_URL}/v1beta/${storeName}?key=${GEMINI_API_KEY}`;
    const checkResponse = await fetchWithRetry(checkUrl, { method: 'GET' }, `store-check:${storeName}`);

    if (checkResponse.ok) {
      console.log(`✅ [FileSearchStore] Using existing store: ${storeName}`);
      return storeName;
    }
  } catch (error) {
    console.log(`⚠️ [FileSearchStore] Store check failed, will create new: ${error}`);
  }

  try {
    const createUrl = `${GEMINI_BASE_URL}/v1beta/fileSearchStores?key=${GEMINI_API_KEY}`;
    const createBody: Record<string, unknown> = { display_name: displayName };
    if (embeddingModel) {
      // Embedding model is fixed at store creation. Field name follows the REST
      // snake_case convention used elsewhere in this file; confirm against the
      // live File Search API before relying on the optimizer's embedding tier.
      createBody.embedding_config = { model: `models/${embeddingModel.replace(/^models\//, '')}` };
    }
    const createResponse = await fetchWithRetry(
      createUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody),
      },
      `store-create:${displayName}`
    );

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      throw new Error(`Failed to create File Search Store: ${errorText}`);
    }

    const result = await createResponse.json();
    console.log(`✅ [FileSearchStore] Created new store: ${result.name}`);
    return result.name;
  } catch (error) {
    console.error(`❌ [FileSearchStore] Failed to create store:`, error);
    throw error;
  }
}

async function uploadBufferToGemini(
  buffer: Buffer,
  displayName: string,
  mimeType: string
): Promise<{ name: string; uri: string }> {
  console.log(`📤 [Upload] Starting upload: ${displayName} (${buffer.length} bytes)`);

  const fileSize = buffer.length;

  const uploadInitUrl = `${GEMINI_BASE_URL}/upload/v1beta/files?key=${GEMINI_API_KEY}`;
  const initResponse = await fetchWithRetry(
    uploadInitUrl,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(fileSize),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        file: {
          display_name: displayName,
        },
      }),
    },
    `upload-init:${displayName}`
  );

  if (!initResponse.ok) {
    const errorText = await initResponse.text();
    throw new Error(`Upload init failed: ${errorText}`);
  }

  const uploadUrl = initResponse.headers.get('X-Goog-Upload-Url');
  if (!uploadUrl) {
    throw new Error('No upload URL in response');
  }

  const uploadResponse = await fetchWithRetry(
    uploadUrl,
    {
      method: 'POST',
      headers: {
        'Content-Length': String(fileSize),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: new Uint8Array(buffer),
    },
    `upload-data:${displayName}`
  );

  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    throw new Error(`File upload failed: ${errorText}`);
  }

  const uploadResult = await uploadResponse.json();
  console.log(`✅ [Upload] Upload complete: ${uploadResult.file.uri}`);

  return { 
    name: uploadResult.file.name,
    uri: uploadResult.file.uri
  };
}

async function importFileToStore(
  storeName: string,
  fileResourceName: string,
  metadata: ImportMetadata,
  chunking?: ChunkingOptions,
  retryPolicy?: { maxRetries?: number; noRetryStatuses?: number[] }
): Promise<void> {
  console.log(`📥 [Import] Importing file to store: ${metadata.chunkName} (source: ${metadata.pdfName})`);
  console.log(`📥 [Import] File Resource Name: ${fileResourceName}`);
  console.log(`📥 [Import] Store: ${storeName}`);

  const url = `${GEMINI_BASE_URL}/v1beta/${storeName}:importFile?key=${GEMINI_API_KEY}`;

  // A subset document filter at query time matches on `pdf_name`; importing a chunk
  // with an empty pdf_name would make it silently unfilterable (0 results). Refuse.
  if (!metadata.pdfName || metadata.pdfName.trim().length === 0) {
    throw new Error(`Refusing to import chunk "${metadata.chunkName}" without a pdf_name`);
  }

  const customMetadata: Array<Record<string, unknown>> = [
    { key: 'source', string_value: metadata.source ?? 'google_drive' },
    { key: 'chunk_name', string_value: metadata.chunkName },
    { key: 'pdf_name', string_value: metadata.pdfName },
  ];
  if (metadata.fileId) {
    customMetadata.push({ key: 'file_id', string_value: metadata.fileId });
  }
  if (typeof metadata.pageStart === 'number') {
    customMetadata.push({ key: 'page_start', numeric_value: metadata.pageStart });
  }
  if (typeof metadata.pageEnd === 'number') {
    customMetadata.push({ key: 'page_end', numeric_value: metadata.pageEnd });
  }
  if (typeof metadata.ingestedAt === 'number') {
    customMetadata.push({ key: 'ingested_at', numeric_value: metadata.ingestedAt });
  }
  if (metadata.mimeType) {
    customMetadata.push({ key: 'mime_type', string_value: metadata.mimeType });
  }
  for (const m of metadata.extra ?? []) {
    if (typeof m.numericValue === 'number') {
      customMetadata.push({ key: m.key, numeric_value: m.numericValue });
    } else if (typeof m.stringValue === 'string') {
      customMetadata.push({ key: m.key, string_value: m.stringValue });
    }
  }

  const importBody: Record<string, unknown> = {
    file_name: fileResourceName,
    custom_metadata: customMetadata,
  };
  if (chunking) {
    importBody.chunking_config = {
      white_space_config: {
        max_tokens_per_chunk: chunking.maxTokensPerChunk,
        max_overlap_tokens: chunking.maxOverlapTokens,
      },
    };
  }

  const response = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(importBody),
    },
    `import:${metadata.chunkName}`,
    retryPolicy
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`❌ [Import] Failed to import file:`, errorText);
    throw new GeminiImportError(response.status, errorText);
  }

  const operation = await response.json();
  console.log(`✅ [Import] Import operation started: ${operation.name}`);
  console.log(`⏳ [Import] File will be indexed asynchronously`);
}

// Upload + import one chunk under a single mime, retrying only genuine transient
// errors (429/5xx/network) with a fresh re-upload + short backoff. A 503 is kept
// in the retry set (it can be a real blip) but is also flagged sizeSplittable so a
// caller with page context can resolve a persistent 503 by importing a smaller page
// range (see importPdfPageRange). Permanent errors (400 / invalid PDF) fail fast.
// The final error is a ChunkImportError carrying the classification + size flag.
async function uploadAndImportChunk(
  storeName: string,
  buffer: Buffer,
  chunkName: string,
  metadata: ImportMetadata,
  mime: string,
  chunking?: ChunkingOptions,
): Promise<{ uri: string }> {
  // One upload+import attempt. Import runs with maxRetries:0 so backoff/retry is
  // owned here (which can re-upload), not inside fetchWithRetry (which cannot).
  const attemptOnce = async (): Promise<{ uri: string }> => {
    const { name: fileResourceName, uri } = await uploadBufferToGemini(buffer, chunkName, mime);
    await importFileToStore(storeName, fileResourceName, metadata, chunking, { maxRetries: 0 });
    return { uri };
  };

  const startedAt = Date.now();
  let attempt = 0;
  for (;;) {
    try {
      return await attemptOnce();
    } catch (err) {
      const cls = classifyImportError(err);
      const sizeSplittable = isSizeLimitError(err);
      // A 503 is deterministic (size) — don't burn the full retry budget on it;
      // one quick retry covers a real blip, then let the caller split.
      const budget = sizeSplittable ? 1 : RETRY_CONFIG.transientMaxRetries;
      if (
        cls !== 'TRANSIENT' ||
        attempt >= budget ||
        Date.now() - startedAt > RETRY_CONFIG.transientTotalBudgetMs
      ) {
        throw new ChunkImportError(err instanceof Error ? err.message : String(err), cls, sizeSplittable);
      }
      attempt++;
      const backoff = Math.min(
        RETRY_CONFIG.transientInitialDelayMs * 2 ** (attempt - 1),
        RETRY_CONFIG.transientMaxDelayMs,
      );
      console.warn(`⚠️ [Import] Transient failure for ${chunkName} (attempt ${attempt}); re-uploading in ${backoff}ms`);
      await delay(backoff);
    }
  }
}

// Import a PDF page range, handling the two distinct failure modes separately:
//   • a text/plain SIZE 503 (payload too large) → recursively halve the page range;
//   • any OTHER text/plain failure → fall back to importing the same bytes as
//     application/pdf (last resort; usually 404s — scanned PDFs are blocked at preflight).
// Returns the last chunk URI and the leaf-document count.
async function importPdfPageRange(args: {
  storeName: string;
  fullBuffer: Buffer;
  fileName: string;
  fileId?: string;
  source: string;
  mimeType: string | undefined;
  pageStart: number;
  pageEnd: number;
  chunking?: ChunkingOptions;
  onLog?: (line: string) => void;
  rangeBuffer?: Buffer; // pre-extracted buffer for [pageStart,pageEnd]; extracted if absent
  preferMime?: string; // force this mime (e.g. rasterised chunks import as application/pdf, not text/plain)
}): Promise<{ uri: string; leaves: number }> {
  const { storeName, fullBuffer, fileName, fileId, source, mimeType, pageStart, pageEnd, chunking, onLog, rangeBuffer, preferMime } = args;
  const baseName = fileName.replace(/\.pdf$/i, '');
  const chunkName = `${baseName}_p${pageStart}-${pageEnd}.pdf`;

  const buffer = rangeBuffer
    ?? (await splitPdfIfNecessary(fullBuffer, fileName, { startPage: pageStart, endPage: pageEnd }, DEFAULT_PAGES_PER_CHUNK))[0].buffer;
  const metadata = buildChunkMetadata(fileName, chunkName, pageStart, pageEnd, mimeType, source, fileId);

  // A rasterised chunk (preferMime set) is already a single image PDF: import it under
  // that mime directly — a text/plain attempt would fail or index garbage, and there is
  // no page range left to split.
  if (preferMime) {
    try {
      const { uri } = await uploadAndImportChunk(storeName, buffer, chunkName, metadata, preferMime, chunking);
      return { uri, leaves: 1 };
    } catch (err) {
      throw new ChunkImportError(
        err instanceof Error ? err.message : String(err),
        classifyImportError(err),
        isSizeLimitError(err),
      );
    }
  }

  try {
    const { uri } = await uploadAndImportChunk(storeName, buffer, chunkName, metadata, 'text/plain', chunking);
    return { uri, leaves: 1 };
  } catch (err) {
    // Oversized text/plain payload: split the page range and retry each half.
    if (isSizeLimitError(err) && pageEnd > pageStart) {
      const mid = Math.floor((pageStart + pageEnd) / 2);
      onLog?.(`Pages ${pageStart}-${pageEnd} too large as text/plain; splitting at page ${mid} and retrying.`);
      const left = await importPdfPageRange({ ...args, pageStart, pageEnd: mid, rangeBuffer: undefined });
      const right = await importPdfPageRange({ ...args, pageStart: mid + 1, pageEnd, rangeBuffer: undefined });
      return { uri: right.uri, leaves: left.leaves + right.leaves };
    }
    // Other text/plain failure (incl. an unsplittable single-page size 503): retry the
    // same bytes as application/pdf — a last-resort fallback (note: :importFile 404s on
    // application/pdf, so this rarely helps; genuinely scanned PDFs are blocked at preflight).
    const reason = err instanceof Error ? err.message : String(err);
    onLog?.(`Pages ${pageStart}-${pageEnd} failed as text/plain (${reason.slice(0, 100)}); retrying as application/pdf.`);
    try {
      const { uri } = await uploadAndImportChunk(storeName, buffer, chunkName, metadata, 'application/pdf', chunking);
      return { uri, leaves: 1 };
    } catch (pdfErr) {
      const pdfReason = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
      throw new ChunkImportError(
        `Import failed as text/plain (${reason}) and as application/pdf (${pdfReason})`,
        classifyImportError(pdfErr),
        isSizeLimitError(pdfErr),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Shared ingestion engine
//
// The three orchestrators (Drive-create, Drive-add, local) differ only in how a
// file's bytes are obtained and a couple of log labels. Everything else — the
// per-file body (chunk loop, status/partial logic, LRO verification), the file
// loop (cancellation/skip/rate-limit/token refresh/checkpoint), the job-level
// auto-retry, and finalization — is shared here so resilience lives in one place.
// ---------------------------------------------------------------------------

interface ProcessFileInput {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  pageRange?: PageRange;
}

interface ResolvedBuffer {
  buffer: Buffer;
  downloadedMimeType: string;
  cleanup: () => Promise<void>;
}
type BufferResolver = () => Promise<ResolvedBuffer>;

interface ProcessFileResult {
  status: 'indexed' | 'error';
  transientOnly: boolean;
}

function makeDriveResolver(auth: OAuth2Client): (file: ProcessFileInput) => BufferResolver {
  return (file) => async () => {
    const tempPath = join(tmpdir(), `gemini-processing-${Date.now()}-${file.fileId}`);
    const { stream: driveStream, mimeType: downloadedMimeType } = await downloadFileStream(file.fileId, auth, file.mimeType);
    const writeStream = createWriteStream(tempPath);
    await pipeline(driveStream as NodeJS.ReadableStream, writeStream);
    const buffer = await readFile(tempPath);
    return {
      buffer,
      downloadedMimeType,
      cleanup: async () => { try { await unlink(tempPath); } catch { /* ignore */ } },
    };
  };
}

function makeLocalResolver(localFiles: LocalRagFile[]): (file: ProcessFileInput) => BufferResolver {
  const byId = new Map(localFiles.map((f) => [f.id, f]));
  return (file) => async () => {
    const lf = byId.get(file.fileId);
    if (!lf) throw new Error(`Local file buffer missing for ${file.fileId}`);
    return {
      buffer: lf.buffer,
      downloadedMimeType: lf.mimeType || 'application/octet-stream',
      cleanup: async () => { /* in-memory, nothing to clean */ },
    };
  };
}

// Poll a single file's documents until ACTIVE. On definitively FAILED docs, self-heal
// once (delete this file's docs + re-import all chunks). Never throws and never
// downgrades on an inconclusive result (timeout / list error) — indexing that is
// merely slow must not flip an imported file to error.
async function verifyFileActive(
  storeName: string,
  file: { fileId: string; name: string },
  reimportAll: () => Promise<void>,
  onLog: (line: string) => void,
): Promise<{ active: boolean; failed: number; total: number; healed: number; timedOut: boolean }> {
  const startedAt = Date.now();
  let healAttempted = false;
  let healed = 0;

  for (;;) {
    let docs: StoreDocument[];
    try {
      docs = (await listStoreDocuments(storeName)).filter((d) => documentBelongsToFile(d, file));
    } catch (e) {
      onLog(`[verifyFileActive] ${file.name}: could not list documents (${e instanceof Error ? e.message : e}); leaving as indexed`);
      return { active: true, failed: 0, total: 0, healed, timedOut: false };
    }

    const states = docs.map((d) => d.state);
    const agg = aggregateDocumentStates(states);
    const failed = states.filter((s) => s === 'FAILED').length;

    if (agg === 'ACTIVE') return { active: true, failed: 0, total: states.length, healed, timedOut: false };

    if (agg === 'FAILED') {
      if (!healAttempted) {
        healAttempted = true;
        onLog(`[verifyFileActive] ${file.name}: ${failed} FAILED doc(s); self-healing (delete + re-import)`);
        for (const d of docs) {
          try { await deleteDocumentFromStore(d.name); } catch { /* best effort */ }
        }
        try {
          await reimportAll();
          healed = failed;
          continue; // re-poll the freshly re-imported docs
        } catch (e) {
          onLog(`[verifyFileActive] ${file.name}: self-heal re-import failed (${e instanceof Error ? e.message : e})`);
          return { active: false, failed, total: states.length, healed, timedOut: false };
        }
      }
      return { active: false, failed, total: states.length, healed, timedOut: false };
    }

    // PROCESSING (or no docs visible yet)
    if (Date.now() - startedAt > RETRY_CONFIG.lroVerifyTimeoutMs) {
      return { active: false, failed, total: states.length, healed, timedOut: true };
    }
    await delay(RETRY_CONFIG.lroVerifyIntervalMs);
  }
}

// ---------------------------------------------------------------------------
// Readability gate + auto-rescue
//
// A PDF can import + reach ACTIVE yet be UNREADABLE at query time: Gemini :importFile
// occasionally stores the PDF bytes as opaque binary instead of extracting text (seen
// on Ghostscript-reprocessed chunks). The file looks "indexed" but every query returns
// raw-PDF garbage. We detect that with one probe query scoped to the file, and rescue
// it by re-importing pdfjs-extracted text as text/plain.
// ---------------------------------------------------------------------------

const READABILITY_PROBE_QUESTION = 'Summarize the main content of this document in one sentence.';
const MIN_RESCUE_TEXT_CHARS = 40;   // below this there is nothing worth re-importing
const SAFE_TEXT_CHUNK_BYTES = 400_000; // keep each text/plain payload well under the import limit
const OCR_MAX_PAGES = 50; // cap OCR fallback cost; beyond this we OCR the first N pages and warn

// Is a candidate rescue text usable? Combines the length floor, the raw-binary detector,
// and the glyph-soup detector (a Veeva-Vault-style PDF with no ToUnicode CMap yields
// ASCII-range gibberish that passes looksLikeUnreadableChunkText but fails this).
function isAcceptableRescueText(text: string): boolean {
  return (
    text.length >= MIN_RESCUE_TEXT_CHARS &&
    !looksLikeUnreadableChunkText(text) &&
    !looksLikeGarbledPdfText(text)
  );
}

// Language-agnostic "this is raw PDF binary, not text" detector. Deliberately does NOT
// use a printable-ASCII ratio (that would wrongly flag valid CJK/accented text). Instead
// it looks for PDF structural tokens and a high share of control characters.
function looksLikeUnreadableChunkText(text: string): boolean {
  if (!text) return true;
  if (/%PDF-|endstream|endobj|startxref|\/FlateDecode|\/XObject\b/i.test(text)) return true;
  let control = 0;
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    // control chars excluding tab/newline/carriage-return, plus the U+FFFD replacement char
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffd) control++;
  }
  return control / text.length > 0.1;
}

// Probe the just-indexed file with a scoped query and judge whether it returns readable
// content. Fail-open: on any probe error we report readable (never block ingestion on a
// flaky probe). Returns the reason for logging.
// `failOpen` (default true) governs how a probe *error* is treated. The PRE-rescue probe
// stays fail-open: a flaky probe must never block ingestion. The POST-rescue probe passes
// failOpen:false so a broken probe cannot mask a still-unreadable file as "Completed".
async function probeFileReadable(
  storeName: string,
  fileId: string | undefined,
  pdfName: string,
  failOpen = true,
): Promise<{ readable: boolean; reason: string }> {
  const filter = fileId ? buildFileIdFilter([fileId]) : buildPdfNameFilter([pdfName]);
  try {
    const result = await queryFileSearchStore(
      storeName,
      storeName,
      [{ role: 'user', text: READABILITY_PROBE_QUESTION }],
      undefined,
      undefined,
      filter,
    );
    const chunks = result.groundingChunks ?? [];
    if (!result.isGrounded || chunks.length === 0) {
      return { readable: false, reason: 'no grounded content retrieved' };
    }
    const grounding = chunks.map((c) => c.text ?? '').join('\n');
    if (looksLikeUnreadableChunkText(grounding)) {
      return { readable: false, reason: 'retrieved content is raw PDF binary / unreadable' };
    }
    return { readable: true, reason: 'readable grounded content' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return failOpen
      ? { readable: true, reason: `probe error (fail-open): ${msg}` }
      : { readable: false, reason: `probe error (fail-closed): ${msg}` };
  }
}

// Chunk-name conventions used to tell the readable text apart from the raw binary:
//   rescue text : `${base}_text.txt` / `${base}_text_${n}.txt`  (created only below)
//   original PDF: `${base}.pdf` / `${base}_p<start>-<end>.pdf`  (importPdfPageRange / pdfSplitter)
// This lets the rescue delete ONLY the binary chunks and never the freshly-imported text.
function escapeRegExpLocal(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rescueChunkName(baseName: string, index: number, total: number): string {
  return total === 1 ? `${baseName}_text.txt` : `${baseName}_text_${index + 1}.txt`;
}

function isRescueTextChunk(chunkName: string | null, baseName: string): boolean {
  if (!chunkName) return false;
  if (chunkName === `${baseName}_text.txt`) return true;
  return new RegExp(`^${escapeRegExpLocal(baseName)}_text_\\d+\\.txt$`).test(chunkName);
}

function isBinaryPdfChunk(chunkName: string | null, baseName: string): boolean {
  if (!chunkName) return false;
  if (chunkName === `${baseName}.pdf`) return true;
  return new RegExp(`^${escapeRegExpLocal(baseName)}_p\\d+-\\d+\\.pdf$`).test(chunkName);
}

// Split text into byte-bounded pieces so each text/plain payload imports in one shot.
function splitTextIntoPieces(text: string): string[] {
  const pieces: string[] = [];
  let buf = '';
  for (const para of text.split('\n\n')) {
    const candidate = buf ? `${buf}\n\n${para}` : para;
    if (Buffer.byteLength(candidate, 'utf8') > SAFE_TEXT_CHUNK_BYTES && buf) {
      pieces.push(buf);
      buf = para;
    } else {
      buf = candidate;
    }
  }
  if (buf) pieces.push(buf);
  return pieces;
}

// OCR fallback: rasterise each page and run Gemini OCR to recover real text when the PDF's
// own text layer is missing/garbled (custom font encodings, no ToUnicode CMap — typical of
// Veeva Vault exports). Reuses geminiOCR (app/lib/geminiOCR) as a library call and the
// pdf2pic fromBuffer pattern (see pdfCompressor). Native/heavy deps are imported lazily.
// geminiOCR returns LaTeX-formatted plain text — accepted as searchable content (far better
// than binary). Never throws: a failing page is logged and skipped. Returns joined text
// ('' if nothing recovered); capped at maxPages to bound cost.
async function ocrPdfToText(args: {
  buffer: Buffer;
  fileName: string;
  maxPages: number;
  onLog?: (line: string) => void;
}): Promise<string> {
  const { buffer, fileName, maxPages, onLog } = args;
  let pageCount = 0;
  try {
    const { PDFDocument } = await import('pdf-lib');
    pageCount = (await PDFDocument.load(buffer, { updateMetadata: false })).getPageCount();
  } catch (err) {
    onLog?.(`OCR fallback: could not read ${fileName} page count (${err instanceof Error ? err.message : String(err)}).`);
    return '';
  }
  if (pageCount === 0) return '';

  const pagesToOcr = Math.min(pageCount, maxPages);
  if (pageCount > maxPages) {
    onLog?.(`OCR fallback: ${fileName} has ${pageCount} pages; OCR is capped at ${maxPages} — later pages will not be searchable.`);
  }
  onLog?.(`Running OCR on ${pagesToOcr} page(s) to recover text…`);

  const { fromBuffer: pdf2picFromBuffer } = await import('pdf2pic');
  const { geminiOCR } = await import('../geminiOCR');
  const convert = pdf2picFromBuffer(buffer, { density: 300, format: 'png', preserveAspectRatio: true });

  const texts: string[] = [];
  for (let page = 1; page <= pagesToOcr; page++) {
    let tmpPng: string | null = null;
    try {
      const rendered = await convert(page, { responseType: 'buffer' });
      if (!rendered.buffer) continue;
      tmpPng = join(tmpdir(), `ocr-rescue-${Date.now()}-${page}.png`);
      await writeFile(tmpPng, rendered.buffer);
      const { text, error } = await geminiOCR(tmpPng, `${fileName}_page_${page}`);
      if (error) {
        onLog?.(`OCR fallback: page ${page} failed (${error}).`);
      } else if (text && text.trim()) {
        texts.push(text.trim());
      }
    } catch (err) {
      onLog?.(`OCR fallback: page ${page} render/ocr error (${err instanceof Error ? err.message : String(err)}).`);
    } finally {
      if (tmpPng) { try { await unlink(tmpPng); } catch { /* best effort */ } }
    }
  }
  return texts.join('\n\n').trim();
}

// Poll until the freshly-imported rescue text chunks reach ACTIVE, so we never delete the
// binary chunk (and re-probe) while the readable replacement is still PROCESSING. Unlike
// verifyFileActive this does NOT self-heal (that path would re-import the binary chunk).
// Bounded by RETRY_CONFIG; returns false on timeout (the caller still relies on the
// fail-closed re-probe as the ultimate gate).
async function waitForDocumentsActive(
  storeName: string,
  file: { fileId: string; name: string },
  onlyChunkNames: Set<string>,
  onLog?: (line: string) => void,
): Promise<boolean> {
  if (onlyChunkNames.size === 0) return false;
  const startedAt = Date.now();
  for (;;) {
    let docs: StoreDocument[];
    try {
      docs = (await listStoreDocuments(storeName))
        .filter((d) => documentBelongsToFile(d, file))
        .filter((d) => d.chunkName !== null && onlyChunkNames.has(d.chunkName));
    } catch (e) {
      onLog?.(`waitForDocumentsActive: list failed (${e instanceof Error ? e.message : String(e)}).`);
      return false;
    }
    if (docs.length > 0 && aggregateDocumentStates(docs.map((d) => d.state)) === 'ACTIVE') return true;
    if (Date.now() - startedAt > RETRY_CONFIG.lroVerifyTimeoutMs) return false;
    await delay(RETRY_CONFIG.lroVerifyIntervalMs);
  }
}

type RescueMethod = 'pdfjs' | 'ocr' | 'existing' | 'none';
interface RescueOutcome { rescued: boolean; method: RescueMethod; reason: string }

// Authoritative auto-rescue. Recovers readable text (pdfjs text layer first, OCR fallback
// when that is thin/garbled), re-imports it as text/plain chunk(s), waits for them to go
// ACTIVE, then DELETES the original raw-binary chunk(s) so a later query can only retrieve
// the clean text. Idempotent: if acceptable ACTIVE rescue-text chunks already exist (job
// retry), it skips extraction/import and just prunes leftover binary chunks. The caller
// re-probes (fail-closed) to confirm readability before reporting success.
async function rescueFileWithExtractedText(args: {
  storeName: string;
  buffer: Buffer;
  fileName: string;
  fileId?: string;
  source: string;
  chunking?: ChunkingOptions;
  onLog?: (line: string) => void;
}): Promise<RescueOutcome> {
  const { storeName, buffer, fileName, fileId, source, chunking, onLog } = args;
  const baseName = fileName.replace(/\.pdf$/i, '');
  const file = { fileId: fileId ?? '', name: fileName };
  const importedNames = new Set<string>();

  // Idempotency: a prior (possibly interrupted) rescue may already have imported ACTIVE
  // text chunks. If so, skip re-extraction/import and go straight to pruning the binary.
  let alreadyRescued = false;
  try {
    const existing = (await listStoreDocuments(storeName)).filter((d) => documentBelongsToFile(d, file));
    const activeText = existing.filter((d) => isRescueTextChunk(d.chunkName, baseName) && d.state === 'ACTIVE');
    if (activeText.length > 0) {
      alreadyRescued = true;
      for (const d of activeText) if (d.chunkName) importedNames.add(d.chunkName);
      onLog?.(`Auto-rescue: ${activeText.length} extracted-text chunk(s) already present; skipping re-extraction.`);
    }
  } catch { /* fall through to a fresh rescue */ }

  let method: RescueMethod = 'existing';
  if (!alreadyRescued) {
    // 1) Recover text: pdfjs text layer first, OCR fallback when it is thin/garbled.
    let text = await extractPdfText(buffer);
    method = 'pdfjs';
    if (!isAcceptableRescueText(text)) {
      onLog?.(`Auto-rescue: pdfjs text unusable for ${fileName} (${text.length} chars); running OCR to recover searchable text…`);
      text = await ocrPdfToText({ buffer, fileName, maxPages: OCR_MAX_PAGES, onLog });
      method = 'ocr';
      if (text) onLog?.(`OCR recovered ${text.length} characters; re-indexing as searchable text.`);
    }
    if (!isAcceptableRescueText(text)) {
      return { rescued: false, method: 'none', reason: 'no usable text via pdfjs or OCR' };
    }

    // 2) Import clean text FIRST (so there is never a window with zero readable chunks).
    const pieces = splitTextIntoPieces(text);
    for (let i = 0; i < pieces.length; i++) {
      const chunkName = rescueChunkName(baseName, i, pieces.length);
      const metadata = buildChunkMetadata(fileName, chunkName, 0, 0, 'text/plain', source, fileId);
      try {
        await uploadAndImportChunk(storeName, Buffer.from(pieces[i], 'utf8'), chunkName, metadata, 'text/plain', chunking);
        importedNames.add(chunkName);
      } catch (err) {
        onLog?.(`Auto-rescue: failed to import extracted-text chunk ${chunkName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (importedNames.size === 0) return { rescued: false, method, reason: 'text import failed' };
    onLog?.(`Auto-rescue: re-indexed ${importedNames.size} extracted-text chunk(s) for ${fileName} (via ${method}).`);
  }

  // 3) Wait for the readable replacement to be queryable before removing the binary.
  await waitForDocumentsActive(storeName, file, importedNames, onLog);

  // 4) Delete ONLY the original binary chunk(s): positive binary-name match, never a
  //    rescue-text chunk, never a name we just imported. Unknown-named chunks are left as-is.
  try {
    const docs = (await listStoreDocuments(storeName)).filter((d) => documentBelongsToFile(d, file));
    const binary = docs.filter(
      (d) =>
        isBinaryPdfChunk(d.chunkName, baseName) &&
        !isRescueTextChunk(d.chunkName, baseName) &&
        !(d.chunkName !== null && importedNames.has(d.chunkName)),
    );
    let deleted = 0;
    for (const d of binary) {
      try {
        await deleteDocumentFromStore(d.name);
        deleted++;
      } catch (err) {
        onLog?.(`Auto-rescue: failed to delete binary chunk ${d.chunkName ?? d.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (deleted > 0) onLog?.(`Removed ${deleted} unreadable binary chunk(s) after rescue.`);
  } catch (err) {
    onLog?.(`Auto-rescue: could not prune binary chunks (${err instanceof Error ? err.message : String(err)}).`);
  }

  return { rescued: true, method, reason: `rescued via ${method}` };
}

// Process one file end-to-end: resolve bytes → split → import each chunk (with
// transient re-upload retry) → verify ACTIVE. Mutates corpusFile + emits job logs
// exactly as the original inline loops did. Returns the terminal status and whether
// its failure (if any) was transient-only (→ eligible for job-level auto-retry).
async function processOneFile(args: {
  storeName: string;
  file: ProcessFileInput;
  corpusFile: CorpusFile;
  upsertCorpusFile: (f: CorpusFile) => void;
  resolveBuffer: BufferResolver;
  options?: IngestTuning;
  jobId?: string;
  fileIndex: number;
  // Shared across ALL files in the job: paces every :importFile to the global rate cap.
  importLimiter: Limiter;
  // Job-wide aggregate chunk progress (multiple files may be in flight at once).
  chunkProgress: { addTotal: (n: number) => void; increment: () => void };
}): Promise<ProcessFileResult> {
  const { storeName, file, corpusFile, upsertCorpusFile, resolveBuffer, options, jobId, fileIndex, importLimiter, chunkProgress } = args;
  const allowPartialSuccess = options?.allowPartialSuccess === true;
  const verifyActive = options?.verifyActive !== false;
  const verifyReadable = options?.verifyReadable !== false;

  let cleanup: (() => Promise<void>) | undefined;
  const chunkFailures: Array<{ name: string; pageStart: number; pageEnd: number; error: string; class: ImportErrorClass }> = [];

  try {
    const resolved = await resolveBuffer();
    cleanup = resolved.cleanup;
    const { buffer, downloadedMimeType } = resolved;

    // Treat as PDF on mime OR a .pdf extension: Drive/local uploads sometimes arrive
    // as application/octet-stream (or an empty mime), which would otherwise skip the
    // PDF-specific path (text/plain upload + scan preflight) entirely.
    const isPdf =
      downloadedMimeType === 'application/pdf' || /\.pdf$/i.test(file.name);
    // PDFs are uploaded as text/plain (application/pdf is not importable via
    // :importFile). Non-PDFs keep their own mime.
    const uploadMimeType =
      isPdf ? 'text/plain' : (downloadedMimeType || 'application/octet-stream');

    // Preflight: block scanned/image-only PDFs. Gemini File Search indexes only a
    // text layer (no OCR), so a scan would import but be unreadable at query time.
    // Fail fast with guidance instead. Fail-open: classifyPdf only returns 'scanned'
    // on a confident signal and never throws (→ 'unknown' → allowed).
    if (isPdf) {
      // Surface the preflight in the live UI (job card + activity log) so the user
      // can see the scan check happening before ingestion.
      if (jobId) {
        await setJobOperation(jobId, 'checking_pdf_for_text_layer', file.name, fileIndex + 1);
        await addJobLog(jobId, { level: 'info', message: `Checking PDF for a searchable text layer (scan detection)…`, file: file.name });
      }
      const verdict = await classifyPdf(buffer);
      console.log(`🔎 [FileSearchStore] PDF preflight: ${file.name} → ${verdict.kind} (${verdict.reason}; chars/pg=${Math.round(verdict.charsPerPage)}, readable=${verdict.textReadableRatio.toFixed(2)}, imgOps=${verdict.imageOpRatio.toFixed(2)}, mime=${downloadedMimeType})`);
      if (jobId && verdict.kind !== 'scanned') {
        await addJobLog(jobId, { level: 'info', message: `Text layer OK (${verdict.kind}) — proceeding to index.`, file: file.name });
      }
      if (verdict.kind === 'scanned') {
        const message = 'Scanned/image PDF — no searchable text layer. Run OCR to make it searchable, then re-upload (see the "How to OCR a scanned PDF" help).';
        corpusFile.status = 'skipped';
        corpusFile.error = message;
        corpusFile.errorDetails = { reason: 'scanned_pdf', classification: verdict };
        upsertCorpusFile(corpusFile);
        console.warn(`🚫 [FileSearchStore] Scanned PDF blocked: ${file.name} (${verdict.reason})`);
        if (jobId) {
          await setJobFileStatus(jobId, file.fileId, { status: 'skipped', error: message });
          await addJobLog(jobId, { level: 'warn', message: `Scanned PDF blocked: ${file.name} — ${verdict.reason}`, file: file.name });
        }
        return { status: 'error', transientOnly: false };
      }
    }

    if (file.pageRange) {
      console.log(`📄 [FileSearchStore] File ${file.name} has page range configured: ${file.pageRange.startPage}-${file.pageRange.endPage}`);
    }

    // For PDFs, cap chunk size up front so most chunks import in one shot; a residual
    // size 503 is resolved by importPdfPageRange splitting the range further.
    const chunks = await splitPdfIfNecessary(
      buffer, file.name, file.pageRange, DEFAULT_PAGES_PER_CHUNK, undefined,
      isPdf ? DEFAULT_MAX_CHUNK_BYTES : undefined,
    );
    console.log(`File ${file.name} prepared as ${chunks.length} chunk(s)`);

    const importChunk = (chunk: (typeof chunks)[number]) =>
      isPdf
        ? importPdfPageRange({
            storeName,
            fullBuffer: buffer,
            fileName: file.name,
            fileId: file.fileId,
            source: 'google_drive',
            mimeType: file.mimeType,
            pageStart: chunk.pageStart,
            pageEnd: chunk.pageEnd,
            chunking: options?.chunking,
            rangeBuffer: chunk.buffer,
            preferMime: chunk.rasterizedMime,
            onLog: jobId
              ? (line) => { void addJobLog(jobId, { level: 'warn', message: line, file: file.name }); }
              : undefined,
          })
        : uploadAndImportChunk(
            storeName,
            chunk.buffer,
            chunk.name,
            buildChunkMetadata(file.name, chunk.name, chunk.pageStart, chunk.pageEnd, file.mimeType, 'google_drive', file.fileId),
            uploadMimeType,
            options?.chunking,
          );

    let succeededChunks = 0;
    let lastChunkUri: string | undefined;

    // Import chunks in batches of chunkConcurrency, but every :importFile goes through the
    // SHARED importLimiter so the whole job stays under the Gemini rate cap no matter how many
    // files are in flight. Batching per file (a) bounds how many of THIS file's chunks sit in
    // the shared queue at once (fair interleaving across files) and (b) lets us fail-fast and
    // check cancellation between batches. Safety: concurrent callbacks NEVER mutate shared
    // state (they catch and return a discriminated result); all mutation of succeededChunks /
    // lastChunkUri / chunkFailures happens in the sequential post-batch reduce, so no races.
    const totalChunks = chunks.length;
    chunkProgress.addTotal(totalChunks);

    const chunkConcurrency = Math.max(1, RETRY_CONFIG.chunkConcurrency);

    type ChunkOutcome =
      | { ok: true; uri: string; chunk: (typeof chunks)[number] }
      | { ok: false; error: unknown; chunk: (typeof chunks)[number] };

    for (let batchStart = 0; batchStart < chunks.length; batchStart += chunkConcurrency) {
      if (jobId && (await isJobCancelled(jobId))) break;

      const batch = chunks.slice(batchStart, batchStart + chunkConcurrency);

      const batchResults: ChunkOutcome[] = await Promise.all(
        batch.map(async (chunk): Promise<ChunkOutcome> => {
          console.log(`📦 [Chunk] Processing ${chunk.name}: pages ${chunk.pageStart}-${chunk.pageEnd} | ${chunk.sizeMB} MB`);
          try {
            const { uri } = await importLimiter.run(() => importChunk(chunk));
            return { ok: true, uri, chunk };
          } catch (error) {
            return { ok: false, error, chunk };
          }
        }),
      );

      // Sequential reduce — the ONLY place shared state mutates.
      let firstHardError: unknown;
      for (const r of batchResults) {
        chunkProgress.increment();   // job-wide processed count + throttled milestone log
        if (r.ok) {
          succeededChunks++;
          lastChunkUri = r.uri;
          console.log(`✅ [Chunk] Completed ${r.chunk.name} (pages ${r.chunk.pageStart}-${r.chunk.pageEnd})`);
        } else {
          const errorMsg = r.error instanceof Error ? r.error.message : String(r.error);
          const cls = r.error instanceof ChunkImportError
            ? r.error.importClass
            : classifyImportError(r.error);
          console.error(`❌ [Chunk] FAILED ${r.chunk.name}:`);
          console.error(`   📍 Pages: ${r.chunk.pageStart}-${r.chunk.pageEnd}`);
          console.error(`   📏 Size: ${r.chunk.sizeMB} MB (${r.chunk.sizeBytes} bytes)`);
          console.error(`   ❗ Error: ${errorMsg}`);

          chunkFailures.push({ name: r.chunk.name, pageStart: r.chunk.pageStart, pageEnd: r.chunk.pageEnd, error: errorMsg, class: cls });

          if (jobId) {
            await addJobLog(jobId, {
              level: 'warn',
              message: `Chunk failed (pages ${r.chunk.pageStart}-${r.chunk.pageEnd}): ${errorMsg}`,
              file: file.name,
            });
          }

          if (!allowPartialSuccess && firstHardError === undefined) firstHardError = r.error;
        }
      }

      // Preserve fail-fast: throw AFTER the reduce so partial state is recorded first.
      if (firstHardError !== undefined) throw firstHardError;
    }

    // LRO verification: only when we're about to claim FULL success. Confirm this
    // file's documents reached ACTIVE (not async-FAILED) before trusting "indexed".
    let verifyWarning: string | undefined;
    if (verifyActive && chunkFailures.length === 0 && succeededChunks > 0) {
      const reimportAll = async () => {
        for (const chunk of chunks) {
          await importLimiter.run(() => importChunk(chunk));
        }
      };
      const v = await verifyFileActive(storeName, { fileId: file.fileId, name: file.name }, reimportAll, (l) => console.log(l));
      if (!v.active && !v.timedOut) {
        chunkFailures.push({
          name: file.name,
          pageStart: 0,
          pageEnd: 0,
          error: `Indexing failed: ${v.failed}/${v.total} document(s) FAILED after self-heal`,
          class: 'PERMANENT',
        });
        if (jobId) {
          await addJobLog(jobId, { level: 'warn', message: `Indexing verification: ${v.failed}/${v.total} document(s) FAILED for ${file.name}`, file: file.name });
        }
      } else if (!v.active && v.timedOut) {
        verifyWarning = `Indexing still in progress after ${Math.round(RETRY_CONFIG.lroVerifyTimeoutMs / 1000)}s (verification timed out)`;
        if (jobId) {
          await addJobLog(jobId, { level: 'warn', message: `${verifyWarning}: ${file.name}`, file: file.name });
        }
      }
    }

    // Readability gate (PDFs): a file can be ACTIVE yet unreadable (Gemini stored the PDF
    // bytes as opaque binary). Probe it and auto-rescue with extracted text before we
    // claim success. Skipped on verify-timeout (content isn't queryable yet).
    if (isPdf && verifyReadable && chunkFailures.length === 0 && succeededChunks > 0 && !verifyWarning) {
      if (jobId) {
        await setJobOperation(jobId, 'checking_indexed_text_is_readable', file.name, fileIndex + 1);
        await addJobLog(jobId, { level: 'info', message: `Verifying the indexed text is searchable…`, file: file.name });
      }
      const probe = await probeFileReadable(storeName, file.fileId, file.name);
      console.log(`🔎 [FileSearchStore] Readability probe: ${file.name} → ${probe.readable ? 'readable' : 'UNREADABLE'} (${probe.reason})`);
      if (!probe.readable) {
        if (jobId) {
          await addJobLog(jobId, { level: 'warn', message: `Indexed content not searchable (${probe.reason}); attempting auto-rescue with extracted text…`, file: file.name });
        }
        if (jobId) {
          await setJobOperation(jobId, 'running_ocr_fallback', file.name, fileIndex + 1);
        }
        const outcome = await rescueFileWithExtractedText({
          storeName,
          buffer,
          fileName: file.name,
          fileId: file.fileId,
          source: 'google_drive',
          chunking: options?.chunking,
          onLog: jobId ? (line) => { void addJobLog(jobId, { level: 'info', message: line, file: file.name }); } : undefined,
        });
        if (!outcome.rescued) {
          const message = 'Indexed, but the text is not searchable and could not be auto-rescued (no extractable text via text layer or OCR). Re-export the PDF (e.g. Print to PDF, or Adobe → Save As), then re-upload.';
          corpusFile.status = 'error';
          corpusFile.error = message;
          corpusFile.errorDetails = { reason: 'unreadable_after_index', probe: probe.reason };
          upsertCorpusFile(corpusFile);
          console.warn(`🚫 [FileSearchStore] Unreadable after index, rescue failed: ${file.name}`);
          if (jobId) {
            await setJobFileStatus(jobId, file.fileId, { status: 'error', error: message });
            await addJobLog(jobId, { level: 'error', message: `Unreadable after index and auto-rescue failed: ${file.name}`, file: file.name });
          }
          return { status: 'error', transientOnly: false };
        }

        // Confirm the rescue actually made the file searchable before claiming success.
        // Fail-closed: a probe error here must NOT mask a still-broken file as "Completed".
        const reprobe = await probeFileReadable(storeName, file.fileId, file.name, false);
        console.log(`🔎 [FileSearchStore] Post-rescue re-probe: ${file.name} → ${reprobe.readable ? 'readable' : 'UNREADABLE'} (${reprobe.reason})`);
        if (!reprobe.readable) {
          const message = 'Auto-rescue ran but the content is still not searchable. The PDF likely needs manual OCR or a clean re-export, then re-upload.';
          corpusFile.status = 'error';
          corpusFile.error = message;
          corpusFile.errorDetails = { reason: 'unreadable_after_rescue', probe: reprobe.reason };
          upsertCorpusFile(corpusFile);
          console.warn(`🚫 [FileSearchStore] Still unreadable after rescue: ${file.name}`);
          if (jobId) {
            await setJobFileStatus(jobId, file.fileId, { status: 'error', error: message });
            await addJobLog(jobId, { level: 'error', message: `Auto-rescue failed: content still not searchable after OCR/re-index — ${file.name} needs manual OCR or re-export.`, file: file.name });
          }
          return { status: 'error', transientOnly: false };
        }
        if (jobId) {
          await addJobLog(jobId, { level: 'info', message: `Re-probe after rescue: readable — ${file.name} is now searchable (via ${outcome.method}).`, file: file.name });
        }
      }
    }

    if (chunkFailures.length === 0) {
      corpusFile.status = 'indexed';
      corpusFile.geminiFileUri = lastChunkUri;
      corpusFile.indexedAt = new Date().toISOString();
      // A verify-timeout means "indexing is still finishing", not a failure — keep it
      // out of the error channel so the file/job read as completed, not failed. The
      // note stays visible in the job log below.
      corpusFile.error = undefined;
      corpusFile.errorDetails = undefined;
      upsertCorpusFile(corpusFile);

      console.log(`✅ [FileSearchStore] File fully processed: ${file.name}`);
      if (jobId) {
        await setJobFileStatus(jobId, file.fileId, { status: 'indexed', error: undefined });
        await addJobLog(jobId, {
          level: verifyWarning ? 'warn' : 'info',
          message: verifyWarning ? `Completed (indexing still finishing): ${file.name} — ${verifyWarning}` : `Completed: ${file.name}`,
          file: file.name,
        });
      }
      return { status: 'indexed', transientOnly: false };
    }

    const failedRanges = chunkFailures.map((f) => `${f.pageStart}-${f.pageEnd}`).join(', ');
    const warningMsg = `Partial ingestion: ${chunkFailures.length}/${chunks.length} chunk(s) failed. Failed pages: ${failedRanges}`;
    const transientOnly = chunkFailures.every((f) => f.class === 'TRANSIENT');
    const hasAnySuccess = succeededChunks > 0;

    if (allowPartialSuccess && hasAnySuccess) {
      corpusFile.status = 'indexed';
      corpusFile.geminiFileUri = lastChunkUri;
      corpusFile.indexedAt = new Date().toISOString();
      corpusFile.error = warningMsg;
      corpusFile.errorDetails = chunkFailures;
      upsertCorpusFile(corpusFile);

      console.warn(`⚠️ [FileSearchStore] ${warningMsg} (${file.name})`);
      if (jobId) {
        await setJobFileStatus(jobId, file.fileId, { status: 'indexed', error: warningMsg });
        await addJobLog(jobId, { level: 'warn', message: warningMsg, file: file.name });
      }
      return { status: 'indexed', transientOnly: false };
    }

    corpusFile.status = 'error';
    corpusFile.error = warningMsg;
    corpusFile.errorDetails = chunkFailures;
    upsertCorpusFile(corpusFile);

    console.warn(`⚠️ [FileSearchStore] ${warningMsg} (${file.name})`);
    if (jobId) {
      await setJobFileStatus(jobId, file.fileId, { status: 'error', error: warningMsg });
      await addJobLog(jobId, { level: 'warn', message: warningMsg, file: file.name });
    }
    return { status: 'error', transientOnly };
  } catch (error) {
    console.error(`❌ [FileSearchStore] Failed to process ${file.name}:`, error);

    corpusFile.status = 'error';
    corpusFile.error = error instanceof Error ? error.message : String(error);
    corpusFile.errorDetails = error;
    upsertCorpusFile(corpusFile);

    if (jobId) {
      await setJobFileStatus(jobId, file.fileId, { status: 'error', error: corpusFile.error });
      await addJobLog(jobId, {
        level: 'error',
        message: `Failed: ${file.name} - ${corpusFile.error}`,
        file: file.name,
      });
    }

    const cls = error instanceof ChunkImportError ? error.importClass : classifyImportError(error);
    const transientOnly = chunkFailures.length > 0
      ? chunkFailures.every((f) => f.class === 'TRANSIENT')
      : cls === 'TRANSIENT';
    return { status: 'error', transientOnly };
  } finally {
    if (cleanup) {
      try { await cleanup(); } catch { /* ignore */ }
    }
  }
}

// Auto-retry files that failed with transient-only errors, in bounded rounds with a
// backoff, so a Google blip self-heals without the manual /restart endpoint.
async function runJobRetryRounds(params: {
  storeName: string;
  entry: CorpusEntry;
  files: ProcessFileInput[];
  upsertCorpusFile: (f: CorpusFile) => void;
  transientFailedIds: Set<string>;
  jobId?: string;
  options?: IngestTuning;
  prepOp: string;
  buildResolver: (file: ProcessFileInput) => BufferResolver;
  importLimiter: Limiter;
  fileLimiter: Limiter;
  chunkProgress: { addTotal: (n: number) => void; increment: () => void };
  scheduleCheckpoint: () => Promise<void>;
}): Promise<void> {
  const { storeName, entry, files, upsertCorpusFile, transientFailedIds, jobId, options, prepOp, buildResolver, importLimiter, fileLimiter, chunkProgress, scheduleCheckpoint } = params;
  const filesById = new Map(files.map((f) => [f.fileId, f]));

  for (let round = 0; round < RETRY_CONFIG.jobRetryRounds; round++) {
    const retryIds = [...transientFailedIds].filter((id) => entry.files.find((f) => f.fileId === id)?.status === 'error');
    if (retryIds.length === 0) break;
    if (jobId && (await isJobCancelled(jobId))) break;

    console.log(`🔁 [FileSearchStore] Auto-retry round ${round + 1}: ${retryIds.length} transient-failed file(s)`);
    if (jobId) {
      await addJobLog(jobId, { level: 'info', message: `Auto-retry round ${round + 1}: ${retryIds.length} transient-failed file(s)` });
    }
    await delay(RETRY_CONFIG.jobRetryBackoffMs);

    // Retry files run through the SAME shared file + import limiters as the main pass.
    await Promise.all(retryIds.map((id, i) => fileLimiter.run(async () => {
      if (jobId && (await isJobCancelled(jobId))) return;
      const file = filesById.get(id);
      if (!file) return;

      const corpusFile: CorpusFile =
        entry.files.find((f) => f.fileId === id) ??
        { fileId: file.fileId, name: file.name, mimeType: file.mimeType, size: file.size, status: 'indexing' };
      corpusFile.status = 'indexing';
      corpusFile.error = undefined;
      corpusFile.errorDetails = undefined;
      upsertCorpusFile(corpusFile);
      if (jobId) {
        await setJobFileStatus(jobId, id, { status: 'indexing', error: undefined });
        await setJobOperation(jobId, prepOp, file.name, i + 1);
      }

      const result = await processOneFile({
        storeName, file, corpusFile, upsertCorpusFile, resolveBuffer: buildResolver(file), options, jobId, fileIndex: i, importLimiter, chunkProgress,
      });
      if (result.status === 'indexed' || !result.transientOnly) transientFailedIds.delete(id);

      await scheduleCheckpoint();
    })));
  }
}

// The shared file loop + finalization used by all three orchestrators.
async function runIngestionLoop(params: {
  storeName: string;
  entry: CorpusEntry;
  files: ProcessFileInput[];
  auth: OAuth2Client;
  jobId?: string;
  options?: IngestTuning;
  prepOp: string;
  finishLabel: string;
  buildResolver: (file: ProcessFileInput) => BufferResolver;
}): Promise<CorpusEntry> {
  const { storeName, entry, files, auth, jobId, options, prepOp, finishLabel, buildResolver } = params;

  const upsertCorpusFile = (nextFile: CorpusFile) => {
    const idx = entry.files.findIndex((f) => f.fileId === nextFile.fileId);
    if (idx >= 0) entry.files[idx] = { ...entry.files[idx], ...nextFile };
    else entry.files.push(nextFile);
  };

  const transientFailedIds = new Set<string>();
  let completedCount = 0;
  const totalFiles = files.length;
  console.log(`📁 [FileSearchStore] Processing ${totalFiles} files...`);

  // Shared across the WHOLE job: one rate limiter paces every :importFile under the Gemini
  // per-minute cap; a small file pool overlaps the non-import (download/split/verify) latency
  // of several files. Import throughput is governed by the rate limiter, not the pool size.
  const importLimiter = createRateLimiter({
    perMinute: RETRY_CONFIG.importRatePerMin,
    maxConcurrent: RETRY_CONFIG.importMaxConcurrent,
  });
  const fileLimiter = createLimiter(RETRY_CONFIG.fileConcurrency);

  // Job-wide aggregate chunk progress: with multiple files in flight, per-file progress is
  // meaningless — the bar reflects total sections across the job. Plain-number counters are
  // safe (mutated only between awaits in single-threaded JS).
  let jobProcessedChunks = 0;
  let jobTotalChunks = 0;
  let lastMilestone = 0;
  const jobStartedAt = Date.now();
  const chunkProgress = {
    addTotal: (n: number) => {
      jobTotalChunks += n;
      if (jobId) void setJobChunkProgress(jobId, jobProcessedChunks, jobTotalChunks);
    },
    increment: () => {
      jobProcessedChunks += 1;
      if (!jobId) return;
      void setJobChunkProgress(jobId, jobProcessedChunks, jobTotalChunks);
      if (jobProcessedChunks - lastMilestone >= 10 || jobProcessedChunks >= jobTotalChunks) {
        lastMilestone = jobProcessedChunks;
        const eta = etaString(jobStartedAt, jobProcessedChunks, jobTotalChunks);
        void addJobLog(jobId, {
          level: 'info',
          message: `Indexed ${jobProcessedChunks}/${jobTotalChunks} sections across ${totalFiles} files${eta ? ` — ~${eta} remaining` : ''}`,
        });
      }
    },
  };

  // Single-flight coalescing Drive checkpoint: at most one addOrUpdateCorpus in flight;
  // concurrent requests collapse into one trailing write that serializes the latest shared
  // `entry` (safe — upsertCorpusFile mutates entry.files synchronously).
  let checkpointInFlight: Promise<void> | null = null;
  let checkpointQueued = false;
  const scheduleCheckpoint = (): Promise<void> => {
    if (checkpointInFlight) { checkpointQueued = true; return checkpointInFlight; }
    checkpointInFlight = (async () => {
      try {
        entry.updatedAt = new Date().toISOString();
        await addOrUpdateCorpus(entry, auth);
      } catch (checkpointError) {
        console.warn(`⚠️ [Checkpoint] Failed to save progress:`, checkpointError);
      } finally {
        checkpointInFlight = null;
        if (checkpointQueued) { checkpointQueued = false; await scheduleCheckpoint(); }
      }
    })();
    return checkpointInFlight;
  };

  const markSkipped = async (file: ProcessFileInput, reason: string) => {
    upsertCorpusFile({ fileId: file.fileId, name: file.name, mimeType: file.mimeType, size: file.size, status: 'skipped', error: reason });
    if (jobId) await setJobFileStatus(jobId, file.fileId, { status: 'skipped', error: reason });
    completedCount++;
    if (jobId) await updateJob(jobId, { processedFiles: completedCount });
  };

  // Files run through a bounded pool; each file's chunk imports share the global rate limiter.
  await Promise.all(files.map((file, fileIndex) => fileLimiter.run(async () => {
    if (jobId) {
      if (await isJobCancelled(jobId)) { await markSkipped(file, 'Job cancelled by user'); return; }
      if (await isJobFileSkipped(jobId, file.fileId)) {
        console.log(`⏭️ [Job ${jobId}] Skipping file by user request: ${file.name}`);
        await markSkipped(file, 'Skipped by user');
        return;
      }
    }

    try {
      await ensureFreshToken(auth);
    } catch (tokenError) {
      console.error(`❌ [Auth] Token refresh failed before file ${file.name}:`, tokenError);
      const reason = 'Authentication expired. Please restart the job.';
      upsertCorpusFile({ fileId: file.fileId, name: file.name, mimeType: file.mimeType, size: file.size, status: 'error', error: reason });
      if (jobId) await setJobFileStatus(jobId, file.fileId, { status: 'error', error: reason });
      completedCount++;
      if (jobId) await updateJob(jobId, { processedFiles: completedCount });
      return;
    }

    console.log(`📄 [${fileIndex + 1}/${totalFiles}] Processing file: ${file.name} (${file.fileId})`);

    const corpusFile: CorpusFile = { fileId: file.fileId, name: file.name, mimeType: file.mimeType, size: file.size, status: 'indexing' };
    upsertCorpusFile(corpusFile);
    if (jobId) {
      await setJobFileStatus(jobId, file.fileId, { status: 'indexing', error: undefined });
      await setJobOperation(jobId, `importing (rate-limited, up to ${Math.min(RETRY_CONFIG.fileConcurrency, totalFiles)} files in parallel)`, file.name, fileIndex + 1);
      await addJobLog(jobId, { level: 'info', message: `Starting file ${fileIndex + 1}/${totalFiles}: ${file.name}`, file: file.name });
    }

    const result = await processOneFile({
      storeName, file, corpusFile, upsertCorpusFile, resolveBuffer: buildResolver(file), options, jobId, fileIndex, importLimiter, chunkProgress,
    });
    if (result.status === 'error' && result.transientOnly) transientFailedIds.add(file.fileId);
    else transientFailedIds.delete(file.fileId);

    completedCount++;
    if (jobId) await updateJob(jobId, { processedFiles: completedCount });
    await scheduleCheckpoint();
  })));

  await runJobRetryRounds({ storeName, entry, files, upsertCorpusFile, transientFailedIds, jobId, options, prepOp, buildResolver, importLimiter, fileLimiter, chunkProgress, scheduleCheckpoint });

  if (checkpointInFlight) await checkpointInFlight;
  entry.updatedAt = new Date().toISOString();
  await attachVerification(entry);
  await addOrUpdateCorpus(entry, auth);

  const fatalErrorCount = entry.files.filter((f) => f.status === 'error' || f.status === 'skipped').length;
  const warningCount = entry.files.filter((f) => f.status === 'indexed' && typeof f.error === 'string' && f.error.trim().length > 0).length;
  const totalIssues = fatalErrorCount + warningCount;

  const status =
    totalIssues === 0
      ? 'completed'
      : fatalErrorCount === totalFiles
        ? 'failed'
        : 'completed_with_errors';

  console.log(`🎉 [FileSearchStore] ${finishLabel}: ${entry.id} (Status: ${status})`);
  console.log(`   Completed: ${completedCount}/${totalFiles}`);
  console.log(`   Errors: ${totalIssues}/${totalFiles}`);

  if (jobId) {
    await setJobOperation(jobId, 'finalizing', undefined, totalFiles);
    await addJobLog(jobId, {
      level: totalIssues > 0 ? 'warn' : 'info',
      message: `Job finished: ${completedCount}/${totalFiles} files processed, ${totalIssues} errors`,
    });
    await updateJob(jobId, {
      status: status as 'completed' | 'failed' | 'completed_with_errors',
      corpusId: entry.id,
      currentOperation: undefined,
      currentFile: undefined,
      error: totalIssues > 0 ? `Completed with ${totalIssues} errors` : undefined,
      verification: entry.verification,
    });
  }

  return entry;
}

export async function createFileSearchStoreFromDrive(
  folderId: string,
  displayName: string,
  selectedFileIds: string[],
  files: Array<{ id: string; name: string; mimeType: string; size: number; pageRange?: PageRange }>,
  auth: OAuth2Client,
  jobId?: string,
  options?: IngestTuning
): Promise<CorpusEntry> {
  console.log(`🚀 [FileSearchStore] Creating store "${displayName}" from folder ${folderId} (Job: ${jobId || 'none'})`);

  if (jobId) {
    await markJobStarted(jobId);
    await setJobOperation(jobId, 'initializing', undefined, 0);
  }

  const folderMetadata = await getFolderMetadata(folderId, auth);

  const storeName = await getOrCreateFileSearchStore(folderId, displayName, options?.embeddingModel);

  const registry = await loadRegistry(auth);
  const existing = registry.corpora.find((c) => c.corpusId === storeName) || null;

  const entry: CorpusEntry = existing
    ? {
        ...existing,
        displayName: existing.displayName || displayName,
        source: {
          ...existing.source,
          folderId,
          folderName: folderMetadata.name,
          ownerEmail: folderMetadata.owners?.[0]?.emailAddress,
        },
        files: existing.files || [],
        updatedAt: new Date().toISOString(),
      }
    : {
        id: `filesearch-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        corpusId: storeName,
        displayName,
        source: {
          type: 'drive_folder',
          folderId,
          folderName: folderMetadata.name,
          ownerEmail: folderMetadata.owners?.[0]?.emailAddress,
        },
        files: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

  const selectedFiles = files.filter((f) => selectedFileIds.includes(f.id));
  const inputs: ProcessFileInput[] = selectedFiles.map((f) => ({
    fileId: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: f.size,
    pageRange: f.pageRange,
  }));

  return runIngestionLoop({
    storeName,
    entry,
    files: inputs,
    auth,
    jobId,
    options,
    prepOp: 'downloading',
    finishLabel: 'Store creation finished',
    buildResolver: makeDriveResolver(auth),
  });
}

export async function queryFileSearchStore(
  storeId: string,
  storeName: string | string[],
  messages: Array<{ role: string; text: string }>,
  systemInstruction?: string,
  model?: string,
  metadataFilter?: string,
  onLog?: (line: string) => void,
  generationOverride?: { temperature?: number; topP?: number; topK?: number; includeThoughts?: boolean; thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high'; maxOutputTokens?: number },
  signal?: AbortSignal,
  options?: { allowUngroundedFallback?: boolean; redactLogs?: boolean },
): Promise<{ response: string; isGrounded: boolean; groundingChunks: Array<{ text: string; uri?: string; title?: string }>; sources: DebugSourceChunk[]; supports: DebugAnswerSupport[]; reasoning?: string; metadata?: Record<string, unknown> }> {
  const storeNames = Array.isArray(storeName) ? storeName : [storeName];
  const storeLabel = storeNames.join(', ');

  const selectedModel = model && isValidModel(model) ? model : FILE_SEARCH_MODEL;
  // Take the output cap from the shared model file (models.json) so corpus steps
  // match every other generation path instead of relying on Gemini's own default.
  const modelInfo = getModelInfo(selectedModel);

  const qlog = (line: string) => {
    if (options?.redactLogs) return;
    console.log(line);
    onLog?.(line);
  };
  const qwarn = (line: string) => {
    if (options?.redactLogs) return;
    console.warn(line);
    onLog?.(line);
  };

  qlog(`🔍 [Query] Querying File Search Store(s): ${storeLabel}`);
  qlog(`📝 [Query] Messages: ${messages.length}`);
  qlog(`📚 [Query] System instruction: ${systemInstruction ? 'Yes' : 'No'}`);
  qlog(`🤖 [Query] Model: ${selectedModel}`);
  qlog(`🔎 [Query] Metadata filter: ${metadataFilter || 'none (search all documents)'}`);

  if (!messages || messages.length === 0) {
    throw new Error('No messages provided for query');
  }

  const contents = messages.map((msg) => ({
    role: msg.role === 'user' ? 'user' : 'model',
    parts: [{ text: msg.text }],
  }));

  const requestBody: Record<string, unknown> = {
    contents,
    tools: [
      {
        file_search: {
          file_search_store_names: storeNames,
          ...(metadataFilter ? { metadata_filter: metadataFilter } : {}),
        },
      },
    ],
    generationConfig: {
      temperature: generationOverride?.temperature ?? 0.1,
      topP: generationOverride?.topP ?? 0.95,
      topK: generationOverride?.topK ?? 20,
      ...(modelInfo?.maxOutputTokens ? { maxOutputTokens: modelInfo.maxOutputTokens } : {}),
      ...(generationOverride?.maxOutputTokens ? { maxOutputTokens: generationOverride.maxOutputTokens } : {}),
      thinkingConfig: {
        includeThoughts: generationOverride?.includeThoughts ?? false,
        // Bound thinking depth. Gemini 3.x heavy models (e.g. gemini-3.5-flash) will
        // otherwise run at their large default level, burn the whole output budget on
        // thoughts, and return no answer text — which then trips the ungrounded fallback.
        thinkingLevel: generationOverride?.thinkingLevel ?? 'low',
      },
    },
  };

  if (systemInstruction) {
    requestBody.systemInstruction = {
      parts: [{ text: systemInstruction }],
    };
  }

  try {
    const url = `${GEMINI_BASE_URL}/v1beta/models/${selectedModel}:generateContent?key=${GEMINI_API_KEY}`;

    qlog(`📡 [Query] Sending request to Gemini with File Search tool`);
    qlog(`🎯 [Query] Store(s): ${storeLabel}`);

    const { Agent } = await import('undici');
    // A genuine grounded query can legitimately run for minutes — keep the socket
    // timeouts generous (up to the Cloud Run request ceiling) so we never sever a
    // real query. The user's Stop / client-disconnect (via `signal`) is the control.
    const queryDispatcher = new Agent({
      connectTimeout: 30_000,
      headersTimeout: 60 * 60 * 1000,
      bodyTimeout: 60 * 60 * 1000,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      dispatcher: queryDispatcher,
      signal,
    } as RequestInit & { dispatcher: typeof queryDispatcher });

    if (!response.ok) {
      const errorText = await response.text();
      if (options?.redactLogs) throw new Error(`File Search query failed (HTTP ${response.status}).`);
      console.error(`❌ [Query] API Error (${response.status}):`, errorText);
      onLog?.(
        `❌ [Query] API Error (${response.status}): ${errorText.length > 4000 ? `${errorText.slice(0, 4000)}…` : errorText}`,
      );

      if (errorText.includes('No passages found') || errorText.includes('empty')) {
        throw new Error(
          `No relevant information found in the File Search Store. This usually means:\n` +
          `1. The store is still indexing files (wait a few minutes)\n` +
          `2. Your query doesn't match any content\n` +
          `3. Files failed to import\n\n` +
          `Store(s): ${storeLabel}`
        );
      }

      throw new Error(`File Search query failed (${response.status}): ${errorText}`);
    }

    const result = await response.json();

    const allParts: Array<{ text?: string; thought?: boolean }> = result.candidates?.[0]?.content?.parts ?? [];
    const text = allParts
      .filter((p) => p.thought !== true && typeof p.text === 'string' && p.text.length > 0)
      .map((p) => p.text!)
      .join('');
    const reasoningText = allParts
      .filter((p) => p.thought === true && typeof p.text === 'string' && p.text.length > 0)
      .map((p) => p.text!)
      .join('');
    const reasoning = reasoningText.trim().length > 0 ? reasoningText : undefined;

    if (text.length > 0) {
      qlog(`✅ [Query] Response generated (${text.length} chars, from ${allParts.length} part(s))`);
    } else {
      qwarn(`⚠️ [Query] Response generated (0 chars across ${allParts.length} part(s)) — file search returned no text`);
    }

    const groundingMetadata = result.candidates?.[0]?.groundingMetadata as
      | { groundingChunks?: Array<{ retrievedContext?: { text?: string; uri?: string; title?: string }; web?: { uri?: string; title?: string } }> }
      | undefined;

    const rawChunks = groundingMetadata?.groundingChunks ?? [];
    const isGrounded = rawChunks.length > 0;

    const groundingChunks = rawChunks
      .map((c) => ({
        text:  c.retrievedContext?.text ?? c.web?.title ?? '',
        uri:   c.retrievedContext?.uri  ?? c.web?.uri,
        title: c.retrievedContext?.title ?? c.web?.title,
      }))
      .filter((c) => c.text.trim().length > 0);

    qlog(`🔍 [Query] isGrounded=${isGrounded} (groundingChunks=${rawChunks.length}, withText=${groundingChunks.length})`);

    if (!isGrounded || text.length === 0) {
      const finishReason   = result.candidates?.[0]?.finishReason;
      const safetyRatings  = result.candidates?.[0]?.safetyRatings;
      const promptFeedback = result.promptFeedback;
      qwarn(`⚠️ [Query] Ungrounded/empty response — root-cause diagnostics:`);
      qwarn(`   store          : ${storeLabel}`);
      qwarn(`   model          : ${selectedModel}`);
      qwarn(`   finishReason   : ${finishReason ?? 'N/A'}`);
      qwarn(`   candidateCount : ${result.candidates?.length ?? 0}`);
      qwarn(`   promptFeedback : ${JSON.stringify(promptFeedback) ?? 'N/A'}`);
      qwarn(`   safetyRatings  : ${JSON.stringify(safetyRatings) ?? 'N/A'}`);
      qwarn(`   query (first 300 chars)         : "${messages[messages.length - 1]?.text?.substring(0, 300)}"`);
      qwarn(`   systemInstruction (first 200)   : "${(systemInstruction ?? '').substring(0, 200)}"`);
      qwarn(`   Possible causes: store still indexing | query doesn't match content | metadataFilter too restrictive | store empty`);
    }

    if (text.length === 0 && options?.allowUngroundedFallback !== false) {
      qwarn(`⚠️ [Query] Falling back to plain Gemini call (no file_search tool) to provide a basic answer`);
      try {
        const fallbackBody: Record<string, unknown> = {
          contents,
          generationConfig: {
            temperature: 0.2,
            topP: 0.95,
            ...(modelInfo?.maxOutputTokens ? { maxOutputTokens: modelInfo.maxOutputTokens } : {}),
            // Keep the fallback bounded too, so it can't get lost in thinking either.
            thinkingConfig: { includeThoughts: false, thinkingLevel: generationOverride?.thinkingLevel ?? 'low' },
          },
        };
        if (systemInstruction) {
          fallbackBody.systemInstruction = { parts: [{ text: systemInstruction }] };
        }

        const fallbackResponse = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fallbackBody),
          dispatcher: queryDispatcher,
          signal,
        } as RequestInit & { dispatcher: typeof queryDispatcher });

        if (fallbackResponse.ok) {
          const fallbackResult = await fallbackResponse.json();
          const fallbackParts: Array<{ text?: string }> = fallbackResult.candidates?.[0]?.content?.parts ?? [];
          const fallbackText = fallbackParts
            .filter((p) => typeof p.text === 'string' && p.text.length > 0)
            .map((p) => p.text!)
            .join('');

          if (fallbackText.length > 0) {
            qlog(`✅ [Query] Fallback response: ${fallbackText.length} chars (ungrounded — no corpus evidence)`);
            return {
              response: fallbackText,
              isGrounded: false,
              groundingChunks: [],
              sources: [],
              supports: [],
              reasoning,
              metadata: {
                storeId,
                storeName: storeLabel,
                storeNames,
                model: selectedModel,
                method: 'fallback_no_file_search',
                groundingMetadata: null,
                systemInstruction: systemInstruction || null,
                metadataFilter: metadataFilter || null,
              },
            };
          }
          qwarn(`⚠️ [Query] Fallback call also returned 0 chars`);
        } else {
          qwarn(`⚠️ [Query] Fallback call HTTP ${fallbackResponse.status}`);
        }
      } catch (fallbackErr) {
        console.warn(`⚠️ [Query] Fallback call failed:`, fallbackErr);
        onLog?.(
          `⚠️ [Query] Fallback call failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
        );
      }
    }

    const { sources, supports } = parseGroundingMetadata(groundingMetadata);

    return {
      response: text,
      isGrounded,
      groundingChunks,
      sources,
      supports,
      reasoning,
      metadata: {
        storeId,
        storeName: storeLabel,
        storeNames,
        model: selectedModel,
        method: 'file_search_tool',
        groundingMetadata,
        systemInstruction: systemInstruction || null,
        metadataFilter: metadataFilter || null,
      },
    };
  } catch (error) {
    if (options?.redactLogs) throw error;
    console.error(`❌ [Query] Error querying File Search Store:`, error);
    onLog?.(`❌ [Query] Error: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

export async function addFilesToExistingStore(
  existingCorpusId: string,
  selectedFileIds: string[],
  files: Array<{ id: string; name: string; mimeType: string; size: number; pageRange?: PageRange }>,
  auth: OAuth2Client,
  jobId?: string,
  options?: IngestTuning
): Promise<CorpusEntry> {
  console.log(`🔄 [FileSearchStore] Adding ${selectedFileIds.length} files to existing corpus: ${existingCorpusId} (Job: ${jobId || 'none'})`);

  if (jobId) {
    await markJobStarted(jobId);
    await setJobOperation(jobId, 'initializing', undefined, 0);
  }

  const registry = await loadRegistry(auth);
  const entry = registry.corpora.find((c) => c.id === existingCorpusId);
  
  if (!entry) {
    throw new Error(`Corpus not found: ${existingCorpusId}`);
  }

  const storeName = entry.corpusId;
  console.log(`📁 [FileSearchStore] Using existing store: ${storeName}`);

  const existingFileIds = new Set(entry.files.map(f => f.fileId));
  const newFileIds = selectedFileIds.filter(id => !existingFileIds.has(id));
  
  if (newFileIds.length === 0) {
    console.log(`⚠️ [FileSearchStore] All selected files already exist in corpus. Nothing to add.`);
    return entry;
  }

  console.log(`📄 [FileSearchStore] ${newFileIds.length} new files to add (${selectedFileIds.length - newFileIds.length} already exist)`);

  const selectedFiles = files.filter((f) => newFileIds.includes(f.id));
  const inputs: ProcessFileInput[] = selectedFiles.map((f) => ({
    fileId: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: f.size,
    pageRange: f.pageRange,
  }));

  return runIngestionLoop({
    storeName,
    entry,
    files: inputs,
    auth,
    jobId,
    options,
    prepOp: 'downloading',
    finishLabel: 'Files added to existing corpus',
    buildResolver: makeDriveResolver(auth),
  });
}

export interface LocalRagFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
  pageRange?: PageRange;
}

async function ingestLocalFilesIntoStore(
  storeName: string,
  entry: CorpusEntry,
  localFiles: LocalRagFile[],
  auth: OAuth2Client,
  jobId?: string,
  options?: IngestTuning
): Promise<CorpusEntry> {
  const inputs: ProcessFileInput[] = localFiles.map((f) => ({
    fileId: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: f.size,
    pageRange: f.pageRange,
  }));

  return runIngestionLoop({
    storeName,
    entry,
    files: inputs,
    auth,
    jobId,
    options,
    prepOp: 'preparing',
    finishLabel: 'Local ingestion finished',
    buildResolver: makeLocalResolver(localFiles),
  });
}

export async function createFileSearchStoreFromLocalFiles(
  displayName: string,
  files: LocalRagFile[],
  auth: OAuth2Client,
  jobId?: string,
  options?: IngestTuning
): Promise<CorpusEntry> {
  const folderId = `local-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  console.log(`🚀 [FileSearchStore] Creating store "${displayName}" from ${files.length} local files (Job: ${jobId || 'none'})`);

  if (jobId) {
    await markJobStarted(jobId);
    await setJobOperation(jobId, 'initializing', undefined, 0);
  }

  const storeName = await getOrCreateFileSearchStore(folderId, displayName, options?.embeddingModel);

  const entry: CorpusEntry = {
    id: `filesearch-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    corpusId: storeName,
    displayName,
    source: {
      type: 'drive_folder',
      folderId,
      folderName: displayName,
    },
    files: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return ingestLocalFilesIntoStore(storeName, entry, files, auth, jobId, options);
}

export async function addLocalFilesToExistingStore(
  existingCorpusId: string,
  files: LocalRagFile[],
  auth: OAuth2Client,
  jobId?: string,
  options?: IngestTuning
): Promise<CorpusEntry> {
  console.log(`🔄 [FileSearchStore] Adding ${files.length} local files to existing corpus: ${existingCorpusId} (Job: ${jobId || 'none'})`);

  if (jobId) {
    await markJobStarted(jobId);
    await setJobOperation(jobId, 'initializing', undefined, 0);
  }

  const registry = await loadRegistry(auth);
  const entry = registry.corpora.find((c) => c.id === existingCorpusId);

  if (!entry) {
    throw new Error(`Corpus not found: ${existingCorpusId}`);
  }

  const storeName = entry.corpusId;
  console.log(`📁 [FileSearchStore] Using existing store: ${storeName}`);

  return ingestLocalFilesIntoStore(storeName, entry, files, auth, jobId, options);
}

export async function listFileSearchStores(auth: OAuth2Client): Promise<CorpusEntry[]> {
  const registry = await loadRegistry(auth);
  return registry.corpora;
}

// A store as Gemini itself reports it, independent of any user's registry.
export interface GeminiStoreSummary {
  name: string;                 // Gemini resource name, e.g. fileSearchStores/folder-xyz
  displayName: string;
  activeDocumentsCount: number;
  createTime?: string;
}

// List EVERY File Search store in the Gemini project. The whole project shares one
// GEMINI_API_KEY and one flat store namespace, so this returns corpora created by ALL
// users — unlike listFileSearchStores(), which only reads the caller's own Drive
// registry. RESTRICTED USE: this deliberately bypasses the per-user ownership model,
// so only call it behind an explicit dev/admin gate (isDevUser).
export async function listAllFileSearchStores(): Promise<GeminiStoreSummary[]> {
  const stores: GeminiStoreSummary[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${GEMINI_BASE_URL}/v1beta/fileSearchStores`);
    url.searchParams.set('key', GEMINI_API_KEY);
    url.searchParams.set('pageSize', '20');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetchWithRetry(url.toString(), { method: 'GET' }, 'list-all-stores');
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Failed to list file search stores: ${res.status} ${txt.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      fileSearchStores?: Array<{ name?: string; displayName?: string; activeDocumentsCount?: string; createTime?: string }>;
      nextPageToken?: string;
    };
    for (const s of data.fileSearchStores ?? []) {
      if (!s.name) continue;
      stores.push({
        name: s.name,
        displayName: s.displayName?.trim() || s.name,
        activeDocumentsCount: Number(s.activeDocumentsCount ?? '0') || 0,
        createTime: s.createTime,
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return stores;
}

// ============================================================================
// RAG optimizer lifecycle helpers
// ============================================================================

// Delete a Gemini File Search store outright (the registry DELETE route only
// drops the registry entry, leaving the store — and its cost — behind). Used to
// clean up throwaway optimizer trial stores. 404 is treated as success.
export async function deleteFileSearchStore(storeName: string): Promise<void> {
  const url = `${GEMINI_BASE_URL}/v1beta/${storeName}?key=${GEMINI_API_KEY}&force=true`;
  const res = await fetchWithRetry(
    url,
    { method: 'DELETE' },
    `store-delete:${storeName}`,
    { noRetryStatuses: [404] }
  );
  if (!res.ok && res.status !== 404) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Failed to delete File Search store ${storeName}: ${res.status} ${txt.slice(0, 200)}`);
  }
  console.log(`🗑️ [FileSearchStore] Deleted store: ${storeName}`);
}

async function fetchStoreDocumentStates(storeName: string): Promise<DocumentState[]> {
  const states: DocumentState[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${GEMINI_BASE_URL}/v1beta/${storeName}/documents`);
    url.searchParams.set('key', GEMINI_API_KEY);
    url.searchParams.set('pageSize', '20'); // Gemini caps document page_size at 20
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetchWithRetry(url.toString(), { method: 'GET' }, `store-docs:${storeName}`);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Failed to list documents for ${storeName}: ${res.status} ${txt.slice(0, 200)}`);
    }
    const data = (await res.json()) as { documents?: Array<{ state?: string }>; nextPageToken?: string };
    for (const d of data.documents ?? []) states.push(normaliseDocumentState(d.state));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return states;
}

// One Gemini File Search document (chunk) with the metadata verification/self-heal
// need: the resource `name` (required to DELETE it) plus the metadata keys we filter on.
export interface StoreDocument {
  name: string;                 // Gemini resource name, e.g. fileSearchStores/x/documents/y
  state: DocumentState;
  pdfName: string | null;       // `pdf_name` custom metadata (null if absent)
  chunkName: string | null;     // `chunk_name` custom metadata
  fileId: string | null;        // `file_id` custom metadata (added 2026-07; null on legacy chunks)
}

// List every document in a store with its custom metadata. Unlike
// fetchStoreDocumentStates (states only) this returns the resource name + metadata
// so verification can compare pdf_name and self-heal can delete specific chunks.
export async function listStoreDocuments(storeName: string): Promise<StoreDocument[]> {
  const docs: StoreDocument[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${GEMINI_BASE_URL}/v1beta/${storeName}/documents`);
    url.searchParams.set('key', GEMINI_API_KEY);
    url.searchParams.set('pageSize', '20'); // Gemini caps document page_size at 20
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetchWithRetry(url.toString(), { method: 'GET' }, `store-docs:${storeName}`);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Failed to list documents for ${storeName}: ${res.status} ${txt.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      documents?: Array<{ name: string; state?: string; customMetadata?: Array<{ key: string; stringValue?: string; numericValue?: number }> }>;
      nextPageToken?: string;
    };
    for (const d of data.documents ?? []) {
      const str = (k: string) => d.customMetadata?.find((m) => m.key === k)?.stringValue ?? null;
      docs.push({
        name: d.name,
        state: normaliseDocumentState(d.state),
        pdfName: str('pdf_name'),
        chunkName: str('chunk_name'),
        fileId: str('file_id'),
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return docs;
}

// Link a store document to a registry file. `file_id` is the exact key when present;
// otherwise fall back to `chunk_name` (which always encodes the original filename as
// `${base}` or `${base}_p<start>-<end>.pdf`, see pdfSplitter) so we can still
// identify a file's chunks even when its `pdf_name` is missing/wrong. `pdf_name` is
// the last resort.
export function documentBelongsToFile(
  doc: StoreDocument,
  file: { fileId: string; name: string },
): boolean {
  if (doc.fileId && file.fileId) return doc.fileId === file.fileId;
  const base = file.name.replace(/\.pdf$/i, '');
  if (doc.chunkName) return doc.chunkName === file.name || doc.chunkName.startsWith(`${base}_p`);
  if (doc.pdfName) return doc.pdfName === file.name;
  return false;
}

// Delete a single document (chunk) from a File Search store. Gemini File Search
// metadata is immutable, so fixing a wrong pdf_name means deleting the chunk and
// re-importing it (see reimportFileWithMetadata). 404 is treated as success.
export async function deleteDocumentFromStore(documentName: string): Promise<void> {
  const url = `${GEMINI_BASE_URL}/v1beta/${documentName}?key=${GEMINI_API_KEY}&force=true`;
  const res = await fetchWithRetry(
    url,
    { method: 'DELETE' },
    `doc-delete:${documentName}`,
    { noRetryStatuses: [404] },
  );
  if (!res.ok && res.status !== 404) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Failed to delete document ${documentName}: ${res.status} ${txt.slice(0, 200)}`);
  }
}

export interface ReimportResult {
  fileId: string;
  name: string;
  chunksReimported: number;
  documentsDeleted: number;
}

// Self-heal / edit a file's metadata. Because Gemini metadata is immutable, this
// deletes the file's existing chunk-documents and re-imports the file (re-downloaded
// from Drive) with a correct `pdf_name` (+ `file_id`). Without `pdfNameOverride` the
// canonical name is the registry `CorpusFile.name`; with it, both the chunks' pdf_name
// AND the registry name are set to the override so selector, filter and verifier agree.
export async function reimportFileWithMetadata(
  corpusId: string,
  fileId: string,
  auth: OAuth2Client,
  pdfNameOverride?: string,
): Promise<ReimportResult> {
  const entry = await getCorpusById(corpusId, auth);
  if (!entry) throw new Error(`Corpus ${corpusId} not found`);
  const file = entry.files.find((f) => f.fileId === fileId);
  if (!file) throw new Error(`File ${fileId} not found in corpus ${corpusId}`);

  const storeName = entry.corpusId;
  const correctName =
    pdfNameOverride && pdfNameOverride.trim().length > 0 ? pdfNameOverride.trim() : file.name;

  // 1. Delete this file's existing chunk-documents.
  const docs = await listStoreDocuments(storeName);
  const belonging = docs.filter((d) => documentBelongsToFile(d, file));
  for (const d of belonging) {
    await deleteDocumentFromStore(d.name);
  }

  // 2. Re-download the source from Drive and re-import with corrected metadata.
  const tempPath = join(tmpdir(), `gemini-heal-${Date.now()}-${file.fileId}`);
  let chunksReimported = 0;
  try {
    const { stream: driveStream, mimeType: downloadedMimeType } = await downloadFileStream(
      file.fileId,
      auth,
      file.mimeType,
    );
    const writeStream = createWriteStream(tempPath);
    await pipeline(driveStream as NodeJS.ReadableStream, writeStream);
    const fileBuffer = await readFile(tempPath);

    const isPdf = downloadedMimeType === 'application/pdf';
    const uploadMimeType = isPdf ? 'text/plain' : (downloadedMimeType || 'application/octet-stream');

    const chunks = await splitPdfIfNecessary(
      fileBuffer, correctName, undefined, DEFAULT_PAGES_PER_CHUNK, undefined,
      isPdf ? DEFAULT_MAX_CHUNK_BYTES : undefined,
    );
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (i > 0) await delay(RETRY_CONFIG.delayBetweenChunksMs);
      if (isPdf) {
        await importPdfPageRange({
          storeName,
          fullBuffer: fileBuffer,
          fileName: correctName,
          fileId: file.fileId,
          source: 'google_drive',
          mimeType: file.mimeType,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          rangeBuffer: chunk.buffer,
          preferMime: chunk.rasterizedMime,
        });
      } else {
        await uploadAndImportChunk(
          storeName,
          chunk.buffer,
          chunk.name,
          buildChunkMetadata(correctName, chunk.name, chunk.pageStart, chunk.pageEnd, file.mimeType, 'google_drive', file.fileId),
          uploadMimeType,
        );
      }
      chunksReimported++;
    }
  } finally {
    try { await unlink(tempPath); } catch {}
  }

  // 3. Reconcile the registry so name/pdf_name agree, and clear stale errors.
  file.name = correctName;
  file.status = 'indexed';
  file.error = undefined;
  file.errorDetails = undefined;
  file.indexedAt = new Date().toISOString();
  entry.updatedAt = new Date().toISOString();
  await addOrUpdateCorpus(entry, auth);

  return { fileId, name: correctName, chunksReimported, documentsDeleted: belonging.length };
}

// Run metadata verification and stash the result on the corpus entry. Best-effort:
// a verification failure must never fail an otherwise-successful ingestion. Dynamic
// import breaks the fileSearchStore ↔ verifyCorpusMetadata cycle.
async function attachVerification(entry: CorpusEntry): Promise<void> {
  try {
    const { verifyCorpusMetadata } = await import('./verifyCorpusMetadata');
    entry.verification = await verifyCorpusMetadata(entry);
  } catch (e) {
    console.warn('[Verify] Post-ingestion verification failed:', e instanceof Error ? e.message : e);
  }
}

export interface StoreActiveResult {
  active: boolean;
  states: DocumentState[];
  failed: number;
  total: number;
}

// Poll a store until every document reaches ACTIVE (or timeout). The ingestion
// code marks CorpusFile.status='indexed' the moment a chunk is *imported*, but
// Gemini indexes asynchronously — querying before ACTIVE returns "No passages
// found". The optimizer must call this before scoring a freshly built store.
export async function pollStoreActive(
  storeName: string,
  opts?: { intervalMs?: number; timeoutMs?: number; minDocuments?: number; onLog?: (line: string) => void }
): Promise<StoreActiveResult> {
  const intervalMs = opts?.intervalMs ?? 5000;
  const timeoutMs = opts?.timeoutMs ?? 10 * 60 * 1000;
  const minDocuments = opts?.minDocuments ?? 1;
  const startedAt = Date.now();

  for (;;) {
    const states = await fetchStoreDocumentStates(storeName);
    const failed = states.filter((s) => s === 'FAILED').length;
    const activeCount = states.filter((s) => s === 'ACTIVE').length;
    const active = states.length >= minDocuments && states.every((s) => s === 'ACTIVE');
    opts?.onLog?.(
      `[pollStoreActive] ${storeName}: ${states.length} docs, ${activeCount} active, ${failed} failed`
    );
    if (active) return { active: true, states, failed, total: states.length };
    if (Date.now() - startedAt > timeoutMs) {
      return { active: false, states, failed, total: states.length };
    }
    await delay(intervalMs);
  }
}

export interface ParameterizedIngestFile {
  name: string;
  buffer: Buffer;
  mimeType: string;
  pageRange?: PageRange;
  metadata?: Array<{ key: string; stringValue?: string; numericValue?: number }>;
}

export interface ParameterizedStoreResult {
  storeName: string;
  folderId: string;
  chunkCount: number;
}

// Build a throwaway File Search store for one optimizer index config: unique
// folderId (avoids the folderId-only store-name collision), parameterized
// embedding model + chunking, no Drive/registry coupling. `fastMode` skips the
// 60s/20s ingestion rate-limit delays — safe for the tiny eval corpora used in
// optimization, not for bulk production ingestion. Caller must pollStoreActive
// before querying and deleteFileSearchStore when done.
export async function createParameterizedStore(args: {
  trialKey: string;
  displayName: string;
  files: ParameterizedIngestFile[];
  chunking?: ChunkingOptions;
  embeddingModel?: string;
  fastMode?: boolean;
  onLog?: (line: string) => void;
}): Promise<ParameterizedStoreResult> {
  const folderId = `opt-${args.trialKey}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const storeName = await getOrCreateFileSearchStore(folderId, args.displayName, args.embeddingModel);
  args.onLog?.(
    `[createParameterizedStore] store=${storeName} embedding=${args.embeddingModel ?? 'default'} ` +
      `chunking=${args.chunking ? `${args.chunking.maxTokensPerChunk}/${args.chunking.maxOverlapTokens}` : 'default'}`
  );

  const chunkDelay = args.fastMode ? 0 : RETRY_CONFIG.delayBetweenChunksMs;
  const fileDelay = args.fastMode ? 0 : RETRY_CONFIG.delayBetweenFilesMs;
  let chunkCount = 0;
  let firstFile = true;

  for (const file of args.files) {
    if (!firstFile && fileDelay > 0) await delay(fileDelay);
    firstFile = false;

    const uploadMimeType =
      file.mimeType === 'application/pdf' ? 'text/plain' : file.mimeType || 'application/octet-stream';
    const chunks = await splitPdfIfNecessary(file.buffer, file.name, file.pageRange, DEFAULT_PAGES_PER_CHUNK);

    let firstChunk = true;
    for (const chunk of chunks) {
      if (!firstChunk && chunkDelay > 0) await delay(chunkDelay);
      firstChunk = false;
      const { name: fileResourceName } = await uploadBufferToGemini(chunk.buffer, chunk.name, uploadMimeType);
      const metadata = buildChunkMetadata(
        file.name,
        chunk.name,
        chunk.pageStart,
        chunk.pageEnd,
        file.mimeType,
        'optimizer'
      );
      metadata.extra = file.metadata;
      await importFileToStore(storeName, fileResourceName, metadata, args.chunking);
      chunkCount++;
    }
  }

  return { storeName, folderId, chunkCount };
}

// Test-only surface: internal functions + the mutable retry config so unit tests
// can exercise the transient-retry / verify paths and shrink backoff delays.
export const __testing = {
  RETRY_CONFIG,
  uploadAndImportChunk,
  importPdfPageRange,
  verifyFileActive,
  rescueFileWithExtractedText,
  probeFileReadable,
  ocrPdfToText,
  waitForDocumentsActive,
  isRescueTextChunk,
  isBinaryPdfChunk,
  isAcceptableRescueText,
};
