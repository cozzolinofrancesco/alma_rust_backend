// almaRustApi.ts
// -----------------------------------------------------------------------------
// Typed client for the alma_2 Rust (axum) backend. One function per endpoint,
// grouped by the backend's route categories. Each function takes the REAL
// request fields that endpoint reads (extracted from the Rust handlers), so
// call sites are self-documenting. Paths are literal (the Rust API has no global
// prefix).
//
// Base URL: ALMA_RUST_API_URL (server) or NEXT_PUBLIC_ALMA_RUST_API_URL (client).
// Defaults to http://localhost:8080.
// -----------------------------------------------------------------------------

const RUST_API_BASE = (
  process.env.ALMA_RUST_API_URL ??
  process.env.NEXT_PUBLIC_ALMA_RUST_API_URL ??
  'http://localhost:8080'
).replace(/\/$/, '');

type Obj = Record<string, unknown>;
type Primitive = string | number | boolean;
type Query = Record<string, Primitive | undefined | null>;

export interface CallOptions {
  /** Extra headers (e.g. Authorization / x-api-key / cookie). */
  headers?: Record<string, string>;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Extra query params merged onto the call. */
  query?: Query;
}

interface RequestSpec extends CallOptions {
  body?: unknown; // JSON-encoded, unless it's FormData (passed through).
}

const p = (v: string | number) => encodeURIComponent(String(v));

