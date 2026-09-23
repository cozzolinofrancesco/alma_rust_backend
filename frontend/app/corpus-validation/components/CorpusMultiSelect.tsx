'use client';

import React from 'react';
import Link from 'next/link';
import { useCorpora } from '@/app/lib/hooks/useCorpora';

interface CorpusMultiSelectProps {
    selectedCorpusIds: string[];
    onToggle: (corpusId: string) => void;
    onRun: () => void;
    disabled?: boolean;
}

const CorpusMultiSelect: React.FC<CorpusMultiSelectProps> = ({
    selectedCorpusIds,
    onToggle,
    onRun,
    disabled
}) => {
    const { corpora, loading } = useCorpora();
    const selectedSet = new Set(selectedCorpusIds);
    const canRun = !disabled && selectedCorpusIds.length > 0;

    return (
        <div className="w-full max-w-4xl mx-auto">
            <div className="bg-white rounded-2xl shadow-lg border-2 border-gray-100 p-8">
                <h2 className="text-2xl font-bold text-[#11074A] mb-2 text-center">
                    Select Knowledge Bases
                </h2>
                <p className="text-[#4A4453] text-center mb-6">
                    Pick one or more corpora to analyze together. Need to create one?{' '}
                    <Link href="/rag-corpus" className="text-[#11074A] underline font-medium">
                        Open the RAG Corpus Manager
                    </Link>
                    .
                </p>

                {loading ? (
                    <p className="text-center text-[#4A4453] py-8">Loading corpora…</p>
                ) : corpora.length === 0 ? (
                    <div className="text-center py-8 space-y-3">
                        <p className="text-[#4A4453]">No knowledge bases found.</p>
                        <Link
                            href="/rag-corpus"
                            className="inline-flex items-center px-6 py-3 bg-[#11074A] text-white font-medium rounded-lg hover:bg-[#11074A]/90 transition-colors"
                        >
                            Create your first corpus
                        </Link>
                    </div>
                ) : (
                    <ul className="space-y-2 mb-6">
                        {corpora.map((c) => {
                            const checked = selectedSet.has(c.id);
                            return (
                                <li key={c.id}>
                                    <label
                                        className={`flex items-center gap-3 px-4 py-3 rounded-lg border-2 cursor-pointer transition-colors ${
                                            checked
                                                ? 'border-[#11074A] bg-[#11074A]/5'
                                                : 'border-[#AFA8BA]/40 hover:border-[#AFA8BA]'
                                        }`}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={() => onToggle(c.id)}
                                            disabled={disabled}
                                            className="w-4 h-4 accent-[#11074A]"
                                        />
                                        <span className="text-[#11074A] font-medium">{c.displayName}</span>
                                    </label>
                                </li>
                            );
                        })}
                    </ul>
                )}

                {corpora.length > 0 && (
                    <div className="flex items-center justify-between">
                        <span className="text-sm text-[#4A4453]">
                            {selectedCorpusIds.length} selected
                        </span>
                        <button
                            type="button"
                            onClick={onRun}
                            disabled={!canRun}
                            className="px-6 py-3 bg-[#11074A] text-white font-medium rounded-lg hover:bg-[#11074A]/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Run Analysis
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default CorpusMultiSelect;
