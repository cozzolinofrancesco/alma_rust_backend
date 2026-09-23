'use client';

import React, { useState } from 'react';
import { NetworkGraphData, SequenceDiagramData } from '../types';

interface CompletionStepProps {
    step1Data: SequenceDiagramData;
    step2Data: NetworkGraphData;
    pdfFile: File | null;
    onReset: () => void;
}

const CompletionStep: React.FC<CompletionStepProps> = ({
    step1Data,
    step2Data,
    pdfFile,
    onReset
}) => {
    const [exportLoading, setExportLoading] = useState(false);

    const calculateOverallScore = () => {
        const step1Score = step1Data.summary.strongLinks / (step1Data.summary.strongLinks + step1Data.summary.weakLinks);
        const step2Score = step2Data.summary.avgCredibility;
        return Math.round(((step1Score + step2Score) / 2) * 100);
    };

    const generateRecommendations = () => {
        const recommendations: string[] = [];

        if (step1Data.summary.weakLinks > step1Data.summary.strongLinks) {
            recommendations.push("Consider strengthening evidence for weak claim-evidence relationships");
        }

        if (step2Data.summary.avgCredibility < 0.7) {
            recommendations.push("Include more high-credibility references from top-tier journals");
        }

        if (step2Data.summary.totalConnections < step2Data.summary.totalEvidence * 2) {
            recommendations.push("Increase citation density to better support evidence points");
        }

        if (recommendations.length === 0) {
            recommendations.push("Excellent research validation! All evidence is well-supported with credible references.");
        }

        return recommendations;
    };

    const overallScore = calculateOverallScore();
    const recommendations = generateRecommendations();

    const getScoreColor = (score: number) => {
        if (score >= 80) return 'text-green-600';
        if (score >= 60) return 'text-orange-600';
        return 'text-red-600';
    };

    const getScoreIcon = (score: number) => {
        if (score >= 80) return '★';
        if (score >= 60) return '◐';
        return '○';
    };

    const handleExportReport = async () => {
        setExportLoading(true);

        try {
            const reportData = {
                metadata: {
                    filename: pdfFile?.name || 'Unknown Document',
                    analysisDate: new Date().toISOString(),
                    overallScore,
                },
                step1Analysis: {
                    title: 'Claims-Evidence Analysis',
                    summary: step1Data.summary,
                    details: {
                        claims: step1Data.notes.filter(n => n.type === 'claim'),
                        evidence: step1Data.notes.filter(n => n.type === 'evidence'),
                        relationships: step1Data.arrows
                    }
                },
                step2Analysis: {
                    title: 'Reference Network Analysis',
                    summary: step2Data.summary,
                    details: {
                        evidenceNodes: step2Data.nodes.filter(n => n.type === 'evidence'),
                        referenceNodes: step2Data.nodes.filter(n => n.type === 'reference'),
                        connections: step2Data.links
                    }
                },
                recommendations
            };

            const blob = new Blob([JSON.stringify(reportData, null, 2)], {
                type: 'application/json'
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `research-validation-report-${Date.now()}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

        } catch (error) {
            console.error('Export failed:', error);
            alert('Failed to export report');
        } finally {
            setExportLoading(false);
        }
    };

    return (
        <div className="w-full max-w-6xl mx-auto space-y-6">
            {}
            <div className="bg-gradient-to-r from-green-50 to-blue-50 rounded-2xl shadow-lg border-2 border-green-100 p-8 text-center">
                <h1 className="text-3xl font-bold text-[#11074A] mb-2">
                    Analysis Complete!
                </h1>
                <p className="text-xl text-[#4A4453]">
                    Your research paper has been thoroughly validated through our two-step analysis process.
                </p>
            </div>

            {}
            <div className="bg-white rounded-2xl shadow-lg border-2 border-gray-100 p-8">
                <div className="text-center mb-6">
                    <h2 className="text-2xl font-bold text-[#11074A] mb-4">
                        Overall Validation Score
                    </h2>
                    <div className="flex items-center justify-center mb-4">
                        <div className="text-6xl mr-4">{getScoreIcon(overallScore)}</div>
                        <div className={`text-6xl font-bold ${getScoreColor(overallScore)}`}>
                            {overallScore}%
                        </div>
                    </div>
                    <p className="text-[#4A4453] text-lg">
                        {overallScore >= 80 ? 'Excellent research validation!' :
                            overallScore >= 60 ? 'Good research with room for improvement' :
                                'Research needs significant strengthening'}
                    </p>
                </div>

                {}
                <div className="grid md:grid-cols-2 gap-6">
                    <div className="bg-[#AFA8BA]/10 rounded-lg p-6">
                        <h3 className="font-bold text-[#11074A] mb-3">Claims-Evidence Analysis</h3>
                        <div className="space-y-2 text-sm">
                            <div className="flex justify-between">
                                <span>Total Claims:</span>
                                <span className="font-medium">{step1Data.summary.totalClaims}</span>
                            </div>
                            <div className="flex justify-between">
                                <span>Strong Evidence Links:</span>
                                <span className="font-medium text-green-600">{step1Data.summary.strongLinks}</span>
                            </div>
                            <div className="flex justify-between">
                                <span>Weak Evidence Links:</span>
                                <span className="font-medium text-orange-600">{step1Data.summary.weakLinks}</span>
                            </div>
                        </div>
                    </div>

                    <div className="bg-[#AFA8BA]/10 rounded-lg p-6">
                        <h3 className="font-bold text-[#11074A] mb-3">Reference Network Analysis</h3>
                        <div className="space-y-2 text-sm">
                            <div className="flex justify-between">
                                <span>References Analyzed:</span>
                                <span className="font-medium">{step2Data.summary.totalReferences}</span>
                            </div>
                            <div className="flex justify-between">
                                <span>Citation Connections:</span>
                                <span className="font-medium text-blue-600">{step2Data.summary.totalConnections}</span>
                            </div>
                            <div className="flex justify-between">
                                <span>Average Credibility:</span>
                                <span className="font-medium text-green-600">
                                    {Math.round(step2Data.summary.avgCredibility * 100)}%
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {}
            <div className="bg-white rounded-2xl shadow-lg border-2 border-gray-100 p-6">
                <h2 className="text-2xl font-bold text-[#11074A] mb-4">
                    Recommendations for Improvement
                </h2>
                <div className="space-y-3">
                    {recommendations.map((recommendation, index) => (
                        <div key={index} className="flex items-start">
                            <div className="flex-shrink-0 w-6 h-6 bg-[#11074A] text-white rounded-full flex items-center justify-center text-sm font-bold mr-3 mt-0.5">
                                {index + 1}
                            </div>
                            <p className="text-[#4A4453] leading-relaxed">{recommendation}</p>
                        </div>
                    ))}
                </div>
            </div>

            {}
            <div className="bg-gradient-to-r from-[#11074A]/5 to-[#4A4453]/5 rounded-2xl p-6 border border-[#AFA8BA]/20">
                <h2 className="text-2xl font-bold text-[#11074A] mb-4">
                    Key Insights
                </h2>
                <div className="grid md:grid-cols-2 gap-6">
                    <div>
                        <h3 className="font-semibold text-[#11074A] mb-2">Strongest Evidence Cluster</h3>
                        <p className="text-[#4A4453]">{step2Data.summary.strongestCluster}</p>
                    </div>
                    <div>
                        <h3 className="font-semibold text-[#11074A] mb-2">Research Foundation</h3>
                        <p className="text-[#4A4453]">
                            {step1Data.summary.strongLinks > step1Data.summary.weakLinks ?
                                'Solid evidence foundation with well-supported claims' :
                                'Evidence foundation needs strengthening for better validation'
                            }
                        </p>
                    </div>
                </div>
            </div>

            {}
            <div className="bg-white rounded-2xl shadow-lg border-2 border-gray-100 p-6">
                <h2 className="text-xl font-bold text-[#11074A] mb-4">
                    Export & Actions
                </h2>
                <div className="flex flex-wrap gap-4">
                    <button
                        onClick={handleExportReport}
                        disabled={exportLoading}
                        className="flex items-center px-6 py-3 bg-[#11074A] text-white font-medium rounded-lg hover:bg-[#11074A]/90 transition-colors disabled:opacity-50"
                    >
                        {exportLoading ? (
                            <>
                                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                                Generating...
                            </>
                        ) : (
                            <>
                                Export Full Report (JSON)
                            </>
                        )}
                    </button>

                    <button
                        onClick={() => window.print()}
                        className="flex items-center px-6 py-3 bg-[#4A4453] text-white font-medium rounded-lg hover:bg-[#4A4453]/90 transition-colors"
                    >
                        Print Summary
                    </button>

                    <button
                        onClick={onReset}
                        className="flex items-center px-6 py-3 bg-[#AFA8BA] text-white font-medium rounded-lg hover:bg-[#AFA8BA]/80 transition-colors"
                    >
                        Analyze New Paper
                    </button>
                </div>
            </div>

            {}
            <div className="bg-gray-50 rounded-lg p-4 text-center text-sm text-[#4A4453]">
                <p>
                    <strong>Document Analyzed:</strong> {pdfFile?.name || 'Unknown'} •
                    <strong> Analysis Date:</strong> {new Date().toLocaleDateString()} •
                    <strong> Analysis ID:</strong> {Date.now().toString(36).toUpperCase()}
                </p>
            </div>
        </div>
    );
};

export default CompletionStep; 