/** Core request helper: builds the query string, JSON-encodes the body, throws on non-2xx. */
export async function rustRequest<T = unknown>(
  method: string,
  path: string,
  spec: RequestSpec = {},
): Promise<T> {
  const url = new URL(RUST_API_BASE + path);
  if (spec.query) {
    for (const [k, v] of Object.entries(spec.query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const isForm = typeof FormData !== 'undefined' && spec.body instanceof FormData;
  const hasBody = spec.body !== undefined && spec.body !== null;

  const response = await fetch(url.toString(), {
    method,
    headers: {
      ...(hasBody && !isForm ? { 'content-type': 'application/json' } : {}),
      ...(spec.headers ?? {}),
    },
    body: !hasBody ? undefined : isForm ? (spec.body as FormData) : JSON.stringify(spec.body),
    signal: spec.signal,
  });

  const raw = await response.text();
  let data: unknown = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  }

  if (!response.ok) {
    const detail = typeof data === 'string' ? data : JSON.stringify(data);
    throw new Error(`Rust API ${method} ${path} -> ${response.status}: ${detail}`);
  }
  return data as T;
}

// =============================================================================
// projects — RESTful project resource
// =============================================================================
export const projects = {
  /** POST /api/projects — owner comes from auth. */
  create: (params: { project_name: string }, o?: CallOptions) =>
    rustRequest('POST', '/api/projects', { ...o, body: params }),
  /** GET /api/projects — scoped to the authorized principal. */
  list: (o?: CallOptions) => rustRequest('GET', '/api/projects', o),
  /** GET /api/projects/:project_identifier */
  load: (projectId: string, o?: CallOptions) =>
    rustRequest('GET', `/api/projects/${p(projectId)}`, o),
  /** POST /api/projects/:project_identifier/rename */
  rename: (projectId: string, params: { replacement_name: string }, o?: CallOptions) =>
    rustRequest('POST', `/api/projects/${p(projectId)}/rename`, { ...o, body: params }),
};

// =============================================================================
// projects_files — flat / legacy project & file operations
// =============================================================================
export const projectFiles = {
  /** POST /api/create-project */
  createProject: (
    params: { project_name: string; project_description?: string; collaborators?: string[] },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/create-project', { ...o, body: params }),
  /** GET /api/list-projects */
  listProjects: (o?: CallOptions) => rustRequest('GET', '/api/list-projects', o),
  /** GET /api/list-saved-projects */
  listSavedProjects: (o?: CallOptions) => rustRequest('GET', '/api/list-saved-projects', o),
  /** DELETE /api/list-saved-projects?identifier=…&cascade=… */
  deleteSavedProject: (query: { identifier: string; cascade?: boolean }, o?: CallOptions) =>
    rustRequest('DELETE', '/api/list-saved-projects', { ...o, query }),
  /** GET /api/load-project?identifier=… */
  loadProject: (query: { identifier: string }, o?: CallOptions) =>
    rustRequest('GET', '/api/load-project', { ...o, query }),
  /** POST /api/save-project — extra fields are persisted alongside name/identifier. */
  saveProject: (params: { name: string; identifier?: string } & Obj, o?: CallOptions) =>
    rustRequest('POST', '/api/save-project', { ...o, body: params }),
  /** POST /api/canvas/save-project */
  canvasSaveProject: (
    params: { project_name: string; nodes: Obj[]; edges?: Obj[] },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/canvas/save-project', { ...o, body: params }),
  /** GET /api/load-ai3d-project?identifier=… */
  loadAi3dProject: (query: { identifier: string }, o?: CallOptions) =>
    rustRequest('GET', '/api/load-ai3d-project', { ...o, query }),
  /** POST /api/create-subfolder */
  createSubfolder: (
    params: {
      parent_project_identifier: string;
      parent_folder_name: string;
      subfolder_name: string;
    },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/create-subfolder', { ...o, body: params }),
  /** POST /api/validate-folder */
  validateFolder: (
    params: { folder_name: string; parent_project_identifier?: string },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/validate-folder', { ...o, body: params }),
  /** GET /api/debug-shared-projects */
  debugSharedProjects: (o?: CallOptions) => rustRequest('GET', '/api/debug-shared-projects', o),
  /** POST /api/download-pdf */
  downloadPdf: (
    params: {
      source_document_identifier: string;
      pdf_source_url?: string;
      page_range?: { first_page: number; last_page: number } | [number, number];
    },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/download-pdf', { ...o, body: params }),
  /** GET /api/files-search?query=…&folderPath=…&offset=…&limit=… */
  filesSearchByQuery: (
    query: { query: string; folderPath?: string; offset?: number; limit?: number },
    o?: CallOptions,
  ) => rustRequest('GET', '/api/files-search', { ...o, query }),
  /** POST /api/files-search */
  filesSearchByBody: (
    params: { query: string; folderPath?: string; mimeType?: string; limit?: number },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/files-search', { ...o, body: params }),
  /** GET /api/projects/:project_identifier/files/:file_identifier */
  fetchProjectFile: (projectId: string, fileId: string, o?: CallOptions) =>
    rustRequest('GET', `/api/projects/${p(projectId)}/files/${p(fileId)}`, o),
  /** POST /api/projects/:project_identifier/files/:file_identifier */
  storeProjectFile: (
    projectId: string,
    fileId: string,
    params: { mime_type?: string; display_name?: string } | FormData,
    o?: CallOptions,
  ) => rustRequest('POST', `/api/projects/${p(projectId)}/files/${p(fileId)}`, { ...o, body: params }),
  /** GET /api/projects/:project_identifier/folders/:folder_name/files */
  listFolderFiles: (projectId: string, folderName: string, o?: CallOptions) =>
    rustRequest('GET', `/api/projects/${p(projectId)}/folders/${p(folderName)}/files`, o),
  /** POST /api/projects/:project_identifier/folders/:folder_name/files */
  createFolderFile: (
    projectId: string,
    folderName: string,
    params: { display_name: string; mime_type?: string; content?: Obj } | FormData,
    o?: CallOptions,
  ) =>
    rustRequest('POST', `/api/projects/${p(projectId)}/folders/${p(folderName)}/files`, {
      ...o,
      body: params,
    }),
  /** GET /api/projects/:project_identifier/folders/:folder_name/files/:file_identifier */
  fetchFolderFile: (projectId: string, folderName: string, fileId: string, o?: CallOptions) =>
    rustRequest(
      'GET',
      `/api/projects/${p(projectId)}/folders/${p(folderName)}/files/${p(fileId)}`,
      o,
    ),
  /** PUT /api/projects/:project_identifier/folders/:folder_name/files/:file_identifier */
  replaceFolderFile: (
    projectId: string,
    folderName: string,
    fileId: string,
    params: { content?: Obj; mime_type?: string } | FormData,
    o?: CallOptions,
  ) =>
    rustRequest(
      'PUT',
      `/api/projects/${p(projectId)}/folders/${p(folderName)}/files/${p(fileId)}`,
      { ...o, body: params },
    ),
  /** GET /api/projects/:project_identifier/folders/:folder_name/files/:file_identifier/download */
  downloadFolderFile: (projectId: string, folderName: string, fileId: string, o?: CallOptions) =>
    rustRequest(
      'GET',
      `/api/projects/${p(projectId)}/folders/${p(folderName)}/files/${p(fileId)}/download`,
      o,
    ),
  /** GET /api/projects/:project_identifier/folders/folder_id/:folder_identifier/contents */
  listFolderContents: (projectId: string, folderId: string, o?: CallOptions) =>
    rustRequest('GET', `/api/projects/${p(projectId)}/folders/folder_id/${p(folderId)}/contents`, o),
};

// =============================================================================
// auth
// =============================================================================
export const auth = {
  /** POST /api/auth/refresh-token */
  refreshToken: (
    params: { presented_refresh_token: string; refresh_token?: string },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/auth/refresh-token', { ...o, body: params }),
  /** GET /api/auth/session */
  session: (o?: CallOptions) => rustRequest('GET', '/api/auth/session', o),
  /** GET /api/allowed-emails */
  allowedEmails: (o?: CallOptions) => rustRequest('GET', '/api/allowed-emails', o),
  /** GET /api/debug-oauth-scopes */
  debugOauthScopes: (o?: CallOptions) => rustRequest('GET', '/api/debug-oauth-scopes', o),
  /** GET /api/rate-limit/check */
  rateLimitCheck: (o?: CallOptions) => rustRequest('GET', '/api/rate-limit/check', o),
  /** GET /api/auth/{action} (NextAuth catch-all: e.g. providers, csrf, session, signin/{provider}) */
  nextAuthGet: (action: string, query?: Query, o?: CallOptions) =>
    rustRequest('GET', `/api/auth/${action}`, { ...o, query }),
  /** POST /api/auth/{action} (NextAuth catch-all: e.g. signin/{provider}, signout, callback/{provider}) */
  nextAuthPost: (
    action: string,
    params: { email?: string; csrfToken?: string; callbackUrl?: string } & Obj,
    o?: CallOptions,
  ) => rustRequest('POST', `/api/auth/${action}`, { ...o, body: params }),
};

// =============================================================================
// ai
// =============================================================================
export const ai = {
  /** GET /api/ai — service descriptor. */
  describe: (o?: CallOptions) => rustRequest('GET', '/api/ai', o),
  /** POST /api/ai */
  complete: (
    params: { prompt: string; system_instruction?: string; maximum_output_tokens?: number },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/ai', { ...o, body: params }),
  /** POST /api/gemini */
  gemini: (params: { prompt: string; model?: string; temperature?: number }, o?: CallOptions) =>
    rustRequest('POST', '/api/gemini', { ...o, body: params }),
  /** POST /api/multimodalgemini — images are base64 / data-URL strings. */
  multimodalGemini: (
    params: { prompt: string; images?: string[]; model?: string },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/multimodalgemini', { ...o, body: params }),
  /** GET /api/image-analysis — service descriptor. */
  describeImageAnalysis: (o?: CallOptions) => rustRequest('GET', '/api/image-analysis', o),
  /** POST /api/image-analysis */
  analyzeImage: (
    params: {
      prompt?: string;
      caption?: string;
      image?: string;
      images?: string[];
      mime_type?: string;
    },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/image-analysis', { ...o, body: params }),
  /** GET /api/latex-to-json-ai — service descriptor. */
  describeLatexToJson: (o?: CallOptions) => rustRequest('GET', '/api/latex-to-json-ai', o),
  /** POST /api/latex-to-json-ai */
  latexToJson: (params: { latex: string }, o?: CallOptions) =>
    rustRequest('POST', '/api/latex-to-json-ai', { ...o, body: params }),
};

// =============================================================================
// ai_agents (all POST)
// =============================================================================
export const aiAgents = {
  /** POST /api/ai-agents/export */
  export: (
    params: { configuration?: Obj; fileName: string; folderName: string },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/ai-agents/export', { ...o, body: params }),
  /** POST /api/ai-agents/generate */
  generate: (
    params: { request: string; documentPaths?: string[]; defaultModel?: string },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/ai-agents/generate', { ...o, body: params }),
  /** POST /api/ai-agents/plan */
  plan: (params: { text: string; documentPaths?: string[] }, o?: CallOptions) =>
    rustRequest('POST', '/api/ai-agents/plan', { ...o, body: params }),
  /** POST /api/ai-agents/refine */
  refine: (
    params: { configuration: Obj; instruction: string; prompt?: string },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/ai-agents/refine', { ...o, body: params }),
  /** POST /api/ai-agents/report-creation */
  reportCreation: (
    params: { configuration?: Obj; name: string; layers: Obj[] },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/ai-agents/report-creation', { ...o, body: params }),
  /** POST /api/ai-agents/share */
  share: (
    params: {
      recipient_email: string;
      shared_configuration: Obj;
      display_name: string;
      note?: string;
    },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/ai-agents/share', { ...o, body: params }),
  /** POST /api/ai-agents/verify-bibliography (provide bibliography | entries | references) */
  verifyBibliography: (
    params: {
      bibliography?: Obj[];
      entries?: Obj[];
      references?: Obj[];
      path: string;
      name: string;
    },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/ai-agents/verify-bibliography', { ...o, body: params }),
};

// =============================================================================
// agentnodes — under /api/v1/agentnodes (the 272 / IB money path)
// =============================================================================
export const agentnodes = {
  /** GET /api/v1/agentnodes/capabilities */
  capabilities: (o?: CallOptions) => rustRequest('GET', '/api/v1/agentnodes/capabilities', o),
  /** POST /api/v1/agentnodes/steps/execute */
  executeStep: (
    params: {
      step: Obj;
      schemaVersion?: number;
      sources?: Obj[];
      skills?: Obj[];
      previousOutputs?: Obj;
      referenceNames?: Obj;
      corpora?: Obj[];
      projectId?: string;
      attemptId?: string;
    },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/v1/agentnodes/steps/execute', { ...o, body: params }),
  /** POST /api/v1/agentnodes/runs/plan */
  planRun: (
    params: { bundle: Obj; stepId?: string; previousOutputs?: Obj },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/v1/agentnodes/runs/plan', { ...o, body: params }),
  /** POST /api/v1/agentnodes/runs/advance */
  advanceRun: (
    params: { plan: Obj; checkpoint: Obj; attemptId?: string; retryFailed?: boolean },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/v1/agentnodes/runs/advance', { ...o, body: params }),
  /** POST /api/v1/agentnodes/272/compile */
  compile272: (
    params: {
      agentName: string;
      studies: Obj[];
      schemaVersion?: number;
      metaFiles?: Obj[];
      sec1Steps?: Obj[];
      sec3Steps?: Obj[];
      sect1MetaSteps?: Obj[];
      sources?: Obj[];
      skills?: Obj[];
      templates?: Obj;
      templatesYamlText?: string;
      templatesSheetId?: string;
      model?: string;
      corpusId?: string;
      corpusName?: string;
      metaCorpusId?: string;
      metaCorpusName?: string;
      projectId?: string;
      sharedMetaInstruction?: string;
      reportCreationDisplayName?: string;
      biomaterialSkipped?: boolean;
    },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/v1/agentnodes/272/compile', { ...o, body: params }),
  /** POST /api/v1/agentnodes/documents/assemble */
  assembleDocument: (
    params: {
      agent?: Obj;
      version?: string;
      outputs?: Obj;
      outputVersions?: Obj;
      edits?: Obj;
      title?: string;
      allowPartial?: boolean;
    },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/v1/agentnodes/documents/assemble', { ...o, body: params }),
  /** POST /api/v1/agentnodes/exports/:export_format (json | markdown | docx) */
  exportDocument: (
    exportFormat: string,
    params: { doc: Obj; fileName?: string },
    o?: CallOptions,
  ) => rustRequest('POST', `/api/v1/agentnodes/exports/${p(exportFormat)}`, { ...o, body: params }),
};

// =============================================================================
// ocr
// =============================================================================
export const ocr = {
  /** POST /api/ocr */
  create: (
    params: { document_reference: string; language_hints?: string[]; output_format?: string },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/ocr', { ...o, body: params }),
  /** POST /api/ocr-retry */
  retry: (params: { job_identifier: string }, o?: CallOptions) =>
    rustRequest('POST', '/api/ocr-retry', { ...o, body: params }),
  /** GET /api/ocr-stream — descriptor. */
  describeStream: (o?: CallOptions) => rustRequest('GET', '/api/ocr-stream', o),
  /** POST /api/ocr-stream */
  createStream: (
    params: { document_reference: string; chunk_size?: number; output_format?: string },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/ocr-stream', { ...o, body: params }),
  /** GET /api/preprocessing-stream — descriptor. */
  describePreprocessingStream: (o?: CallOptions) =>
    rustRequest('GET', '/api/preprocessing-stream', o),
  /** POST /api/preprocessing-stream */
  runPreprocessingStream: (
    params: {
      source_document_identifier: string;
      requested_stages: string[];
      target_dots_per_inch?: number;
    },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/preprocessing-stream', { ...o, body: params }),
  /** GET /api/cleanup-tmp — descriptor. */
  describeCleanupTmp: (o?: CallOptions) => rustRequest('GET', '/api/cleanup-tmp', o),
  /** POST /api/cleanup-tmp — no params. */
  runCleanupTmp: (o?: CallOptions) => rustRequest('POST', '/api/cleanup-tmp', { ...o, body: {} }),
};

// =============================================================================
// rag
// =============================================================================
export const rag = {
  /** GET /api/rag/corpora */
  listCorpora: (o?: CallOptions) => rustRequest('GET', '/api/rag/corpora', o),
  /** POST /api/rag/corpora */
  createCorpus: (
    params: { displayName: string; description?: string; knowledgeSources?: Obj[] },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/rag/corpora', { ...o, body: params }),
  /** POST /api/rag/corpora/summaries */
  summarizeCorpora: (
    params: { corpusIds?: string[]; corpusIdentifiers?: string[]; summaryLength?: number },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/rag/corpora/summaries', { ...o, body: params }),
  /** DELETE /api/rag/corpora/:corpus_identifier */
  deleteCorpus: (corpusId: string, o?: CallOptions) =>
    rustRequest('DELETE', `/api/rag/corpora/${p(corpusId)}`, o),
  /** PATCH /api/rag/corpora/:corpus_identifier */
  updateCorpus: (
    corpusId: string,
    params: {
      display_name?: string;
      description?: string;
      add_knowledge_sources?: string[];
      remove_knowledge_sources?: string[];
    },
    o?: CallOptions,
  ) => rustRequest('PATCH', `/api/rag/corpora/${p(corpusId)}`, { ...o, body: params }),
  /** GET /api/rag/jobs */
  listJobs: (o?: CallOptions) => rustRequest('GET', '/api/rag/jobs', o),
  /** POST /api/rag/jobs/start-file */
  startFileJob: (
    params: {
      corpusId: string;
      files: Array<{
        fileName: string;
        byteSize: number;
        inlineBytes: string;
        contentType?: string;
      }>;
    },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/rag/jobs/start-file', { ...o, body: params }),
  /** GET /api/rag/jobs/:job_identifier */
  fetchJob: (jobId: string, o?: CallOptions) => rustRequest('GET', `/api/rag/jobs/${p(jobId)}`, o),
  /** DELETE /api/rag/jobs/:job_identifier */
  deleteJob: (jobId: string, o?: CallOptions) =>
    rustRequest('DELETE', `/api/rag/jobs/${p(jobId)}`, o),
  /** PATCH /api/rag/jobs/:job_identifier */
  updateJob: (
    jobId: string,
    params: { status?: string; processed_file_count?: number; failure_reason?: string },
    o?: CallOptions,
  ) => rustRequest('PATCH', `/api/rag/jobs/${p(jobId)}`, { ...o, body: params }),
  /** GET /api/rag/jobs/:job_identifier/files */
  listJobFiles: (jobId: string, o?: CallOptions) =>
    rustRequest('GET', `/api/rag/jobs/${p(jobId)}/files`, o),
  /** POST /api/rag/jobs/:job_identifier/restart */
  restartJob: (jobId: string, o?: CallOptions) =>
    rustRequest('POST', `/api/rag/jobs/${p(jobId)}/restart`, { ...o, body: {} }),
  /** POST /api/rag/ingest */
  ingest: (
    params: {
      displayName: string;
      documents: Array<{ name: string; text: string; mimeType?: string }>;
      name?: string;
      files?: Obj[];
    },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/rag/ingest', { ...o, body: params }),
  /** POST /api/rag/query */
  query: (
    params: {
      question: string;
      messages?: Obj[];
      corpus_identifiers?: string[];
      corpus_identifier?: string;
      document_selections?: string[];
      metadata_filter?: string;
    },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/rag/query', { ...o, body: params }),
  /** POST /api/rag/qc */
  qc: (params: { corpusId: string; generatedText?: string }, o?: CallOptions) =>
    rustRequest('POST', '/api/rag/qc', { ...o, body: params }),
  /** GET /api/rag/drive/search?query=…&mimeType=…&limit=… */
  driveSearch: (
    query: { query: string; mimeType?: string; limit?: number },
    o?: CallOptions,
  ) => rustRequest('GET', '/api/rag/drive/search', { ...o, query }),
  /** GET /api/rag/drive/folder/:folder_identifier?cursor=…&pageSize=… */
  driveFolder: (
    folderId: string,
    query?: { cursor?: string; pageSize?: number },
    o?: CallOptions,
  ) => rustRequest('GET', `/api/rag/drive/folder/${p(folderId)}`, { ...o, query }),
  /** GET /api/rag/drive/download/:file_identifier?disposition=… */
  driveDownload: (fileId: string, query?: { disposition?: string }, o?: CallOptions) =>
    rustRequest('GET', `/api/rag/drive/download/${p(fileId)}`, { ...o, query }),
  /** GET /api/rag-knowledge/list?corpus=…&search=…&q=…&limit=… */
  knowledgeList: (
    query?: { corpus?: string; parent_corpus?: string; search?: string; q?: string; limit?: number },
    o?: CallOptions,
  ) => rustRequest('GET', '/api/rag-knowledge/list', { ...o, query }),
  /** POST /api/rag-knowledge/check-duplicate */
  knowledgeCheckDuplicate: (
    params: {
      title: string;
      fileName?: string;
      documentTitle?: string;
      content_hash?: string;
      contentHash?: string;
      corpus_id?: string;
      corpusId?: string;
      corpusIdentifier?: string;
    },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/rag-knowledge/check-duplicate', { ...o, body: params }),
};

// =============================================================================
// claim_validation
// =============================================================================
export const claimValidation = {
  /** POST /api/claim-validation/validate */
  validate: (
    params: {
      text: string;
      source: { sourceId: string; document: string };
      model?: string;
      maxClaims?: number;
    },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/claim-validation/validate', { ...o, body: params }),
  /** GET /api/claim-validation/qc-types */
  qcTypes: (o?: CallOptions) => rustRequest('GET', '/api/claim-validation/qc-types', o),
};

// =============================================================================
// templates_policy
// =============================================================================
export const templatesPolicy = {
  /** GET /api/templates/study-types */
  listStudyTypes: (o?: CallOptions) => rustRequest('GET', '/api/templates/study-types', o),
  /** POST /api/templates/study-types */
  createStudyType: (
    params: { study_type_name: string; section_outline: Obj[]; study_type_description?: string },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/templates/study-types', { ...o, body: params }),
  /** GET /api/templates/drafting-templates */
  listDraftingTemplates: (o?: CallOptions) =>
    rustRequest('GET', '/api/templates/drafting-templates', o),
  /** POST /api/templates/drafting-templates */
  createDraftingTemplate: (
    params: {
      template_name: string;
      template_body: string;
      description?: string;
      placeholder_tokens?: string[];
    },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/templates/drafting-templates', { ...o, body: params }),
  /** POST /api/generate-policy-question */
  generatePolicyQuestion: (
    params: { topic: string; difficulty?: string; count?: number; audience?: string },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/generate-policy-question', { ...o, body: params }),
  /** POST /api/assess-policy-answer */
  assessPolicyAnswer: (
    params: { question: string; answer: string; grading_rubric?: string; maximum_score?: number },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/assess-policy-answer', { ...o, body: params }),
  /** GET /api/corrections */
  listCorrections: (o?: CallOptions) => rustRequest('GET', '/api/corrections', o),
  /** POST /api/corrections */
  createCorrection: (
    params: { original_text: string; corrected_text: string; correction_note?: string },
    o?: CallOptions,
  ) => rustRequest('POST', '/api/corrections', { ...o, body: params }),
};

/** Everything under one namespace: `almaRust.rag.query({ question: '…' })`. */
export const almaRust = {
  request: rustRequest,
  baseUrl: RUST_API_BASE,
  projects,
  projectFiles,
  auth,
  ai,
  aiAgents,
  agentnodes,
  ocr,
  rag,
  claimValidation,
  templatesPolicy,
};

export default almaRust;
