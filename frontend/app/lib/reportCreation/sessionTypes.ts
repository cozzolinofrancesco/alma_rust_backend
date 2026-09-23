

export type ReportCreationStage =
  | 'session_name'
  | 'clinical_corpus_select'
  | 'clinical_corpus_running'
  | 'clinical_summary_running'
  | 'biomaterial_corpus_select'
  | 'biomaterial_corpus_running'
  | 'biomaterial_summary_running'
  | 'matching_ready'
  | 'matching_in_progress'
  | 'meta_confirm'
  | 'sec3_confirm'
  | 'sec1_confirm'
  | 'agent_generated'
  | 'needs_attention';

export type SessionStatus = 'active' | 'completed' | 'failed' | 'abandoned';

export interface DriveFileRef {
  id: string;
  name: string;
}

export interface DriveFileSelection extends DriveFileRef {
  mimeType: string;
  size?: number;
  pageRange?: { startPage: number; endPage: number };
}

export interface ClinicalPipelineState {
  selectedFiles: DriveFileSelection[];
  corpusMode: 'new' | 'existing';
  corpusName: string;
  corpusFolderId?: string;
  corpusJobId?: string;
  summaryJobId?: string;
  corpusId?: string;
  summaryJsonFile?: DriveFileRef;
}

export interface BiomaterialPipelineState {
  selectedFiles: DriveFileSelection[];
  corpusMode: 'new' | 'existing';
  corpusName: string;
  corpusFolderId?: string;
  corpusJobId?: string;
  summaryJobId?: string;
  corpusId?: string;
  summaryJsonFile?: DriveFileRef;
}

export interface MatchedStudyOverride {
  studyId: string;
  matchedTemplateId: string;
  selected: boolean;
  userInput: string;
}

export interface SectionStepOverride {
  stepId: string;
  selected: boolean;
  userInput: string;
}

export interface MetaFileOverride {
  fileId: string;
  metaStepId: string;
  selected: boolean;
  userInput: string;
}

export interface MatchingState {
  agentName: string;
  studyOverrides: MatchedStudyOverride[];
  sec3Overrides: SectionStepOverride[];
  sec1Overrides: SectionStepOverride[];
  metaFileOverrides: MetaFileOverride[];
}

export interface ReportCreationSessionManifest {
  sessionId: string;
  projectId: string;
  userEmail: string;
  sessionName: string;

  biomaterialSkipped?: boolean;

  status: SessionStatus;
  currentStage: ReportCreationStage;
  lastCompletedStage?: ReportCreationStage;

  manifestFileId?: string;
  manifestFolderId?: string;

  clinical: ClinicalPipelineState;
  biomaterial: BiomaterialPipelineState;
  matching?: MatchingState;

  resumeHints?: {
    showStep?: ReportCreationStage;
    needsUserAction?: string;
    errorMessage?: string;
  };

  createdAt: string;
  updatedAt: string;
}

export interface CreateSessionPayload {
  projectId: string;
  sessionName: string;
}

export interface UpdateSessionPayload {
  currentStage?: ReportCreationStage;
  lastCompletedStage?: ReportCreationStage;
  status?: SessionStatus;
  biomaterialSkipped?: boolean;
  clinical?: Partial<ClinicalPipelineState>;
  biomaterial?: Partial<BiomaterialPipelineState>;
  matching?: Partial<MatchingState>;
  resumeHints?: ReportCreationSessionManifest['resumeHints'];
}

export interface SessionListEntry {
  sessionId: string;
  sessionName: string;
  status: SessionStatus;
  currentStage: ReportCreationStage;
  updatedAt: string;
  createdAt: string;
}
