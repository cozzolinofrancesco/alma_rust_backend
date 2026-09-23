'use client';

import { useState } from 'react';
import nextDynamic from 'next/dynamic';
import ClaimValidationFlow from '@/app/claim-validation/ClaimValidationFlow';
import DatabaseSourcePicker from '@/app/components/sources/DatabaseSourcePicker';
import type { PerClaimMode } from '@/app/validation/lib/referenceAdapter';

// The three existing engines are mounted inline (reuse, not rewrite). Proof and
// Corpus "Main" are client-only with heavy visualizations, so load them lazily.
// The new per-claim runner and corpus comparison flow are also loaded lazily.
const ProofFlow = nextDynamic(() => import('@/app/proof-validation-flow/components/Main'), { ssr: false });
const CorpusFlow = nextDynamic(() => import('@/app/corpus-validation/components/Main'), { ssr: false });
const PerClaimRunner = nextDynamic(() => import('@/app/validation/components/PerClaimRunner'), { ssr: false });
const CorpusComparisonFlow = nextDynamic(() => import('@/app/validation/components/CorpusComparisonFlow'), { ssr: false });

type EngineId = 'claim' | 'proof' | 'corpus' | 'db' | 'perclaim' | 'corpuscompare';

interface Mode {
  id: string;
  subject: string;
  reference: string;
  desc: string;
  status: 'available' | 'soon';
  engine?: EngineId;
  claimMode?: PerClaimMode; // for engine 'perclaim'
}

// Subject × Reference matrix, condensed to the buildable modes. "available"
// modes mount a working engine; "soon" modes are the rest of the matrix.
const MODES: Mode[] = [
  {
    id: 'doc-corpus', subject: 'Single document', reference: 'Knowledge base — per-claim verdicts',
    desc: 'Extract atomic claims from a PDF and validate each against a RAG corpus, with an integrity chain.',
    status: 'available', engine: 'claim',
  },
  {
    id: 'doc-refs', subject: 'Single document', reference: 'Its citations + literature (CrossRef)',
    desc: 'Map claims↔evidence and build a reference network, verified against the CrossRef database.',
    status: 'available', engine: 'proof',
  },
  {
    id: 'corpus-internal', subject: 'Knowledge base(s)', reference: 'Internal analysis',
    desc: 'Analyze one or more corpora together: claims-evidence sequence + evidence-references network.',
    status: 'available', engine: 'corpus',
  },
  {
    id: 'db-connect', subject: 'Database', reference: 'Connect & preview',
    desc: 'Connect a SQL database (read-only) and preview its tables as a validation source.',
    status: 'available', engine: 'db',
  },
  {
    id: 'doc-doc', subject: 'Single document', reference: 'Another document',
    desc: 'Extract claims from one PDF and check each against a second PDF.',
    status: 'available', engine: 'perclaim', claimMode: 'doc-doc',
  },
  {
    id: 'self', subject: 'Single document', reference: 'Itself (self-consistency)',
    desc: 'Extract claims from a PDF and detect internal contradictions between them.',
    status: 'available', engine: 'perclaim', claimMode: 'self',
  },
  {
    id: 'doc-public', subject: 'Single document', reference: 'Broader public record',
    desc: 'Check each claim against OpenAlex / CrossRef / PubMed (titles + abstracts).',
    status: 'available', engine: 'perclaim', claimMode: 'doc-public',
  },
  {
    id: 'doc-db', subject: 'Single document', reference: 'Database — reconcile figures',
    desc: 'Reconcile a report’s numeric figures against a read-only database of record.',
    status: 'available', engine: 'perclaim', claimMode: 'doc-db',
  },
  {
    id: 'corpus-corpus', subject: 'Knowledge base', reference: 'Another knowledge base',
    desc: 'Compare two corpora for agreements, contradictions, and coverage gaps.',
    status: 'available', engine: 'corpuscompare',
  },
];

export default function ValidationPage() {
  const [activeMode, setActiveMode] = useState<Mode | null>(null);

  if (activeMode?.engine) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-white">
        <div className="max-w-6xl mx-auto px-4 pt-6">
          <button
            type="button"
            onClick={() => setActiveMode(null)}
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-indigo-600"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            All validation modes
          </button>
          <div className="mt-2 text-xs text-gray-400">
            <span className="font-medium text-gray-600">{activeMode.subject}</span>
            <span className="mx-1.5">→</span>
            <span className="font-medium text-gray-600">{activeMode.reference}</span>
          </div>
        </div>
        <div className="mt-2">
          {activeMode.engine === 'claim' && <ClaimValidationFlow />}
          {activeMode.engine === 'proof' && (
            <div className="max-w-6xl mx-auto px-4 py-6"><ProofFlow /></div>
          )}
          {activeMode.engine === 'corpus' && (
            <div className="max-w-6xl mx-auto px-4 py-6"><CorpusFlow /></div>
          )}
          {activeMode.engine === 'db' && (
            <div className="max-w-3xl mx-auto px-4 py-6">
              <DatabaseSourcePicker />
              <p className="text-xs text-gray-400 mt-3">
                Manage and preview database sources here. To validate a document’s figures against a
                database, use the “Database — reconcile figures” mode.
              </p>
            </div>
          )}
          {activeMode.engine === 'perclaim' && activeMode.claimMode && (
            <div className="max-w-5xl mx-auto px-4 py-6"><PerClaimRunner mode={activeMode.claimMode} /></div>
          )}
          {activeMode.engine === 'corpuscompare' && (
            <div className="max-w-5xl mx-auto px-4 py-6"><CorpusComparisonFlow /></div>
          )}
        </div>
      </div>
    );
  }

  const available = MODES.filter((m) => m.status === 'available');
  const soon = MODES.filter((m) => m.status === 'soon');

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-white">
      <div className="max-w-5xl mx-auto px-4 py-10">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-[#11074A]">Validation</h1>
          <p className="text-gray-500 mt-2 text-sm max-w-2xl">
            One tool. Pick <span className="font-medium text-gray-700">what you’re checking</span> (the subject)
            and <span className="font-medium text-gray-700">what to check it against</span> (the reference).
            This unifies Claim Validation, Papers Reference Validation, and Knowledge Base Analysis.
          </p>
        </header>

        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Available now</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-10" data-tour="validation-studio-grid">
          {available.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setActiveMode(m)}
              className="text-left rounded-xl border border-gray-200 bg-white p-4 hover:border-indigo-400 hover:shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <div className="flex items-center gap-2 text-xs text-gray-500 mb-1.5">
                <span className="rounded-full bg-indigo-50 text-indigo-700 px-2 py-0.5 font-medium">{m.subject}</span>
                <span>→</span>
                <span className="rounded-full bg-gray-100 text-gray-600 px-2 py-0.5 font-medium">{m.reference}</span>
              </div>
              <p className="text-sm text-gray-700">{m.desc}</p>
              <span className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-indigo-600">
                Open
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </span>
            </button>
          ))}
        </div>

        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">Coming soon</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {soon.map((m) => (
            <div key={m.id} className="rounded-xl border border-dashed border-gray-200 bg-gray-50/60 p-4 opacity-80">
              <div className="flex items-center gap-2 text-xs text-gray-400 mb-1.5">
                <span className="rounded-full bg-white px-2 py-0.5 font-medium">{m.subject}</span>
                <span>→</span>
                <span className="rounded-full bg-white px-2 py-0.5 font-medium">{m.reference}</span>
              </div>
              <p className="text-xs text-gray-500">{m.desc}</p>
              <span className="mt-2 inline-block text-[10px] font-semibold uppercase tracking-wide text-gray-400">Coming soon</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
