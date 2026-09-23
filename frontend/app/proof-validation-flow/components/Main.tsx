'use client';

import React, { useEffect, useState } from 'react';
import { analyzeClaimsEvidence, analyzeReferenceNetworkWithCrossRef, parseGeminiResponse } from '../lib/gemini';
import { analyzeClaimsEvidenceFromCorpus, analyzeReferenceNetworkFromCorpus } from '../lib/corpusAnalysis';
import { AnalysisStep, NetworkGraphData, PDFUploadState, SequenceDiagramData, WizardState } from '../types';

import CompletionStep from './CompletionStep';
import CorpusBuilder from './CorpusBuilder';
import NetworkGraphStep from './NetworkGraphStep';
import PDFUploader from './PDFUploader';
import SequenceDiagramStep from './SequenceDiagramStep';
import WizardProgress from './WizardProgress';

interface CacheData {
    pdfFileName: string;
    pdfSize: number;
    step1Data: SequenceDiagramData | null;
    step2Data: NetworkGraphData | null;
    timestamp: number;
}

const CACHE_KEY = 'proof-validation-cache';
const CACHE_EXPIRY_HOURS = 24;

const Main: React.FC = () => {
    const [pdfUploadState, setPdfUploadState] = useState<PDFUploadState>({
        file: null,
        processing: false,
        error: null,
        uploadProgress: 0
    });

    const [wizardState, setWizardState] = useState<WizardState>({
        currentStep: 'upload',
        analysisSource: 'pdf',
        corpus: null,
        step1Complete: false,
        step2Complete: false,
        step1Data: null,
        step2Data: null
    });

    const [uploadMode, setUploadMode] = useState<'analyze' | 'rag'>('analyze');

    const [analysisInProgress, setAnalysisInProgress] = useState<{
        step: 'step1' | 'step2' | null;
        progress: number;
    }>({
        step: null,
        progress: 0
    });

    const getCacheKey = (file: File) => `${CACHE_KEY}-${file.name}-${file.size}`;

    const saveToCache = (file: File, step1Data?: SequenceDiagramData | null, step2Data?: NetworkGraphData | null) => {
        try {
            const cacheData: CacheData = {
                pdfFileName: file.name,
                pdfSize: file.size,
                step1Data: step1Data || wizardState.step1Data,
                step2Data: step2Data || wizardState.step2Data,
                timestamp: Date.now()
            };
            localStorage.setItem(getCacheKey(file), JSON.stringify(cacheData));
        } catch (error: unknown) {
            console.warn("Failed to save to cache:", error);
        }
    };

    const loadFromCache = (file: File): CacheData | null => {
        try {
            const cached = localStorage.getItem(getCacheKey(file));
            if (!cached) return null;

            const cacheData: CacheData = JSON.parse(cached);

            const hoursOld = (Date.now() - cacheData.timestamp) / (1000 * 60 * 60);
            if (hoursOld > CACHE_EXPIRY_HOURS) {
                localStorage.removeItem(getCacheKey(file));
                return null;
            }

            if (cacheData.pdfFileName !== file.name || cacheData.pdfSize !== file.size) {
                return null;
            }

            return cacheData;
        } catch (error: unknown) {
            console.warn("Failed to load from cache:", error);
            return null;
        }
    };

    const clearCache = (file?: File) => {
        try {
            if (file) {
                localStorage.removeItem(getCacheKey(file));
            } else {
                Object.keys(localStorage).forEach(key => {
                    if (key.startsWith(CACHE_KEY)) {
                        localStorage.removeItem(key);
                    }
                });
            }
        } catch (error: unknown) {
            console.warn("Failed to clear cache:", error);
        }
    };

    useEffect(() => {
        if (pdfUploadState.file) {
            const cached = loadFromCache(pdfUploadState.file);
            if (cached) {
                setWizardState(prev => ({
                    ...prev,
                    step1Data: cached.step1Data,
                    step2Data: cached.step2Data,
                    step1Complete: !!cached.step1Data,
                    step2Complete: !!cached.step2Data
                }));
            }
        }
    }, [pdfUploadState.file]);

    const handleFileUpload = async (file: File) => {
        setPdfUploadState(prev => ({
            ...prev,
            file,
            processing: true,
            error: null,
            uploadProgress: 0
        }));

        const cached = loadFromCache(file);
        if (cached) {
            setWizardState(prev => ({
                ...prev,
                currentStep: cached.step2Data ? 'step2' : 'step1',
                step1Complete: !!cached.step1Data,
                step2Complete: !!cached.step2Data,
                step1Data: cached.step1Data,
                step2Data: cached.step2Data
            }));

            setPdfUploadState(prev => ({
                ...prev,
                processing: false,
                uploadProgress: 100
            }));

            return;
        }

        try {
            setAnalysisInProgress({ step: 'step1', progress: 10 });
            setWizardState(prev => ({ ...prev, currentStep: 'step1' }));

            const progressInterval = setInterval(() => {
                setAnalysisInProgress(prev => ({
                    ...prev,
                    progress: Math.min(prev.progress + 10, 90)
                }));
            }, 1000);

            const step1Response = await analyzeClaimsEvidence(file);
            clearInterval(progressInterval);

            setAnalysisInProgress(prev => ({ ...prev, progress: 100 }));

            const step1Data = parseGeminiResponse(step1Response) as SequenceDiagramData;

            setWizardState(prev => ({
                ...prev,
                step1Complete: true,
                step1Data
            }));

            saveToCache(file, step1Data, null);

            setPdfUploadState(prev => ({
                ...prev,
                processing: false,
                uploadProgress: 100
            }));

            setAnalysisInProgress({ step: null, progress: 0 });

        } catch (error: unknown) {
            console.error('Step 1 analysis failed:', error);
            setPdfUploadState(prev => ({
                ...prev,
                processing: false,
                error: error instanceof Error ? error.message : 'Analysis failed'
            }));
            setAnalysisInProgress({ step: null, progress: 0 });
        }
    };

    const handleCorpusReady = async (corpusId: string, displayName: string) => {
        try {
            setAnalysisInProgress({ step: 'step1', progress: 10 });
            setWizardState(prev => ({
                ...prev,
                analysisSource: 'corpus',
                corpus: { id: corpusId, displayName },
                currentStep: 'step1',
                step1Complete: false,
                step2Complete: false,
                step1Data: null,
                step2Data: null
            }));

            const progressInterval = setInterval(() => {
                setAnalysisInProgress(prev => ({
                    ...prev,
                    progress: Math.min(prev.progress + 10, 90)
                }));
            }, 1000);

            const step1Data = await analyzeClaimsEvidenceFromCorpus(corpusId);
            clearInterval(progressInterval);

            setAnalysisInProgress(prev => ({ ...prev, progress: 100 }));

            setWizardState(prev => ({
                ...prev,
                step1Complete: true,
                step1Data
            }));

            setAnalysisInProgress({ step: null, progress: 0 });
        } catch (error: unknown) {
            console.error('Corpus Step 1 analysis failed:', error);
            setAnalysisInProgress({ step: null, progress: 0 });
            setWizardState(prev => ({ ...prev, currentStep: 'upload' }));
            alert(`Corpus analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    };

    const handleStep1Continue = async () => {
        if (!wizardState.step1Data) return;
        const isCorpus = wizardState.analysisSource === 'corpus';
        if (!isCorpus && !pdfUploadState.file) return;
        if (isCorpus && !wizardState.corpus) return;

        if (wizardState.step2Data && wizardState.step2Complete) {
            setWizardState(prev => ({ ...prev, currentStep: 'step2' }));
            return;
        }

        try {
            setAnalysisInProgress({ step: 'step2', progress: 10 });
            setWizardState(prev => ({ ...prev, currentStep: 'step2' }));

            const progressInterval = setInterval(() => {
                setAnalysisInProgress(prev => ({
                    ...prev,
                    progress: Math.min(prev.progress + 15, 90)
                }));
            }, 1500);

            const step2Data = isCorpus
                ? await analyzeReferenceNetworkFromCorpus(wizardState.corpus!.id, wizardState.step1Data)
                : await analyzeReferenceNetworkWithCrossRef(pdfUploadState.file!, wizardState.step1Data);
            clearInterval(progressInterval);

            setAnalysisInProgress(prev => ({ ...prev, progress: 100 }));

            setWizardState(prev => ({
                ...prev,
                step2Complete: true,
                step2Data
            }));

            if (!isCorpus && pdfUploadState.file) {
                saveToCache(pdfUploadState.file, wizardState.step1Data, step2Data);
            }

            setAnalysisInProgress({ step: null, progress: 0 });

        } catch (error: unknown) {
            console.error('Step 2 analysis failed:', error);
            setAnalysisInProgress({ step: null, progress: 0 });
            alert(`Step 2 analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    };

    const handleComplete = () => {
        setWizardState(prev => ({ ...prev, currentStep: 'complete' }));
    };

    const handleStepNavigation = (step: AnalysisStep) => {
        if (step === 'upload') {
            setWizardState(prev => ({ ...prev, currentStep: step }));
        } else if (step === 'step1' && wizardState.step1Complete) {
            setWizardState(prev => ({ ...prev, currentStep: step }));
        } else if (step === 'step2' && wizardState.step2Complete) {
            setWizardState(prev => ({ ...prev, currentStep: step }));
        } else if (step === 'complete' && wizardState.step1Complete && wizardState.step2Complete) {
            setWizardState(prev => ({ ...prev, currentStep: step }));
        }
    };

    const handleBackToUpload = () => {
        setWizardState(prev => ({
            ...prev,
            currentStep: 'upload',
            analysisSource: 'pdf',
            corpus: null
        }));
    };

    const handleBackToStep1 = () => {
        setWizardState(prev => ({ ...prev, currentStep: 'step1' }));
    };

    const handleRerunStep1 = async () => {
        const isCorpus = wizardState.analysisSource === 'corpus';
        if (!isCorpus && !pdfUploadState.file) return;
        if (isCorpus && !wizardState.corpus) return;

        try {
            setAnalysisInProgress({ step: 'step1', progress: 10 });

            const progressInterval = setInterval(() => {
                setAnalysisInProgress(prev => ({
                    ...prev,
                    progress: Math.min(prev.progress + 10, 90)
                }));
            }, 1000);

            const step1Data = isCorpus
                ? await analyzeClaimsEvidenceFromCorpus(wizardState.corpus!.id)
                : parseGeminiResponse(await analyzeClaimsEvidence(pdfUploadState.file!)) as SequenceDiagramData;
            clearInterval(progressInterval);

            setAnalysisInProgress(prev => ({ ...prev, progress: 100 }));

            setWizardState(prev => ({
                ...prev,
                step1Data,
                step1Complete: true,
            }));

            if (!isCorpus && pdfUploadState.file) {
                saveToCache(pdfUploadState.file, step1Data, wizardState.step2Data);
            }

            setAnalysisInProgress({ step: null, progress: 0 });

        } catch (error: unknown) {
            console.error('Step 1 re-run failed:', error);
            setAnalysisInProgress({ step: null, progress: 0 });
            alert(`Step 1 re-run failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    };

    const handleRerunStep2 = async () => {
        if (!wizardState.step1Data) return;
        const isCorpus = wizardState.analysisSource === 'corpus';
        if (!isCorpus && !pdfUploadState.file) return;
        if (isCorpus && !wizardState.corpus) return;

        try {
            setAnalysisInProgress({ step: 'step2', progress: 10 });

            const progressInterval = setInterval(() => {
                setAnalysisInProgress(prev => ({
                    ...prev,
                    progress: Math.min(prev.progress + 15, 90)
                }));
            }, 1500);

            const step2Data = isCorpus
                ? await analyzeReferenceNetworkFromCorpus(wizardState.corpus!.id, wizardState.step1Data)
                : await analyzeReferenceNetworkWithCrossRef(pdfUploadState.file!, wizardState.step1Data);
            clearInterval(progressInterval);

            setAnalysisInProgress(prev => ({ ...prev, progress: 100 }));

            setWizardState(prev => ({
                ...prev,
                step2Data,
                step2Complete: true
            }));

            if (!isCorpus && pdfUploadState.file) {
                saveToCache(pdfUploadState.file, wizardState.step1Data, step2Data);
            }

            setAnalysisInProgress({ step: null, progress: 0 });

        } catch (error: unknown) {
            console.error('Step 2 re-run failed:', error);
            setAnalysisInProgress({ step: null, progress: 0 });
            alert(`Step 2 re-run failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    };

    const handleReset = () => {
        if (pdfUploadState.file) {
            clearCache(pdfUploadState.file);
        }

        setPdfUploadState({
            file: null,
            processing: false,
            error: null,
            uploadProgress: 0
        });
        setWizardState({
            currentStep: 'upload',
            analysisSource: 'pdf',
            corpus: null,
            step1Complete: false,
            step2Complete: false,
            step1Data: null,
            step2Data: null
        });
        setAnalysisInProgress({ step: null, progress: 0 });
    };

    return (
        <div className="space-y-8">
            {}
            <WizardProgress
                currentStep={wizardState.currentStep}
                step1Complete={wizardState.step1Complete}
                step2Complete={wizardState.step2Complete}
                onStepClick={handleStepNavigation}
            />

            {}
            {analysisInProgress.step && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                    <div className="bg-white rounded-2xl p-8 max-w-md w-full mx-4 text-center">
                        <div className="mb-4">
                            {analysisInProgress.step === 'step1' ? (
                                <>
                                    <h3 className="text-xl font-bold text-[#11074A] mb-2">
                                        Analyzing Claims & Evidence
                                    </h3>
                                    <p className="text-[#4A4453]">
                                        Gemini AI is extracting research claims and mapping evidence relationships...
                                    </p>
                                </>
                            ) : (
                                <>
                                    <h3 className="text-xl font-bold text-[#11074A] mb-2">
                                        Building Reference Network
                                    </h3>
                                    <p className="text-[#4A4453]">
                                        Analyzing citations and validating references with CrossRef database...
                                    </p>
                                    <p className="text-xs text-[#4A4453] mt-2">
                                        This may take longer as we verify each reference with real citation data.
                                    </p>
                                </>
                            )}
                        </div>

                        <div className="w-full bg-gray-200 rounded-full h-3 mb-4">
                            <div
                                className="bg-[#11074A] h-3 rounded-full transition-all duration-1000"
                                style={{ width: `${analysisInProgress.progress}%` }}
                            ></div>
                        </div>

                        <p className="text-sm text-[#4A4453]">
                            {analysisInProgress.progress}% Complete
                        </p>
                    </div>
                </div>
            )}

            {}
            {wizardState.currentStep === 'upload' && (
                <div className="space-y-6">
                    <div className="flex justify-center gap-2">
                        {(['analyze', 'rag'] as const).map((m) => (
                            <button
                                key={m}
                                type="button"
                                onClick={() => setUploadMode(m)}
                                className={`px-5 py-2 rounded-lg font-medium transition-colors ${
                                    uploadMode === m
                                        ? 'bg-[#11074A] text-white'
                                        : 'bg-[#AFA8BA]/20 text-[#4A4453] hover:bg-[#AFA8BA]/30'
                                }`}
                            >
                                {m === 'analyze' ? 'Analyze Paper' : 'Add to Knowledge Base'}
                            </button>
                        ))}
                    </div>

                    {uploadMode === 'analyze' ? (
                        <PDFUploader
                            onFileUpload={handleFileUpload}
                            uploadState={pdfUploadState}
                            disabled={analysisInProgress.step !== null}
                        />
                    ) : (
                        <CorpusBuilder onCorpusReady={handleCorpusReady} />
                    )}
                </div>
            )}

            {wizardState.currentStep === 'step1' && wizardState.step1Data && (
                <SequenceDiagramStep
                    data={wizardState.step1Data}
                    onContinue={handleStep1Continue}
                    onBack={handleBackToUpload}
                    onRerun={handleRerunStep1}
                    isRerunning={analysisInProgress.step === 'step1'}
                />
            )}

            {wizardState.currentStep === 'step2' && wizardState.step2Data && (
                <NetworkGraphStep
                    data={wizardState.step2Data}
                    onComplete={handleComplete}
                    onBack={handleBackToStep1}
                    onRerun={handleRerunStep2}
                    isRerunning={analysisInProgress.step === 'step2'}
                />
            )}

            {wizardState.currentStep === 'complete' &&
                wizardState.step1Data &&
                wizardState.step2Data && (
                    <CompletionStep
                        step1Data={wizardState.step1Data}
                        step2Data={wizardState.step2Data}
                        pdfFile={pdfUploadState.file}
                        onReset={handleReset}
                    />
                )}


        </div>
    );
};

export default Main; 