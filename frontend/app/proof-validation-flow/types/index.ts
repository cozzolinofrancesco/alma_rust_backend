export interface PDFUploadState {
    file: File | null;
    processing: boolean;
    error: string | null;
    uploadProgress: number;
}

export type AnalysisStep = 'upload' | 'step1' | 'step2' | 'complete';

export type AnalysisSource = 'pdf' | 'corpus';

export interface WizardState {
    currentStep: AnalysisStep;
    analysisSource: AnalysisSource;
    corpus: { id: string; displayName: string } | null;
    step1Complete: boolean;
    step2Complete: boolean;
    step1Data: SequenceDiagramData | null;
    step2Data: NetworkGraphData | null;
}

export interface Participant {
    id: string;
    name: string;
    type: 'claim' | 'evidence';
    pageReference?: string;
}

export interface SequenceNote {
    id: string;
    participant: string;
    text: string;
    type: 'claim' | 'evidence';
    confidence: number;
    pageReference?: string;
    qualityMarkers?: {
        detected: string[];
        inferred: string[];
        confidenceInterval: [number, number];
    };
}

export interface SequenceArrow {
    id: string;
    from: string;
    to: string;
    label: string;
    type: 'supports' | 'contradicts' | 'weak';
    strength: number;
    explanation?: string;
}

export interface SequenceDiagramData {
    participants: Participant[];
    notes: SequenceNote[];
    arrows: SequenceArrow[];
    title?: string;
    summary: {
        totalClaims: number;
        totalEvidence: number;
        strongLinks: number;
        weakLinks: number;
    };
}

export interface CrossRefMetadata {
    doi: string;
    title: string;
    authors: string[];
    journal: string;
    publishedDate: string;
    citationCount: number;
    isOpenAccess: boolean;
    publisher: string;
    issn?: string;
    volume?: string;
    issue?: string;
    pages?: string;
    url?: string;
    verificationStatus: 'verified' | 'not_found' | 'error' | 'pending';
    lastChecked: string;
}

export interface CrossRefSearchResult {
    doi: string;
    score: number;
    title: string;
    authors: string[];
    journal: string;
    publishedDate: string;
    citationCount: number;
    isOpenAccess: boolean;
}

export interface NetworkNode {
    id: string;
    label: string;
    type: 'evidence' | 'reference';
    size: number;
    color: string;
    pageReference?: string;
    credibilityScore?: number;
    crossRefData?: CrossRefMetadata;
    extractedTitle?: string;
    extractedAuthors?: string[];
    extractedYear?: string;
    extractedDOI?: string;
    extractedJournal?: string;
}

export interface NetworkLink {
    id: string;
    source: string;
    target: string;
    strength: number;
    type: 'cites' | 'supports' | 'contradicts';
    label?: string;
}

export interface NetworkGraphData {
    nodes: NetworkNode[];
    links: NetworkLink[];
    title?: string;
    summary: {
        totalEvidence: number;
        totalReferences: number;
        totalConnections: number;
        avgCredibility: number;
        strongestCluster: string;
        crossRefValidated?: number;
        totalCrossRefAttempts?: number;
    };
}

export interface AnalysisResult {
    step1: SequenceDiagramData;
    step2: NetworkGraphData;
    overallScore: number;
    recommendations: string[];
    processingTime: number;
} 