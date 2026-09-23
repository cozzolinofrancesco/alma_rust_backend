'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NetworkGraphData, NetworkNode, NetworkLink } from '../types';
import '../styles/modal.css';
import HelpModal from './HelpModal';
import { Step2HelpContent } from './HelpContent';

interface NetworkGraphStepProps {
    data: NetworkGraphData;
    onComplete: () => void;
    onBack: () => void;
    onRerun: () => void;
    isRerunning: boolean;
}

const NetworkModal: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    selectedNode: string | null;
    selectedLink: string | null;
    data: NetworkGraphData;
    getNodeConnections: (nodeId: string) => NetworkLink[];
}> = ({ isOpen, onClose, selectedNode, selectedLink, data, getNodeConnections }) => {
    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };

        if (isOpen) {
            document.addEventListener('keydown', handleEscape);
            document.body.style.overflow = 'hidden';
        }

        return () => {
            document.removeEventListener('keydown', handleEscape);
            document.body.style.overflow = 'unset';
        };
    }, [isOpen, onClose]);

    if (!isOpen || (!selectedNode && !selectedLink)) return null;

    const modalContent = (
        <>
            {}
            <div
                className="modal-backdrop fixed inset-0 bg-black bg-opacity-50 z-[9998] flex items-center justify-center"
                onClick={onClose}
            >
                {}
                <div
                    className="modal-content bg-white rounded-2xl shadow-2xl border-2 border-gray-100 p-6 max-w-3xl max-h-[80vh] overflow-y-auto mx-4 relative"
                    onClick={(e) => e.stopPropagation()}
                >
                    {}
                    <button
                        onClick={onClose}
                        className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 text-xl font-bold w-8 h-8 flex items-center justify-center"
                    >
                        ×
                    </button>

                    {}
                    <h3 className="text-xl font-bold text-[#11074A] mb-6 pr-8">
                        {selectedNode ? 'Selected Node Details' : 'Selected Connection Details'}
                    </h3>

                    {}
                    {selectedNode && (
                        <div className="space-y-4">
                            {(() => {
                                const node = data.nodes.find(n => n.id === selectedNode);
                                if (!node) return null;
                                const connections = getNodeConnections(node.id);
                                
                                return (
                                    <>
                                        <div className="flex items-center gap-3">
                                            <span className="font-semibold text-[#4A4453]">Type:</span>
                                            <span className={`px-3 py-1 rounded-full text-sm font-medium ${
                                                node.type === 'evidence' ? 'bg-[#11074A] text-white' : 'bg-[#4A4453] text-white'
                                            }`}>
                                                {node.type === 'evidence' ? 'Evidence Point' : 'Reference Source'}
                                            </span>
                                        </div>
                                        
                                        <div>
                                            <span className="font-semibold text-[#4A4453] block mb-2">Label:</span>
                                            <p className="text-[#11074A] bg-gray-50 p-3 rounded-lg">{node.label}</p>
                                        </div>
                                        
                                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                            <div>
                                                <span className="font-semibold text-[#4A4453] block mb-1">Connections:</span>
                                                <div className="text-lg font-bold text-[#11074A]">
                                                    {connections.length} citations
                                                </div>
                                            </div>
                                            
                                            {node.credibilityScore && (
                                                <div>
                                                    <span className="font-semibold text-[#4A4453] block mb-1">Credibility Score:</span>
                                                    <div className="text-lg font-bold text-[#11074A]">
                                                        {Math.round(node.credibilityScore * 100)}%
                                                    </div>
                                                </div>
                                            )}
                                            
                                            {node.pageReference && (
                                                <div>
                                                    <span className="font-semibold text-[#4A4453] block mb-1">Page Reference:</span>
                                                    <span className="text-[#11074A] font-medium">{node.pageReference}</span>
                                                </div>
                                            )}
                                        </div>

                                        {}
                                        {node.type === 'reference' && node.crossRefData && (
                                            <div className="border-t pt-4 mt-4">
                                                <h4 className="font-semibold text-[#4A4453] mb-3">CrossRef Validation</h4>
                                                <div className="space-y-3">
                                                    <div className="flex items-center">
                                                        <span className="font-medium text-[#4A4453]">Status:</span>
                                                        <span className={`ml-2 px-3 py-1 rounded-full text-sm font-medium ${
                                                            node.crossRefData.verificationStatus === 'verified'
                                                                ? 'bg-green-100 text-green-800'
                                                                : node.crossRefData.verificationStatus === 'not_found'
                                                                    ? 'bg-yellow-100 text-yellow-800'
                                                                    : 'bg-red-100 text-red-800'
                                                        }`}>
                                                            {node.crossRefData.verificationStatus === 'verified' ? '✓ Verified' :
                                                                node.crossRefData.verificationStatus === 'not_found' ? '? Not Found' : '✗ Error'}
                                                        </span>
                                                    </div>

                                                    {node.crossRefData.verificationStatus === 'verified' && (
                                                        <div className="bg-green-50 p-4 rounded-lg space-y-2">
                                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                                                                <div>
                                                                    <span className="font-medium text-[#4A4453]">DOI:</span>
                                                                    <div className="text-[#11074A] font-mono text-xs break-all">{node.crossRefData.doi}</div>
                                                                </div>
                                                                <div>
                                                                    <span className="font-medium text-[#4A4453]">Citations:</span>
                                                                    <div className="text-[#11074A] font-bold">{node.crossRefData.citationCount.toLocaleString()}</div>
                                                                </div>
                                                                <div>
                                                                    <span className="font-medium text-[#4A4453]">Journal:</span>
                                                                    <div className="text-[#11074A]">{node.crossRefData.journal}</div>
                                                                </div>
                                                                <div>
                                                                    <span className="font-medium text-[#4A4453]">Published:</span>
                                                                    <div className="text-[#11074A]">{node.crossRefData.publishedDate}</div>
                                                                </div>
                                                            </div>
                                                            
                                                            <div className="flex items-center gap-4 pt-2 border-t border-green-200">
                                                                <div>
                                                                    <span className="font-medium text-[#4A4453]">Open Access:</span>
                                                                    <span className={`ml-2 px-2 py-1 rounded-full text-xs ${
                                                                        node.crossRefData.isOpenAccess
                                                                            ? 'bg-green-200 text-green-800'
                                                                            : 'bg-gray-200 text-gray-800'
                                                                    }`}>
                                                                        {node.crossRefData.isOpenAccess ? 'Yes' : 'No'}
                                                                    </span>
                                                                </div>
                                                                
                                                                {node.crossRefData.url && (
                                                                    <div>
                                                                        <a
                                                                            href={node.crossRefData.url}
                                                                            target="_blank"
                                                                            rel="noopener noreferrer"
                                                                            className="inline-flex items-center px-3 py-1 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors"
                                                                        >
                                                                            <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                                                            </svg>
                                                                            View Paper
                                                                        </a>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </>
                                );
                            })()}
                        </div>
                    )}

                    {selectedLink && (
                        <div className="space-y-4">
                            {(() => {
                                const link = data.links.find(l => l.id === selectedLink);
                                if (!link) return null;
                                const sourceNode = data.nodes.find(n => n.id === link.source);
                                const targetNode = data.nodes.find(n => n.id === link.target);
                                if (!sourceNode || !targetNode) return null;
                                
                                return (
                                    <>
                                        <div>
                                            <span className="font-semibold text-[#4A4453] block mb-2">Connection:</span>
                                            <div className="bg-gray-50 p-4 rounded-lg">
                                                <div className="flex items-center justify-center space-x-3">
                                                    <div className="text-center">
                                                        <div className="text-sm font-medium text-[#4A4453]">Source</div>
                                                        <div className="text-[#11074A] font-semibold">{sourceNode.label}</div>
                                                    </div>
                                                    <div className="flex-shrink-0">
                                                        <svg className="w-6 h-6 text-[#4A4453]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                                                        </svg>
                                                    </div>
                                                    <div className="text-center">
                                                        <div className="text-sm font-medium text-[#4A4453]">Target</div>
                                                        <div className="text-[#11074A] font-semibold">{targetNode.label}</div>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                        
                                        <div className="grid grid-cols-2 gap-4">
                                            <div>
                                                <span className="font-semibold text-[#4A4453] block mb-1">Type:</span>
                                                <span className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${
                                                    link.type === 'cites' ? 'bg-blue-500 text-white' :
                                                    link.type === 'supports' ? 'bg-green-500 text-white' :
                                                    'bg-red-500 text-white'
                                                }`}>
                                                    {link.type}
                                                </span>
                                            </div>
                                            
                                            <div>
                                                <span className="font-semibold text-[#4A4453] block mb-1">Strength:</span>
                                                <div className="text-lg font-bold text-[#11074A]">
                                                    {Math.round(link.strength * 100)}%
                                                </div>
                                            </div>
                                        </div>
                                        
                                        {link.label && (
                                            <div>
                                                <span className="font-semibold text-[#4A4453] block mb-2">Description:</span>
                                                <p className="text-[#11074A] bg-gray-50 p-3 rounded-lg">{link.label}</p>
                                            </div>
                                        )}
                                    </>
                                );
                            })()}
                        </div>
                    )}
                </div>
            </div>
        </>
    );

    return createPortal(modalContent, document.body);
};

const NetworkGraphStep: React.FC<NetworkGraphStepProps> = ({
    data,
    onComplete,
    onBack,
    onRerun,
    isRerunning
}) => {
    const svgRef = useRef<SVGSVGElement>(null);
    const [selectedNode, setSelectedNode] = useState<string | null>(null);
    const [selectedLink, setSelectedLink] = useState<string | null>(null);
    const [hoveredNode, setHoveredNode] = useState<string | null>(null);
    const [showModal, setShowModal] = useState(false);
    const [showHelpModal, setShowHelpModal] = useState(false);

    const calculateNodePositions = () => {
        const width = 800;
        const height = 600;
        const centerX = width / 2;
        const centerY = height / 2;
        const radius = 200;

        const evidenceNodes = data.nodes.filter(n => n.type === 'evidence');
        const referenceNodes = data.nodes.filter(n => n.type === 'reference');

        const positions: (NetworkNode & { x: number; y: number })[] = [];

        const evidenceCount = evidenceNodes.length;
        for (let i = 0; i < evidenceCount; i++) {
            const angle = evidenceCount <= 1
                ? -Math.PI / 2
                : (Math.PI * i) / (evidenceCount - 1) - Math.PI / 2;

            positions.push({
                ...evidenceNodes[i],
                x: centerX + Math.cos(angle) * radius - 150,
                y: centerY + Math.sin(angle) * radius
            });
        }

        const referenceCount = referenceNodes.length;
        for (let i = 0; i < referenceCount; i++) {
            const angle = referenceCount <= 1
                ? -Math.PI / 2
                : (Math.PI * i) / (referenceCount - 1) - Math.PI / 2;

            positions.push({
                ...referenceNodes[i],
                x: centerX + Math.cos(angle) * radius + 150,
                y: centerY + Math.sin(angle) * radius
            });
        }

        return positions;
    };

    const [nodePositions, setNodePositions] = useState<(NetworkNode & { x: number; y: number })[]>([]);

    useEffect(() => {
        setNodePositions(calculateNodePositions());
    }, [data]);

    const getNodeConnections = (nodeId: string) => {
        return data.links.filter(link => link.source === nodeId || link.target === nodeId);
    };

    const getConnectionStrengthColor = (strength: number) => {
        if (strength >= 0.8) return '#10B981';
        if (strength >= 0.6) return '#F59E0B';
        return '#EF4444';
    };

    const getCredibilityColor = (score: number) => {
        if (score >= 0.8) return '#10B981';
        if (score >= 0.6) return '#F59E0B';
        return '#EF4444';
    };

    const handleNodeClick = (nodeId: string) => {
        setSelectedNode(selectedNode === nodeId ? null : nodeId);
        setSelectedLink(null);
        if (selectedNode !== nodeId) {
            setShowModal(true);
        } else {
            setShowModal(false);
        }
    };

    const handleLinkClick = (linkId: string) => {
        setSelectedLink(selectedLink === linkId ? null : linkId);
        setSelectedNode(null);
        if (selectedLink !== linkId) {
            setShowModal(true);
        } else {
            setShowModal(false);
        }
    };

    const handleCloseModal = () => {
        setShowModal(false);
        setSelectedNode(null);
        setSelectedLink(null);
    };

    return (
        <div className="w-full max-w-6xl mx-auto space-y-6">
            {}
            <div className="bg-white rounded-2xl shadow-lg border-2 border-gray-100 p-6">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                        <h2 className="text-2xl font-bold text-[#11074A]">
                            Step 2: Reference Network Analysis
                        </h2>
                        <button
                            onClick={() => setShowHelpModal(true)}
                            className="w-8 h-8 bg-green-100 hover:bg-green-200 text-green-600 rounded-full flex items-center justify-center transition-colors"
                            title="Learn about Reference Network Analysis"
                        >
                            <span className="text-sm font-bold">?</span>
                        </button>
                    </div>
                    <div className="text-[#4A4453]">
                        <strong>{data.title}</strong>
                    </div>
                </div>

                {}
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                    <div className="bg-[#AFA8BA]/10 rounded-lg p-4 text-center">
                        <div className="text-2xl font-bold text-[#11074A]">{data.summary.totalEvidence}</div>
                        <div className="text-sm text-[#4A4453]">Evidence Points</div>
                    </div>
                    <div className="bg-[#AFA8BA]/10 rounded-lg p-4 text-center">
                        <div className="text-2xl font-bold text-[#11074A]">{data.summary.totalReferences}</div>
                        <div className="text-sm text-[#4A4453]">References</div>
                    </div>
                    <div className="bg-blue-50 rounded-lg p-4 text-center">
                        <div className="text-2xl font-bold text-blue-600">{data.summary.totalConnections}</div>
                        <div className="text-sm text-blue-700">Citations</div>
                    </div>
                    <div className="bg-green-50 rounded-lg p-4 text-center">
                        <div className="text-2xl font-bold text-green-600">
                            {Math.round(data.summary.avgCredibility * 100)}%
                        </div>
                        <div className="text-sm text-green-700">Avg Credibility</div>
                    </div>
                    <div className="bg-purple-50 rounded-lg p-4 text-center">
                        <div className="text-2xl font-bold text-purple-600">
                            {data.summary.crossRefValidated || 0}/{data.summary.totalCrossRefAttempts || 0}
                        </div>
                        <div className="text-sm text-purple-700">CrossRef Verified</div>
                    </div>
                </div>
            </div>

            {}
            <div className="bg-white rounded-2xl shadow-lg border-2 border-gray-100 p-6">
                <div className="mb-4 flex items-center justify-between">
                    <h3 className="text-lg font-bold text-[#11074A]">Citation Network</h3>
                    <div className="flex items-center space-x-4 text-sm">
                        <div className="flex items-center">
                            <div className="w-3 h-3 rounded-full bg-[#11074A] mr-2"></div>
                            <span>Evidence</span>
                        </div>
                        <div className="flex items-center">
                            <div className="w-3 h-3 rounded-full bg-[#4A4453] mr-2"></div>
                            <span>References</span>
                        </div>
                    </div>
                </div>

                <div className="overflow-x-auto">
                    <svg
                        ref={svgRef}
                        width="800"
                        height="600"
                        viewBox="0 0 800 600"
                        className="w-full h-auto border border-gray-200 rounded-lg"
                    >
                        {}
                        <g>
                            {data.links.map((link) => {
                                const sourceNode = nodePositions.find(n => n.id === link.source);
                                const targetNode = nodePositions.find(n => n.id === link.target);

                                if (!sourceNode || !targetNode) return null;

                                const isSelected = selectedLink === link.id;
                                const isConnectedToHovered = hoveredNode && (link.source === hoveredNode || link.target === hoveredNode);

                                return (
                                    <g key={link.id}>
                                        <line
                                            x1={sourceNode.x}
                                            y1={sourceNode.y}
                                            x2={targetNode.x}
                                            y2={targetNode.y}
                                            stroke={getConnectionStrengthColor(link.strength)}
                                            strokeWidth={isSelected || isConnectedToHovered ? 4 : 2}
                                            strokeOpacity={isConnectedToHovered || isSelected ? 1 : 0.6}
                                            className="cursor-pointer transition-all"
                                            onClick={() => handleLinkClick(link.id)}
                                        />

                                        {}
                                        {(isSelected || isConnectedToHovered) && (
                                            <text
                                                x={(sourceNode.x + targetNode.x) / 2}
                                                y={(sourceNode.y + targetNode.y) / 2}
                                                textAnchor="middle"
                                                fontSize="10"
                                                fill="#333"
                                                className="pointer-events-none"
                                            >
                                                {Math.round(link.strength * 100)}%
                                            </text>
                                        )}
                                    </g>
                                );
                            })}
                        </g>

                        {}
                        <g>
                            {nodePositions.map((node) => {
                                const isSelected = selectedNode === node.id;
                                const isHovered = hoveredNode === node.id;
                                const connections = getNodeConnections(node.id);

                                return (
                                    <g key={node.id}>
                                        {}
                                        <circle
                                            cx={node.x}
                                            cy={node.y}
                                            r={isSelected || isHovered ? node.size + 3 : node.size}
                                            fill={node.color}
                                            stroke={isSelected ? '#11074A' : 'white'}
                                            strokeWidth={isSelected ? 3 : 2}
                                            className="cursor-pointer transition-all hover:shadow-lg"
                                            onClick={() => handleNodeClick(node.id)}
                                            onMouseEnter={() => setHoveredNode(node.id)}
                                            onMouseLeave={() => setHoveredNode(null)}
                                        />

                                        {}
                                        {node.type === 'reference' && node.credibilityScore && (
                                            <circle
                                                cx={node.x + node.size - 5}
                                                cy={node.y - node.size + 5}
                                                r="4"
                                                fill={getCredibilityColor(node.credibilityScore)}
                                                stroke="white"
                                                strokeWidth="1"
                                                className="pointer-events-none"
                                            />
                                        )}

                                        {}
                                        <text
                                            x={node.x}
                                            y={node.y + node.size + 15}
                                            textAnchor="middle"
                                            fontSize="11"
                                            fill="#333"
                                            className="pointer-events-none font-medium"
                                        >
                                            {node.label.length > 20 ? node.label.substring(0, 17) + '...' : node.label}
                                        </text>

                                        {}
                                        {connections.length > 0 && (
                                            <text
                                                x={node.x}
                                                y={node.y + 3}
                                                textAnchor="middle"
                                                fontSize="10"
                                                fill="white"
                                                fontWeight="bold"
                                                className="pointer-events-none"
                                            >
                                                {connections.length}
                                            </text>
                                        )}
                                    </g>
                                );
                            })}
                        </g>
                    </svg>
                </div>
            </div>

            {}

            {}
            <div className="bg-gradient-to-r from-[#11074A]/5 to-[#4A4453]/5 rounded-2xl p-6 border border-[#AFA8BA]/20">
                <h3 className="text-lg font-bold text-[#11074A] mb-2">
                    Strongest Evidence Cluster
                </h3>
                <p className="text-[#4A4453] mb-4">
                    <strong>{data.summary.strongestCluster}</strong> shows the highest concentration of
                    credible references and strong citation links.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                    <div>
                        <span className="font-semibold text-[#4A4453]">Average Credibility:</span>
                        <span className="ml-2 text-[#11074A]">{Math.round(data.summary.avgCredibility * 100)}%</span>
                    </div>
                    <div>
                        <span className="font-semibold text-[#4A4453]">Total Citations:</span>
                        <span className="ml-2 text-[#11074A]">{data.summary.totalConnections}</span>
                    </div>
                </div>
            </div>

            {}
            <div className="flex justify-between items-center">
                <button
                    onClick={onBack}
                    className="px-6 py-3 bg-[#AFA8BA] text-white font-medium rounded-lg hover:bg-[#AFA8BA]/80 transition-colors"
                >
                    Back to Claims-Evidence
                </button>

                <div className="flex gap-3">
                    <button
                        onClick={onRerun}
                        disabled={isRerunning}
                        className="px-6 py-3 bg-[#4A4453] text-white font-medium rounded-lg hover:bg-[#4A4453]/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                    >
                        {isRerunning ? (
                            <>
                                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                </svg>
                                Re-running...
                            </>
                        ) : (
                            <>
                                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                </svg>
                                Re-run Step 2
                            </>
                        )}
                    </button>

                    <button
                        onClick={onComplete}
                        className="px-6 py-3 bg-[#11074A] text-white font-medium rounded-lg hover:bg-[#11074A]/90 transition-colors"
                    >
                        Complete Analysis
                    </button>
                </div>
            </div>

            {}
            {showModal && (
                <NetworkModal
                    isOpen={showModal}
                    onClose={handleCloseModal}
                    selectedNode={selectedNode}
                    selectedLink={selectedLink}
                    data={data}
                    getNodeConnections={getNodeConnections}
                />
            )}

            {}
            <HelpModal
                isOpen={showHelpModal}
                onClose={() => setShowHelpModal(false)}
                title="Step 2: Reference Network Analysis"
                content={<Step2HelpContent />}
            />
        </div>
    );
};

export default NetworkGraphStep; 