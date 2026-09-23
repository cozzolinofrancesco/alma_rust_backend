'use client';

import React from 'react';

export const Step1HelpContent: React.FC = () => (
    <div className="space-y-4">
        <div className="bg-blue-50 border-l-4 border-blue-400 p-4 rounded-r-lg">
            <h3 className="text-lg font-semibold text-blue-800 mb-2">
                🔍 Step 1: Claims-Evidence Analysis
            </h3>
            <p className="text-blue-700">
                This step analyzes the <strong>logical structure</strong> of your research paper by identifying claims and the evidence that supports them.
            </p>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
            <div>
                <h4 className="font-semibold text-gray-800 mb-3">What Step 1 Finds:</h4>
                <ul className="space-y-2 text-gray-700">
                    <li className="flex items-start">
                        <span className="bg-blue-500 text-white rounded-full w-6 h-6 flex items-center justify-center text-sm font-bold mr-3 mt-0.5">C</span>
                        <div>
                            <strong>Claims:</strong> Your main research hypotheses, conclusions, or arguments
                        </div>
                    </li>
                    <li className="flex items-start">
                        <span className="bg-gray-500 text-white rounded-full w-6 h-6 flex items-center justify-center text-sm font-bold mr-3 mt-0.5">E</span>
                        <div>
                            <strong>Evidence:</strong> Data, results, statistics that support your claims
                        </div>
                    </li>
                    <li className="flex items-start">
                        <span className="text-green-500 text-xl mr-3">→</span>
                        <div>
                            <strong>Support Relationships:</strong> How evidence connects to and validates claims
                        </div>
                    </li>
                </ul>
            </div>

            <div className="bg-gray-50 p-4 rounded-lg">
                <h4 className="font-semibold text-gray-800 mb-3">Example:</h4>
                <div className="text-sm space-y-2">
                    <div className="bg-blue-100 p-2 rounded border-l-4 border-blue-400">
                        <strong>Claim:</strong> "ML improves diagnostic accuracy"
                    </div>
                    <div className="text-center text-green-600 font-bold">↓ supported by</div>
                    <div className="bg-gray-100 p-2 rounded border-l-4 border-gray-400">
                        <strong>Evidence:</strong> "95% accuracy on test dataset"
                    </div>
                </div>
            </div>
        </div>

        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <h4 className="font-semibold text-yellow-800 mb-2">📊 Visual Representation</h4>
            <p className="text-yellow-700 text-sm">
                The sequence diagram shows your argument flow from left to right, with arrows indicating how evidence supports claims. 
                Click on any element to see detailed information including confidence scores and page references.
            </p>
        </div>

        <div className="border-t pt-4">
            <h4 className="font-semibold text-gray-800 mb-2">Key Question Step 1 Answers:</h4>
            <p className="text-lg text-center bg-blue-100 p-3 rounded-lg font-medium text-blue-800">
                "What evidence supports your claims?"
            </p>
        </div>
    </div>
);

export const Step2HelpContent: React.FC = () => (
    <div className="space-y-4">
        <div className="bg-green-50 border-l-4 border-green-400 p-4 rounded-r-lg">
            <h3 className="text-lg font-semibold text-green-800 mb-2">
                🕸️ Step 2: Reference Network Analysis
            </h3>
            <p className="text-green-700">
                This step analyzes the <strong>academic foundation</strong> of your evidence by examining which scholarly sources and references support each piece of evidence.
            </p>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
            <h4 className="font-semibold text-amber-800 mb-2">🎯 Important Distinction</h4>
            <p className="text-amber-700">
                Step 2 is <strong>NOT</strong> about your claims - it's about the <strong>citations and references</strong> that back up your evidence from Step 1.
            </p>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
            <div>
                <h4 className="font-semibold text-gray-800 mb-3">What Step 2 Analyzes:</h4>
                <ul className="space-y-2 text-gray-700">
                    <li className="flex items-start">
                        <span className="bg-blue-500 text-white rounded-full w-6 h-6 flex items-center justify-center text-sm font-bold mr-3 mt-0.5">E</span>
                        <div>
                            <strong>Evidence Nodes:</strong> Your evidence from Step 1
                        </div>
                    </li>
                    <li className="flex items-start">
                        <span className="bg-gray-500 text-white rounded-full w-6 h-6 flex items-center justify-center text-sm font-bold mr-3 mt-0.5">R</span>
                        <div>
                            <strong>Reference Nodes:</strong> Academic papers, studies, books cited by your evidence
                        </div>
                    </li>
                    <li className="flex items-start">
                        <span className="text-purple-500 text-xl mr-3">⟷</span>
                        <div>
                            <strong>Citation Links:</strong> Which references support which evidence
                        </div>
                    </li>
                </ul>
            </div>

            <div className="bg-gray-50 p-4 rounded-lg">
                <h4 className="font-semibold text-gray-800 mb-3">Example Flow:</h4>
                <div className="text-sm space-y-2">
                    <div className="bg-blue-100 p-2 rounded border-l-4 border-blue-400">
                        <strong>Evidence:</strong> "95% accuracy on test dataset"
                    </div>
                    <div className="text-center text-purple-600 font-bold">↓ cites</div>
                    <div className="bg-gray-100 p-2 rounded border-l-4 border-gray-400">
                        <strong>Reference:</strong> "Smith et al. (2023) - Cross-validation Methods"
                    </div>
                    <div className="text-xs text-green-600 mt-1">✅ Verified via CrossRef: 45 citations</div>
                </div>
            </div>
        </div>

        <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
            <h4 className="font-semibold text-purple-800 mb-2">🔍 CrossRef Validation</h4>
            <p className="text-purple-700 text-sm">
                Each reference is validated against the CrossRef academic database to verify:
            </p>
            <ul className="text-purple-700 text-sm mt-2 ml-4 space-y-1">
                <li>• Citation exists and is correctly formatted</li>
                <li>• Journal credibility and impact factor</li>
                <li>• Citation count (popularity/influence)</li>
                <li>• Publication date and relevance</li>
            </ul>
        </div>

        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <h4 className="font-semibold text-yellow-800 mb-2">🌐 Network Visualization</h4>
            <p className="text-yellow-700 text-sm">
                The network graph shows citation relationships as connected nodes. Larger nodes indicate more credible/cited sources. 
                Click on any node to see detailed CrossRef validation data.
            </p>
        </div>

        <div className="border-t pt-4">
            <h4 className="font-semibold text-gray-800 mb-2">Key Question Step 2 Answers:</h4>
            <p className="text-lg text-center bg-green-100 p-3 rounded-lg font-medium text-green-800">
                "What academic sources support your evidence?"
            </p>
        </div>

        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <h4 className="font-semibold text-red-800 mb-2">🚨 What Step 2 Helps You Find:</h4>
            <ul className="text-red-700 text-sm space-y-1">
                <li>• Evidence lacking proper academic backing</li>
                <li>• Incorrect or missing citations</li>
                <li>• Over-reliance on low-credibility sources</li>
                <li>• Citation gaps in your argument</li>
            </ul>
        </div>
    </div>
); 