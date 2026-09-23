'use client';

import React, { useState } from 'react';
import {
    analyzeClaimsEvidenceFromCorpora,
    analyzeReferenceNetworkFromCorpora,
} from '../lib/multiCorpusAnalysis';
import { AnalysisStep, NetworkGraphData, SequenceDiagramData } from '@/app/proof-validation-flow/types';

import CompletionStep from '@/app/proof-validation-flow/components/CompletionStep';
import NetworkGraphStep from '@/app/proof-validation-flow/components/NetworkGraphStep';
import SequenceDiagramStep from '@/app/proof-validation-flow/components/SequenceDiagramStep';
import WizardProgress from '@/app/proof-validation-flow/components/WizardProgress';
import CorpusMultiSelect from './CorpusMultiSelect';

interface CorpusWizardState {
    currentStep: AnalysisStep;
    selectedCorpusIds: string[];
    step1Complete: boolean;
    step2Complete: boolean;
    step1Data: SequenceDiagramData | null;
    step2Data: NetworkGraphData | null;
}

const Main: React.FC = () => {
    const [wizardState, setWizardState] = useState<CorpusWizardState>({
        currentStep: 'upload',
        selectedCorpusIds: [],
        step1Complete: false,
        step2Complete: false,
        step1Data: null,
        step2Data: null,
    });

    const [analysisInProgress, setAnalysisInProgress] = useState<{
        step: 'step1' | 'step2' | null;
        progress: number;
    }>({ step: null, progress: 0 });

    const toggleCorpus = (corpusId: string) => {
        setWizardState((prev) => {
            const selected = new Set(prev.selectedCorpusIds);
            if (selected.has(corpusId)) selected.delete(corpusId);
            else selected.add(corpusId);
            return { ...prev, selectedCorpusIds: Array.from(selected) };
        });
    };

    const handleRunAnalysis = async () => {
        if (wizardState.selectedCorpusIds.length === 0) return;

        try {
            setAnalysisInProgress({ step: 'step1', progress: 10 });
            setWizardState((prev) => ({
                ...prev,
                currentStep: 'step1',
                step1Complete: false,
                step2Complete: false,
                step1Data: null,
                step2Data: null,
            }));

            const progressInterval = setInterval(() => {
                setAnalysisInProgress((prev) => ({
                    ...prev,
                    progress: Math.min(prev.progress + 10, 90),
                }));
            }, 1000);

            const step1Data = await analyzeClaimsEvidenceFromCorpora(wizardState.selectedCorpusIds);
            clearInterval(progressInterval);

            setAnalysisInProgress((prev) => ({ ...prev, progress: 100 }));
            setWizardState((prev) => ({ ...prev, step1Complete: true, step1Data }));
            setAnalysisInProgress({ step: null, progress: 0 });
        } catch (error: unknown) {
            console.error('Corpus Step 1 analysis failed:', error);
            setAnalysisInProgress({ step: null, progress: 0 });
            setWizardState((prev) => ({ ...prev, currentStep: 'upload' }));
            alert(`Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    };

    const handleStep1Continue = async () => {
        if (!wizardState.step1Data) return;

        if (wizardState.step2Data && wizardState.step2Complete) {
            setWizardState((prev) => ({ ...prev, currentStep: 'step2' }));
            return;
        }

        try {
            setAnalysisInProgress({ step: 'step2', progress: 10 });
            setWizardState((prev) => ({ ...prev, currentStep: 'step2' }));

            const progressInterval = setInterval(() => {
                setAnalysisInProgress((prev) => ({
                    ...prev,
                    progress: Math.min(prev.progress + 15, 90),
                }));
            }, 1500);

            const step2Data = await analyzeReferenceNetworkFromCorpora(
                wizardState.selectedCorpusIds,
                wizardState.step1Data
            );
            clearInterval(progressInterval);

            setAnalysisInProgress((prev) => ({ ...prev, progress: 100 }));
            setWizardState((prev) => ({ ...prev, step2Complete: true, step2Data }));
            setAnalysisInProgress({ step: null, progress: 0 });
        } catch (error: unknown) {
            console.error('Step 2 analysis failed:', error);
            setAnalysisInProgress({ step: null, progress: 0 });
            alert(`Step 2 analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    };

    const handleComplete = () => {
        setWizardState((prev) => ({ ...prev, currentStep: 'complete' }));
    };

    const handleStepNavigation = (step: AnalysisStep) => {
        if (step === 'upload') {
            setWizardState((prev) => ({ ...prev, currentStep: step }));
        } else if (step === 'step1' && wizardState.step1Complete) {
            setWizardState((prev) => ({ ...prev, currentStep: step }));
        } else if (step === 'step2' && wizardState.step2Complete) {
            setWizardState((prev) => ({ ...prev, currentStep: step }));
        } else if (step === 'complete' && wizardState.step1Complete && wizardState.step2Complete) {
            setWizardState((prev) => ({ ...prev, currentStep: step }));
        }
    };

    const handleBackToSelect = () => {
        setWizardState((prev) => ({ ...prev, currentStep: 'upload' }));
    };

    const handleBackToStep1 = () => {
        setWizardState((prev) => ({ ...prev, currentStep: 'step1' }));
    };

    const handleRerunStep1 = async () => {
        if (wizardState.selectedCorpusIds.length === 0) return;

        try {
            setAnalysisInProgress({ step: 'step1', progress: 10 });
            const progressInterval = setInterval(() => {
                setAnalysisInProgress((prev) => ({
                    ...prev,
                    progress: Math.min(prev.progress + 10, 90),
                }));
            }, 1000);

            const step1Data = await analyzeClaimsEvidenceFromCorpora(wizardState.selectedCorpusIds);
            clearInterval(progressInterval);

            setAnalysisInProgress((prev) => ({ ...prev, progress: 100 }));
            setWizardState((prev) => ({ ...prev, step1Data, step1Complete: true }));
            setAnalysisInProgress({ step: null, progress: 0 });
        } catch (error: unknown) {
            console.error('Step 1 re-run failed:', error);
            setAnalysisInProgress({ step: null, progress: 0 });
            alert(`Step 1 re-run failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    };

    const handleRerunStep2 = async () => {
        if (!wizardState.step1Data || wizardState.selectedCorpusIds.length === 0) return;

        try {
            setAnalysisInProgress({ step: 'step2', progress: 10 });
            const progressInterval = setInterval(() => {
                setAnalysisInProgress((prev) => ({
                    ...prev,
                    progress: Math.min(prev.progress + 15, 90),
                }));
            }, 1500);

            const step2Data = await analyzeReferenceNetworkFromCorpora(
                wizardState.selectedCorpusIds,
                wizardState.step1Data
            );
            clearInterval(progressInterval);

            setAnalysisInProgress((prev) => ({ ...prev, progress: 100 }));
            setWizardState((prev) => ({ ...prev, step2Data, step2Complete: true }));
            setAnalysisInProgress({ step: null, progress: 0 });
        } catch (error: unknown) {
            console.error('Step 2 re-run failed:', error);
            setAnalysisInProgress({ step: null, progress: 0 });
            alert(`Step 2 re-run failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    };

    const handleReset = () => {
        setWizardState({
            currentStep: 'upload',
            selectedCorpusIds: [],
            step1Complete: false,
            step2Complete: false,
            step1Data: null,
            step2Data: null,
        });
        setAnalysisInProgress({ step: null, progress: 0 });
    };

    return (
        <div className="space-y-8">
            <WizardProgress
                currentStep={wizardState.currentStep}
                step1Complete={wizardState.step1Complete}
                step2Complete={wizardState.step2Complete}
                onStepClick={handleStepNavigation}
                firstStepTitle="Select Corpora"
                firstStepDescription="Pick knowledge bases"
                firstStepHint="Select one or more knowledge bases to begin the analysis process"
            />

            {analysisInProgress.step && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                    <div className="bg-white rounded-2xl p-8 max-w-md w-full mx-4 text-center">
                        <div className="mb-4">
                            {analysisInProgress.step === 'step1' ? (
                                <>
                                    <h3 className="text-xl font-bold text-[#11074A] mb-2">
                                        Analyzing Claims &amp; Evidence
                                    </h3>
                                    <p className="text-[#4A4453]">
                                        Gemini AI is extracting research claims and mapping evidence relationships across your knowledge bases...
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

            {wizardState.currentStep === 'upload' && (
                <CorpusMultiSelect
                    selectedCorpusIds={wizardState.selectedCorpusIds}
                    onToggle={toggleCorpus}
                    onRun={handleRunAnalysis}
                    disabled={analysisInProgress.step !== null}
                />
            )}

            {wizardState.currentStep === 'step1' && wizardState.step1Data && (
                <SequenceDiagramStep
                    data={wizardState.step1Data}
                    onContinue={handleStep1Continue}
                    onBack={handleBackToSelect}
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
                        pdfFile={null}
                        onReset={handleReset}
                    />
                )}
        </div>
    );
};

export default Main;
