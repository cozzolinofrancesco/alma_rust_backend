
export type ReviewerId =
  | 'document-quality'
  | 'grammar-mechanics'
  | 'clarity-readability'
  | 'consistency-style'
  | 'clinical'
  | 'medical-writer'
  | 'fda-drugs'
  | 'ema-drugs'
  | 'regulatory'
  | 'sme-biomaterial';

export type Verdict = 'PASS' | 'REVISE' | 'FAIL';

export type Severity = 'info' | 'warn' | 'block';

export interface ReviewComment {
  readonly id: string;
  readonly stepNumber: string;
  readonly severity: Severity;
  readonly text: string;
  acknowledged?: boolean;
}

export interface ReviewReport {
  readonly reviewerId: ReviewerId;
  readonly overall: Verdict;
  readonly comments: ReviewComment[];
}

export interface ReviewRun {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly docHash: string;
  readonly reports: ReviewReport[];
}
