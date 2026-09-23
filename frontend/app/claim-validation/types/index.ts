
import type { IntegrityRecord } from '../../lib/integrity';

export interface Document {
  document_id: string;
  filename: string;
  gemini_file_uri: string;
  mime_type: string;
  upload_timestamp: string;
  status: 'uploaded' | 'processing' | 'ready' | 'error';
}

export interface QcType {
  qc_type_id: string;
  label: string;
  description: string;
  extraction_prompt_template: string;
  validation_prompt_template: string;
  claim_types: string[];
  source_type: 'manual' | 'config';
  version: string;
}

export type ClaimType =
  | 'NUMERICAL'
  | 'STATISTICAL'
  | 'SAFETY'
  | 'EFFICACY'
  | 'PHARMACOKINETIC'
  | 'PHARMACODYNAMIC'
  | 'MECHANISTIC'
  | 'GENERAL'
  | string;

export type ClaimReviewStatus = 'pending' | 'edited' | 'deleted';

export interface Claim {
  claim_id: string;
  document_id: string;
  claim_text: string;
  claim_type: ClaimType;
  source_page: number | null;
  source_snippet: string;
  extraction_confidence: number;
  review_status: ClaimReviewStatus;
  selected: boolean;
  claim_summary?: string;
  claim_ref?: string | null;
}

export interface RawExtractedClaim {
  claim_text?: string;
  claim_type?: string;
  source_page?: number | null;
  source_snippet?: string;
  extraction_confidence?: number;
  CLAIM_ID?: string;
  CLAIM_TEXT?: string;
  CLAIM_TYPE?: string;
  CLAIM_SUMMARY?: string;
  SOURCE_PAGE?: number | null;
  CLAIM_REF?: string | null;
}

export interface PromptTemplate {
  template_id: string;
  template_text: string;
  version: string;
  source_type: 'manual' | 'config';
}

export type ValidationJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ValidationJob {
  job_id: string;
  claim_id: string;
  corpus_id: string;
  prompt_id: string;
  status: ValidationJobStatus;
  retry_count: number;
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
}

export type SessionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'partial';

export interface ValidationSession {
  session_id: string;
  owner_email?: string;
  claim_ids: string[];
  corpus_id: string;
  validation_prompt_template: string;
  status: SessionStatus;
  total: number;
  completed_count: number;
  failed_count: number;
  created_at: string;
  updated_at: string;
  jobs: ValidationJob[];
  results: ValidationResult[];
  document_filename?: string;
  corpus_scope_sha?: string;
  error_message?: string;
}

export interface RetrievedChunk {
  chunk_id: string;
  content: string;
  score?: number;
  source_ref: string;
  page?: number;
}

export interface RetrievalResult {
  retrieval_id: string;
  claim_id: string;
  corpus_id: string;
  retrieved_chunks: RetrievedChunk[];
  source_refs: string[];
  scores: number[];
}

export type Verdict =
  | 'supported'
  | 'partially_supported'
  | 'contradicted'
  | 'insufficient_evidence'
  | 'unclear';

export type SupportLevel = 'strong' | 'moderate' | 'weak' | 'none';

export interface ValidationResult {
  result_id: string;
  claim_id: string;
  claim_text: string;
  verdict: Verdict;
  support_level: SupportLevel;
  explanation: string;
  evidence_snippets: string[];
  evidence_sources: string[];
  contradiction_flag: boolean;
  insufficiency_flag: boolean;
  confidence: number;
  match_score: number | null;
  run_status: 'completed' | 'failed' | 'skipped';
  error_message?: string;
  prompt_used?: string;
  retrieval_result?: RetrievalResult;
  integrity_record?: IntegrityRecord;
  action?: string;
  rag_quote?: string;
  rag_location?: string | null;
}

export interface RawValidationOutput {
  STATUS?: string;
  SUPPORT_STRENGTH?: string;
  RATIONALE?: string;
  RAG_QUOTE?: string;
  RAG_LOCATION?: string | null;
  CONTRADICTION_PRESENT?: boolean;
  INSUFFICIENT_EVIDENCE?: boolean;
  ACTION?: string;
  MATCH_SCORE?: number;
}

export interface UploadResponse {
  fileUri: string;
  filename: string;
  mimeType: string;
  document_id: string;
}

export interface SplitConfig {
  enabled: boolean;
  pagesPerChunk: number;
  overlapPages: number;
}

export interface ExtractClaimsRequest {
  fileUri?: string;
  mimeType?: string;
  document_id: string;
  qcTypeId?: string;
  extractionPrompt: string;
  rawText?: string;
  splitConfig?: SplitConfig;
}

export interface ExtractClaimsResponse {
  claims: Claim[];
  raw_count: number;
  extraction_integrity_record?: IntegrityRecord;
}

export interface ValidateRequest {
  claims: Claim[];
  corpusId: string;
  validationPromptTemplate: string;
  sessionId?: string;
  selectedFileIds?: string[];
  documentFilename?: string;
  projectId?: string;
}

export interface ValidateResponse {
  sessionId: string;
}

export interface JobStatusResponse {
  sessionId: string;
  status: SessionStatus;
  total: number;
  completed_count: number;
  failed_count: number;
  results: ValidationResult[];
  errors: Array<{ claim_id: string; message: string }>;
  corpus_scope_sha?: string;
  error_message?: string;
}

export interface ExportRequest {
  results: ValidationResult[];
  format: 'csv' | 'json';
  extractionPrompt?: string;
  validationPrompt?: string;
  corpus_scope_sha?: string | null;
  extraction_integrity_record?: IntegrityRecord;
}

export type WizardStep = 'setup' | 'review' | 'results';

export interface WorkflowState {
  step: WizardStep;
  document: Document | null;
  selectedQcType: QcType | null;
  extractionPrompt: string;
  validationPrompt: string;
  selectedCorpusId: string;
  claims: Claim[];
  sessionId: string | null;
  sessionStatus: SessionStatus | null;
  results: ValidationResult[];
  completedCount: number;
  failedCount: number;
  totalCount: number;
  corpus_scope_sha: string | null;
  extraction_integrity_record?: IntegrityRecord;
  sessionError?: string | null;
}
