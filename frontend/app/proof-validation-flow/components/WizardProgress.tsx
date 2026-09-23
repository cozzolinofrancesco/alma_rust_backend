'use client';

import React from 'react';
import { AnalysisStep } from '../types';

interface WizardProgressProps {
    currentStep: AnalysisStep;
    onStepClick?: (step: AnalysisStep) => void;
    step1Complete: boolean;
    step2Complete: boolean;
    title?: string;
    firstStepTitle?: string;
    firstStepDescription?: string;
    firstStepHint?: string;
}

const WizardProgress: React.FC<WizardProgressProps> = ({
    currentStep,
    onStepClick,
    step1Complete,
    step2Complete,
    title = 'Analysis Progress',
    firstStepTitle = 'Upload PDF',
    firstStepDescription = 'Upload research paper',
    firstStepHint = 'Upload your research paper to begin the analysis process'
}) => {
    const steps = [
        {
            id: 'upload' as AnalysisStep,
            title: firstStepTitle,
            icon: '1',
            description: firstStepDescription
        },
        {
            id: 'step1' as AnalysisStep,
            title: 'Claims-Evidence',
            icon: '2',
            description: 'Sequence analysis'
        },
        {
            id: 'step2' as AnalysisStep,
            title: 'Reference Network',
            icon: '3',
            description: 'Citation mapping'
        },
        {
            id: 'complete' as AnalysisStep,
            title: 'Complete',
            icon: '4',
            description: 'Final report'
        }
    ];

    const getStepStatus = (stepId: AnalysisStep) => {
        if (stepId === currentStep) return 'current';
        if (stepId === 'upload') return 'completed';
        if (stepId === 'step1' && step1Complete) return 'completed';
        if (stepId === 'step2' && step2Complete) return 'completed';
        if (stepId === 'complete' && currentStep === 'complete') return 'completed';
        return 'upcoming';
    };

    const isStepClickable = (stepId: AnalysisStep, status: string) => {
        return onStepClick && (status === 'completed' || status === 'current');
    };

    return (
        <div className="w-full max-w-4xl mx-auto mb-8">
            <div className="bg-white rounded-2xl shadow-lg border-2 border-gray-100 p-6">
                <h2 className="text-xl font-bold text-[#11074A] mb-6 text-center">
                    {title}
                </h2>

                <div className="flex items-center justify-between">
                    {steps.map((step, index) => {
                        const status = getStepStatus(step.id);
                        const isClickable = isStepClickable(step.id, status);

                        return (
                            <React.Fragment key={step.id}>
                                {}
                                <div className="flex flex-col items-center flex-1">
                                    <button
                                        onClick={() => isClickable && onStepClick?.(step.id)}
                                        disabled={!isClickable}
                                        className={`
                      w-16 h-16 md:w-20 md:h-20 rounded-full flex items-center justify-center text-2xl md:text-3xl font-bold transition-all duration-300 mb-3
                      ${status === 'current'
                                                ? 'bg-[#11074A] text-white shadow-lg transform scale-110'
                                                : status === 'completed'
                                                    ? 'bg-green-500 text-white shadow-md hover:shadow-lg'
                                                    : 'bg-[#AFA8BA]/20 text-[#4A4453]'
                                            }
                      ${isClickable ? 'cursor-pointer hover:shadow-lg' : 'cursor-default'}
                    `}
                                    >
                                        {status === 'completed' && step.id !== currentStep ? '✓' : step.icon}
                                    </button>

                                    <div className="text-center">
                                        <h3 className={`
                      font-semibold text-sm md:text-base mb-1
                      ${status === 'current' ? 'text-[#11074A]' : 'text-[#4A4453]'}
                    `}>
                                            {step.title}
                                        </h3>
                                        <p className="text-xs md:text-sm text-[#4A4453]/70 hidden md:block">
                                            {step.description}
                                        </p>
                                    </div>
                                </div>

                                {}
                                {index < steps.length - 1 && (
                                    <div className="flex-shrink-0 w-8 md:w-16 h-0.5 mx-2 md:mx-4 mb-12">
                                        <div className={`
                      w-full h-full transition-all duration-300
                      ${getStepStatus(steps[index + 1].id) === 'completed' ||
                                                (index === 0 && currentStep !== 'upload')
                                                ? 'bg-green-500'
                                                : getStepStatus(steps[index + 1].id) === 'current'
                                                    ? 'bg-[#11074A]'
                                                    : 'bg-[#AFA8BA]/30'
                                            }
                    `} />
                                    </div>
                                )}
                            </React.Fragment>
                        );
                    })}
                </div>

                {}
                <div className="mt-6 p-4 bg-[#AFA8BA]/10 rounded-lg">
                    <div className="flex items-center justify-center">
                        <div className="text-center">
                            {currentStep === 'upload' && (
                                <p className="text-[#4A4453]">
                                    {firstStepHint}
                                </p>
                            )}
                            {currentStep === 'step1' && (
                                <p className="text-[#4A4453]">
                                    Analyzing claims and evidence relationships in your paper
                                </p>
                            )}
                            {currentStep === 'step2' && (
                                <p className="text-[#4A4453]">
                                    Mapping citation network and reference credibility
                                </p>
                            )}
                            {currentStep === 'complete' && (
                                <p className="text-[#4A4453]">
                                    Analysis complete! Review your comprehensive research validation report
                                </p>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default WizardProgress; 