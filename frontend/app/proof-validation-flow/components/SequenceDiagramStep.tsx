'use client';

import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { SequenceArrow, SequenceDiagramData, SequenceNote } from '../types';
import '../styles/modal.css';
import HelpModal from './HelpModal';
import { Step1HelpContent } from './HelpContent';

interface SequenceDiagramStepProps {
    data: SequenceDiagramData;
    onContinue: () => void;
    onBack: () => void;
    onRerun: () => void;
    isRerunning: boolean;
}

const EvidenceModal: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    selectedNote: string | null;
    selectedArrow: string | null;
    data: SequenceDiagramData;
    getStrengthLabel: (strength: number) => string;
}> = ({ isOpen, onClose, selectedNote, selectedArrow, data, getStrengthLabel }) => {
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

    if (!isOpen || (!selectedNote && !selectedArrow)) return null;

    const modalContent = (
        <>
            {}
            <div
                className="modal-backdrop fixed inset-0 bg-black bg-opacity-50 z-[9998] flex items-center justify-center"
                onClick={onClose}
            >
                {}
                <div
                    className="modal-content bg-white rounded-2xl shadow-2xl border-2 border-gray-100 p-6 max-w-2xl max-h-[80vh] overflow-y-auto mx-4 relative"
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
                        {selectedNote ? 'Selected Note Details' : 'Selected Relationship Details'}
                    </h3>

                    {}
                    {selectedNote && (
                        <div className="space-y-4">
                            {(() => {
                                const note = data.notes?.find(n => n.id === selectedNote);
                                if (!note) return null;
                                return (
                                    <>
                                        <div className="flex items-center gap-3">
                                            <span className="font-semibold text-[#4A4453]">Type:</span>
                                            <span className={`px-3 py-1 rounded-full text-sm font-medium ${
                                                note.type === 'claim' ? 'bg-[#11074A] text-white' : 'bg-[#4A4453] text-white'
                                            }`}>
                                                {note.type === 'claim' ? 'Research Claim' : 'Supporting Evidence'}
                                            </span>
                                        </div>
                                        
                                        <div>
                                            <span className="font-semibold text-[#4A4453] block mb-2">Content:</span>
                                            <p className="text-[#11074A] bg-gray-50 p-3 rounded-lg">{note.text}</p>
                                        </div>
                                        
                                        <div className="grid grid-cols-2 gap-4">
                                            <div>
                                                <span className="font-semibold text-[#4A4453] block mb-1">Confidence Score:</span>
                                                <div className="text-lg font-bold text-[#11074A]">
                                                    {Math.round(note.confidence * 100)}%
                                                    {note.qualityMarkers?.confidenceInterval &&
                                                        <span className="text-sm font-normal text-gray-600 ml-1">
                                                            (±{Math.round((note.qualityMarkers.confidenceInterval[1] - note.qualityMarkers.confidenceInterval[0]) * 50)}%)
                                                        </span>
                                                    }
                                                </div>
                                            </div>
                                            
                                            {note.pageReference && (
                                                <div>
                                                    <span className="font-semibold text-[#4A4453] block mb-1">Page Reference:</span>
                                                    <span className="text-[#11074A] font-medium">{note.pageReference}</span>
                                                </div>
                                            )}
                                        </div>

                                        {note.qualityMarkers && (
                                            <div className="space-y-3">
                                                {note.qualityMarkers.detected.length > 0 && (
                                                    <div>
                                                        <span className="font-semibold text-[#4A4453] block mb-2">Detected Quality Indicators:</span>
                                                        <div className="bg-green-50 p-3 rounded-lg">
                                                            <ul className="space-y-1">
                                                                {note.qualityMarkers.detected.map((indicator, idx) => (
                                                                    <li key={idx} className="flex items-center text-green-800">
                                                                        <span className="w-2 h-2 bg-green-500 rounded-full mr-3 flex-shrink-0"></span>
                                                                        {indicator}
                                                                    </li>
                                                                ))}
                                                            </ul>
                                                        </div>
                                                    </div>
                                                )}
                                                
                                                {note.qualityMarkers.inferred.length > 0 && (
                                                    <div>
                                                        <span className="font-semibold text-[#4A4453] block mb-2">Inferred Quality Indicators:</span>
                                                        <div className="bg-amber-50 p-3 rounded-lg">
                                                            <ul className="space-y-1">
                                                                {note.qualityMarkers.inferred.map((indicator, idx) => (
                                                                    <li key={idx} className="flex items-center text-amber-800">
                                                                        <span className="w-2 h-2 bg-amber-500 rounded-full mr-3 flex-shrink-0"></span>
                                                                        {indicator}
                                                                    </li>
                                                                ))}
                                                            </ul>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </>
                                );
                            })()}
                        </div>
                    )}

                    {selectedArrow && (
                        <div className="space-y-4">
                            {(() => {
                                const arrow = data.arrows?.find(a => a.id === selectedArrow);
                                if (!arrow) return null;
                                return (
                                    <>
                                        <div>
                                            <span className="font-semibold text-[#4A4453] block mb-2">Relationship:</span>
                                            <p className="text-[#11074A] bg-gray-50 p-3 rounded-lg font-medium">{arrow.label}</p>
                                        </div>
                                        
                                        <div className="grid grid-cols-2 gap-4">
                                            <div>
                                                <span className="font-semibold text-[#4A4453] block mb-1">Type:</span>
                                                <span className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${
                                                    arrow.type === 'supports' ? 'bg-green-500 text-white' :
                                                    arrow.type === 'contradicts' ? 'bg-red-500 text-white' :
                                                    'bg-orange-500 text-white'
                                                }`}>
                                                    {arrow.type}
                                                </span>
                                            </div>
                                            
                                            <div>
                                                <span className="font-semibold text-[#4A4453] block mb-1">Strength:</span>
                                                <div className="text-lg font-bold text-[#11074A]">
                                                    {Math.round(arrow.strength * 100)}%
                                                    <span className="text-sm font-normal text-gray-600 ml-1">
                                                        ({getStrengthLabel(arrow.strength)})
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
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

interface ArrowCoordinates {
    start: { x: number; y: number };
    end: { x: number; y: number };
    midpoint: { x: number; y: number };
}

interface LabelPosition {
    x: number;
    y: number;
    textX: number;
    textY: number;
}

const LAYOUT_CONFIG = {
    CLAIM_BOX: {
        x: 50,
        width: 280,
        height: 80,
        get rightEdge() { return this.x + this.width; },
        get center() { return { x: this.x + this.width / 2, y: (y: number) => y + this.height / 2 }; }
    },
    EVIDENCE_BOX: {
        x: 600,
        width: 220,
        height: 80,
        get leftEdge() { return this.x; },
        get center() { return { x: this.x + this.width / 2, y: (y: number) => y + this.height / 2 }; }
    },
    ARROW: {
        get startX() { return LAYOUT_CONFIG.CLAIM_BOX.rightEdge; },
        get endX() { return LAYOUT_CONFIG.EVIDENCE_BOX.leftEdge; },
        getStartY: (claimY: number) => claimY + LAYOUT_CONFIG.CLAIM_BOX.height / 2,
        getEndY: (evidenceY: number) => evidenceY + LAYOUT_CONFIG.EVIDENCE_BOX.height / 2,
        getMidpoint: (startY: number, endY: number) => ({
            x: (LAYOUT_CONFIG.CLAIM_BOX.rightEdge + LAYOUT_CONFIG.EVIDENCE_BOX.leftEdge) / 2,
            y: (startY + endY) / 2
        })
    },
    LABEL: {
        width: 100,
        height: 30,
        fontSize: 11
    }
} as const;

const calculateArrowCoordinates = (claimY: number, evidenceY: number): ArrowCoordinates => ({
    start: { x: LAYOUT_CONFIG.ARROW.startX, y: LAYOUT_CONFIG.ARROW.getStartY(claimY) },
    end: { x: LAYOUT_CONFIG.ARROW.endX, y: LAYOUT_CONFIG.ARROW.getEndY(evidenceY) },
    midpoint: LAYOUT_CONFIG.ARROW.getMidpoint(
        LAYOUT_CONFIG.ARROW.getStartY(claimY),
        LAYOUT_CONFIG.ARROW.getEndY(evidenceY)
    )
});

const calculateLabelPosition = (midpoint: { x: number; y: number }): LabelPosition => ({
    x: midpoint.x - LAYOUT_CONFIG.LABEL.width / 2,
    y: midpoint.y - LAYOUT_CONFIG.LABEL.height / 2,
    textX: midpoint.x,
    textY: midpoint.y + 3
});

const SequenceDiagramStep: React.FC<SequenceDiagramStepProps> = ({
    data,
    onContinue,
    onBack,
    onRerun,
    isRerunning
}) => {
    const [selectedNote, setSelectedNote] = useState<string | null>(null);
    const [selectedArrow, setSelectedArrow] = useState<string | null>(null);
    const [popupNote, setPopupNote] = useState<{ id: string; text: string } | null>(null);
    const [showModal, setShowModal] = useState(false);
    const [showHelpModal, setShowHelpModal] = useState(false);

    const testData = data;

    const getStrengthColor = (strength: number) => {
        if (strength >= 0.7) return '#10B981';
        if (strength >= 0.4) return '#F59E0B';
        return '#EF4444';
    };

    const getStrengthLabel = (strength: number) => {
        if (strength >= 0.7) return 'Strong';
        if (strength >= 0.4) return 'Moderate';
        return 'Weak';
    };

    const showPopup = (noteId: string, text: string) => {
        setPopupNote({ id: noteId, text });
        setTimeout(() => {
            setPopupNote(null);
        }, 3000);
    };

    const hidePopup = () => {
        setPopupNote(null);
    };

    const getTruncatedText = (text: string, maxLength: number = 80) => {
        return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
    };

    const handleNoteClick = (noteId: string) => {
        setSelectedNote(selectedNote === noteId ? null : noteId);
        setSelectedArrow(null);
        if (selectedNote !== noteId) {
            setShowModal(true);
        } else {
            setShowModal(false);
        }
    };

    const handleArrowClick = (arrowId: string) => {
        setSelectedArrow(selectedArrow === arrowId ? null : arrowId);
        setSelectedNote(null);
        if (selectedArrow !== arrowId) {
            setShowModal(true);
        } else {
            setShowModal(false);
        }
    };

    const handleCloseModal = () => {
        setShowModal(false);
        setSelectedNote(null);
        setSelectedArrow(null);
    };

    const createClaimEvidenceGroups = () => {
        const claims = testData.notes.filter(note => note.type === 'claim');
        const evidence = testData.notes.filter(note => note.type === 'evidence');
        type EvidenceItem = {
            evidence: SequenceNote | null;
            relationship: SequenceArrow | null;
            y: number;
        };

        const groups: Array<{
            claim: SequenceNote;
            evidenceList: EvidenceItem[];
            y: number;
        }> = [];

        let currentY = 150;

        claims.forEach((claim) => {
            const relatedEvidence: EvidenceItem[] = [];

            testData.arrows
                .filter(arrow => arrow.from === claim.id)
                .forEach((arrow, index) => {
                    const evidenceItem = evidence.find(e => e.id === arrow.to);
                    if (evidenceItem) {
                        relatedEvidence.push({
                            evidence: evidenceItem,
                            relationship: arrow,
                            y: currentY + (index * 100)
                        });
                    }
                });

            if (relatedEvidence.length === 0) {
                relatedEvidence.push({
                    evidence: null,
                    relationship: null,
                    y: currentY
                });
            }

            groups.push({
                claim,
                evidenceList: relatedEvidence,
                y: currentY
            });

            currentY += Math.max(1, relatedEvidence.length) * 100 + 50;
        });

        return groups;
    };

    const claimGroups = createClaimEvidenceGroups();

    return (
        <div className="w-full max-w-6xl mx-auto space-y-6">
            {}
            <div className="bg-white rounded-2xl shadow-lg border-2 border-gray-100 p-6">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                        <h2 className="text-2xl font-bold text-[#11074A]">
                            Step 1: Claims-Evidence Analysis
                        </h2>
                        <button
                            onClick={() => setShowHelpModal(true)}
                            className="w-8 h-8 bg-blue-100 hover:bg-blue-200 text-blue-600 rounded-full flex items-center justify-center transition-colors"
                            title="Learn about Claims-Evidence Analysis"
                        >
                            <span className="text-sm font-bold">?</span>
                        </button>
                    </div>
                    <div className="text-[#4A4453]">
                        <strong>{data.title || "Research Paper Analysis"}</strong>
                    </div>
                </div>

                {}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="bg-[#AFA8BA]/10 rounded-lg p-4 text-center">
                        <div className="text-2xl font-bold text-[#11074A]">{data.summary?.totalClaims || data.notes?.filter(n => n.type === 'claim').length || 0}</div>
                        <div className="text-sm text-[#4A4453]">Claims Identified</div>
                    </div>
                    <div className="bg-[#AFA8BA]/10 rounded-lg p-4 text-center">
                        <div className="text-2xl font-bold text-[#11074A]">{data.summary?.totalEvidence || data.notes?.filter(n => n.type === 'evidence').length || 0}</div>
                        <div className="text-sm text-[#4A4453]">Evidence Points</div>
                    </div>
                    <div className="bg-green-50 rounded-lg p-4 text-center">
                        <div className="text-2xl font-bold text-green-600">{data.summary?.strongLinks || data.arrows?.filter(a => a.strength > 0.7).length || 0}</div>
                        <div className="text-sm text-green-700">Strong Links</div>
                    </div>
                    <div className="bg-orange-50 rounded-lg p-4 text-center">
                        <div className="text-2xl font-bold text-orange-600">{data.summary?.weakLinks || data.arrows?.filter(a => a.strength <= 0.7).length || 0}</div>
                        <div className="text-sm text-orange-700">Weak Links</div>
                    </div>
                </div>
            </div>

            {}
            <div className="bg-white rounded-2xl shadow-lg border-2 border-gray-100 p-6">
                <div className="mb-4 flex items-center justify-between">
                    <h3 className="text-lg font-bold text-[#11074A]">Claims-Evidence Relationships</h3>
                    <div className="text-sm text-[#4A4453]">
                        💡 Click arrows to see relationship details and explanations
                    </div>
                </div>
                <div className="overflow-x-auto">
                    <svg
                        width="900"
                        height={Math.max(400, claimGroups.reduce((total, group) => total + group.evidenceList.length * 100 + 50, 0) + 250 + (selectedArrow ? 100 : 0))}
                        viewBox={`0 0 900 ${Math.max(400, claimGroups.reduce((total, group) => total + group.evidenceList.length * 100 + 50, 0) + 250 + (selectedArrow ? 100 : 0))}`}
                        className="w-full h-auto"
                        onClick={(e) => {
                            if (e.target === e.currentTarget) {
                                setSelectedArrow(null);
                                setSelectedNote(null);
                            }
                        }}
                    >
                        {}
                        <g opacity="0.3">
                            <line x1="190" y1="100" x2="190" y2={Math.max(400, claimGroups.reduce((total, group) => total + group.evidenceList.length * 100 + 50, 0) + 250 + (selectedArrow ? 100 : 0)) - 50}
                                stroke="#11074A" strokeWidth="2" strokeDasharray="5,5" />
                            <line x1="710" y1="100" x2="710" y2={Math.max(400, claimGroups.reduce((total, group) => total + group.evidenceList.length * 100 + 50, 0) + 250 + (selectedArrow ? 100 : 0)) - 50}
                                stroke="#4A4453" strokeWidth="2" strokeDasharray="5,5" />
                        </g>

                        {}
                        <g>
                            {}
                            <rect x="115" y="50" width="150" height="50" rx="8" fill="#11074A" />
                            <text x="190" y="80" textAnchor="middle" fill="white" fontSize="16" fontWeight="bold">
                                Claims
                            </text>

                            {}
                            <rect x="635" y="50" width="150" height="50" rx="8" fill="#4A4453" />
                            <text x="710" y="80" textAnchor="middle" fill="white" fontSize="16" fontWeight="bold">
                                Evidence
                            </text>
                        </g>

                        {}
                        <g>
                            {claimGroups.map((group, groupIndex) => (
                                <g key={`group-${groupIndex}`}>
                                    {}
                                    <g key={group.claim.id}>
                                        <rect
                                            x={LAYOUT_CONFIG.CLAIM_BOX.x}
                                            y={group.y}
                                            width={LAYOUT_CONFIG.CLAIM_BOX.width}
                                            height={LAYOUT_CONFIG.CLAIM_BOX.height}
                                            rx="8"
                                            fill={selectedNote === group.claim.id ? '#11074A' : '#F3F4F6'}
                                            stroke={selectedNote === group.claim.id ? '#11074A' : '#AFA8BA'}
                                            strokeWidth={selectedNote === group.claim.id ? 3 : 1}
                                            className="cursor-pointer hover:stroke-[#11074A] transition-all"
                                            onClick={() => handleNoteClick(group.claim.id)}
                                        />

                                        {}
                                        <foreignObject x="58" y={group.y + 8} width="264" height="50">
                                            <div
                                                className="text-xs text-[#11074A] font-medium leading-tight p-2 hover:bg-[#F3F4F6] rounded cursor-pointer"
                                                style={{
                                                    wordWrap: 'break-word',
                                                    hyphens: 'auto',
                                                    maxHeight: '46px',
                                                    overflow: 'hidden'
                                                }}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    showPopup(group.claim.id, group.claim.text);
                                                }}
                                            >
                                                {getTruncatedText(group.claim.text, 60)}
                                            </div>
                                        </foreignObject>

                                        {}
                                        {selectedNote === group.claim.id && (
                                            <foreignObject x="350" y={group.y} width="250" height="80">
                                                <div
                                                    className="bg-[#FFF8DF] text-[#6B4E00] p-3 rounded-lg border border-[#FEE2C5] text-xs shadow-md"
                                                    style={{
                                                        wordWrap: 'break-word',
                                                        wordBreak: 'break-word',
                                                        height: '100%',
                                                        overflow: 'auto',
                                                    }}
                                                >
                                                    <strong className="block mb-1">Claim Details:</strong>
                                                    <div>Confidence: {Math.round(group.claim.confidence * 100)}%</div>
                                                    <div>Page: {group.claim.pageReference || 'N/A'}</div>
                                                    {group.claim.qualityMarkers && (
                                                        <div className="mt-1">
                                                            <div>Quality Markers: {group.claim.qualityMarkers.detected.join(', ')}</div>
                                                        </div>
                                                    )}
                                                </div>
                                            </foreignObject>
                                        )}
                                    </g>

                                    {}
                                    {group.evidenceList.map((evidenceItem, evidenceIndex) => (
                                        <g key={`evidence-${groupIndex}-${evidenceIndex}`}>
                                                                                        {}
                                            {(() => {
                                                const arrowCoords = calculateArrowCoordinates(group.y, evidenceItem.y);
                                                const labelPos = calculateLabelPosition(arrowCoords.midpoint);
                                                
                                                return (
                                                    <>
                                                        <line
                                                            x1={arrowCoords.start.x}
                                                            y1={arrowCoords.start.y}
                                                            x2={arrowCoords.end.x}
                                                            y2={arrowCoords.end.y}
                                                            stroke={selectedArrow === evidenceItem.relationship?.id ? '#11074A' : getStrengthColor(evidenceItem.relationship?.strength || 0)}
                                                            strokeWidth={selectedArrow === evidenceItem.relationship?.id ? 4 : 2}
                                                            markerEnd="url(#arrowhead)"
                                                            className="cursor-pointer transition-all"
                                                            onClick={() => handleArrowClick(evidenceItem.relationship?.id || '')}
                                                        />

                                                        {}
                                                        {evidenceItem.relationship && (
                                                            <>
                                                                <rect
                                                                    x={labelPos.x}
                                                                    y={labelPos.y}
                                                                    width={LAYOUT_CONFIG.LABEL.width}
                                                                    height={LAYOUT_CONFIG.LABEL.height}
                                                                    rx="5"
                                                                    fill={selectedArrow === evidenceItem.relationship?.id ? '#11074A' : getStrengthColor(evidenceItem.relationship.strength)}
                                                                    className="cursor-pointer transition-all"
                                                                    onClick={() => handleArrowClick(evidenceItem.relationship?.id || '')}
                                                                />
                                                                <text
                                                                    x={labelPos.textX}
                                                                    y={labelPos.textY}
                                                                    textAnchor="middle"
                                                                    fill="white"
                                                                    fontSize={LAYOUT_CONFIG.LABEL.fontSize}
                                                                    fontWeight="bold"
                                                                    className="pointer-events-none"
                                                                >
                                                                    {getStrengthLabel(evidenceItem.relationship.strength)}
                                                                </text>
                                                            </>
                                                        )}
                                                    </>
                                                );
                                            })()}

                                            {}
                                            {evidenceItem.evidence ? (
                                                <g>
                                                    <rect
                                                        x={LAYOUT_CONFIG.EVIDENCE_BOX.x}
                                                        y={evidenceItem.y}
                                                        width={LAYOUT_CONFIG.EVIDENCE_BOX.width}
                                                        height={LAYOUT_CONFIG.EVIDENCE_BOX.height}
                                                        rx="8"
                                                        fill={selectedNote === evidenceItem.evidence.id ? '#4A4453' : '#F3F4F6'}
                                                        stroke={selectedNote === evidenceItem.evidence.id ? '#4A4453' : '#AFA8BA'}
                                                        strokeWidth={selectedNote === evidenceItem.evidence.id ? 3 : 1}
                                                        className="cursor-pointer hover:stroke-[#4A4453] transition-all"
                                                        onClick={() => evidenceItem.evidence && handleNoteClick(evidenceItem.evidence.id)}
                                                    />
                                                    <foreignObject x="608" y={evidenceItem.y + 8} width="204" height="50">
                                                        <div
                                                            className="text-xs text-[#4A4453] font-medium leading-tight p-2 hover:bg-[#F3F4F6] rounded cursor-pointer"
                                                            style={{
                                                                wordWrap: 'break-word',
                                                                hyphens: 'auto',
                                                                maxHeight: '46px',
                                                                overflow: 'hidden'
                                                            }}
                                                            onClick={() => {
                                                                if (evidenceItem.evidence) {
                                                                    showPopup(evidenceItem.evidence.id, evidenceItem.evidence.text);
                                                                }
                                                            }}
                                                        >
                                                            {evidenceItem.evidence && getTruncatedText(evidenceItem.evidence.text, 60)}
                                                        </div>
                                                    </foreignObject>
                                                    {}
                                                    <text
                                                        x="810"
                                                        y={evidenceItem.y + 15}
                                                        fontSize="10"
                                                        fill="#4A4453"
                                                        className="cursor-pointer"
                                                        onClick={() => evidenceItem.evidence && handleNoteClick(evidenceItem.evidence.id)}
                                                    >
                                                        [{evidenceItem.evidence.pageReference}]
                                                    </text>
                                                </g>
                                            ) : (
                                                <g>
                                                    <rect
                                                        x={LAYOUT_CONFIG.EVIDENCE_BOX.x}
                                                        y={evidenceItem.y}
                                                        width={LAYOUT_CONFIG.EVIDENCE_BOX.width}
                                                        height={LAYOUT_CONFIG.EVIDENCE_BOX.height}
                                                        rx="8"
                                                        fill="#F3F4F6"
                                                        stroke="#AFA8BA"
                                                        strokeWidth="1"
                                                        className="opacity-50"
                                                    />
                                                    <text 
                                                        x={LAYOUT_CONFIG.EVIDENCE_BOX.center.x} 
                                                        y={LAYOUT_CONFIG.EVIDENCE_BOX.center.y(evidenceItem.y)} 
                                                        textAnchor="middle" 
                                                        fontSize="12" 
                                                        fill="#4A4453" 
                                                        fontStyle="italic"
                                                    >
                                                        No Evidence Found
                                                    </text>
                                                </g>
                                            )}

                                            {}
                                        </g>
                                    ))}
                                </g>
                            ))}
                        </g>

                        {}
                        <defs>
                            <marker id="arrowhead" markerWidth="10" markerHeight="7"
                                refX="9" refY="3.5" orient="auto">
                                <polygon points="0 0, 10 3.5, 0 7" fill="#4A4453" />
                            </marker>
                        </defs>
                    </svg>
                </div>
            </div>

            {}
            {popupNote && (
                <>
                    {}
                    <div
                        className="fixed inset-0 z-[9998]"
                        onClick={hidePopup}
                    />
                    {}
                    <div
                        className="fixed z-[9999] text-xs text-gray-600 italic text-center leading-tight p-3 bg-white rounded-lg border-2 border-gray-300 shadow-lg"
                        style={{
                            left: '50%',
                            top: '50%',
                            transform: 'translate(-50%, -50%)',
                            maxHeight: '400px',
                            overflowY: 'auto',
                            minWidth: '200px',
                            minHeight: '100px',
                            maxWidth: '500px'
                        }}
                    >
                        <div>
                            {popupNote.text}
                        </div>
                        <button
                            onClick={hidePopup}
                            className="absolute top-2 right-2 text-gray-400 hover:text-gray-600 text-lg font-bold"
                        >
                            ×
                        </button>
                    </div>
                </>
            )}

            {}

            {}
            <div className="bg-amber-50 border-l-4 border-amber-400 p-6 rounded-lg">
                <div className="flex items-start">
                    <div className="flex-shrink-0">
                        <svg className="h-5 w-5 text-amber-400" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                        </svg>
                    </div>
                    <div className="ml-3">
                        <h3 className="text-sm font-medium text-amber-800">
                            Important: AI Analysis Limitations
                        </h3>
                        <div className="mt-2 text-sm text-amber-700 space-y-2">
                            <p><strong>What this system CAN detect/verify:</strong></p>
                            <ul className="list-disc list-inside ml-2 space-y-1">
                                <li>Explicitly stated sample sizes, p-values, and statistical results</li>
                                <li>Methodology descriptions and experimental designs when clearly described</li>
                                <li>Journal names and publication details when mentioned</li>
                                <li>Direct textual evidence and claims as written by authors</li>
                                <li><strong>✓ NEW:</strong> DOI validation and real citation counts via CrossRef database</li>
                                <li><strong>✓ NEW:</strong> Publication metadata verification (journal, authors, dates)</li>
                                <li><strong>✓ NEW:</strong> Open access status and publisher information</li>
                            </ul>

                            <p className="pt-2"><strong>What this system CANNOT verify:</strong></p>
                            <ul className="list-disc list-inside ml-2 space-y-1">
                                <li>True methodological rigor or data fabrication</li>
                                <li>Real-world credibility of institutions or researchers</li>
                                <li>Whether statistical analyses were performed correctly</li>
                                <li>Journal impact factors (though we verify journal names exist)</li>
                            </ul>

                            <p className="pt-2 font-semibold">
                                ⚠️ Use this tool for initial screening only. All quality assessments are educated guesses based on pattern recognition, not expert validation.
                            </p>
                        </div>
                    </div>
                </div>
            </div>

            {}
            <div className="flex justify-between items-center">
                <button
                    onClick={onBack}
                    className="px-6 py-3 bg-[#AFA8BA] text-white font-medium rounded-lg hover:bg-[#AFA8BA]/80 transition-colors"
                >
                    Back to Upload
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
                                Re-run Step 1
                            </>
                        )}
                    </button>

                    <button
                        onClick={onContinue}
                        className="px-6 py-3 bg-[#11074A] text-white font-medium rounded-lg hover:bg-[#11074A]/90 transition-colors"
                    >
                        Continue to Reference Network
                    </button>
                </div>
            </div>

            {}
            {showModal && (
                <EvidenceModal
                    isOpen={showModal}
                    onClose={handleCloseModal}
                    selectedNote={selectedNote}
                    selectedArrow={selectedArrow}
                    data={data}
                    getStrengthLabel={getStrengthLabel}
                />
            )}

            {}
            <HelpModal
                isOpen={showHelpModal}
                onClose={() => setShowHelpModal(false)}
                title="Step 1: Claims-Evidence Analysis"
                content={<Step1HelpContent />}
            />
        </div>
    );
};

export default SequenceDiagramStep; 