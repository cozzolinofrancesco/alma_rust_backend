'use client';

import { useState } from 'react';
import { useCorpora } from '@/app/lib/hooks/useCorpora';
import type { CorpusComparison } from '@/app/validation/lib/comparisonPrompt';
import { requestValidationAnalysis } from '@/app/lib/validationAnalysis/client';

// corpus-corpus: pick two knowledge bases, query both via grounded retrieval with
// the comparison prompt, render agreements / contradictions / coverage gaps.
// NOTE: copy is hardcoded English for now (CLAUDE.md i18n rule — extract later).

export default function CorpusComparisonFlow() {
  const { corpora, loading, error } = useCorpora();
  const [corpusA, setCorpusA] = useState('');
  const [corpusB, setCorpusB] = useState('');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<CorpusComparison | null>(null);

  const canRun = corpusA && corpusB && corpusA !== corpusB && !running;

  async function run() {
    setRunning(true);
    setRunError(null);
    setResult(null);
    try {
      setResult(await requestValidationAnalysis<CorpusComparison>({ mode: 'compare', corpusIds: [corpusA, corpusB] }));
    } catch (e) {
      setRunError(e instanceof Error ? e.message : 'Network error.');
    } finally {
      setRunning(false);
    }
  }

  const selectCls = 'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500';

  return (
    <div className="space-y-5">
      {error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Knowledge base A</label>
            <select className={selectCls} value={corpusA} onChange={(e) => setCorpusA(e.target.value)} disabled={loading}>
              <option value="">{loading ? 'Loading…' : 'Choose corpus A'}</option>
              {corpora.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Knowledge base B</label>
            <select className={selectCls} value={corpusB} onChange={(e) => setCorpusB(e.target.value)} disabled={loading}>
              <option value="">{loading ? 'Loading…' : 'Choose corpus B'}</option>
              {corpora.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}
            </select>
          </div>
        </div>
      )}

      {corpusA && corpusB && corpusA === corpusB && (
        <p className="text-xs text-amber-600">Pick two different knowledge bases.</p>
      )}

      <button
        type="button"
        onClick={run}
        disabled={!canRun}
        className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {running ? 'Comparing…' : 'Compare knowledge bases'}
      </button>

      {runError && <p className="text-sm text-red-600">{runError}</p>}

      {result && (
        <div className="space-y-5">
          {result.summary && (
            <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-700">{result.summary}</div>
          )}

          <ComparisonSection title="Contradictions" empty="No contradictions found.">
            {result.contradictions.map((c, i) => (
              <div key={i} className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
                <p className="font-semibold text-red-800">{c.topic}</p>
                <p className="text-gray-700 mt-1"><span className="font-medium">A:</span> {c.a_says}</p>
                <p className="text-gray-700"><span className="font-medium">B:</span> {c.b_says}</p>
              </div>
            ))}
          </ComparisonSection>

          <ComparisonSection title="Agreements" empty="No shared findings surfaced.">
            {result.agreements.map((a, i) => (
              <div key={i} className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm">
                <p className="font-semibold text-green-800">{a.topic}</p>
                <p className="text-gray-700 mt-1">{a.detail}</p>
              </div>
            ))}
          </ComparisonSection>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <UniqueList title="Unique to A" items={result.unique_to_a} />
            <UniqueList title="Unique to B" items={result.unique_to_b} />
          </div>
        </div>
      )}
    </div>
  );
}

function ComparisonSection({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
  const items = Array.isArray(children) ? children : [children];
  const hasItems = items.some(Boolean) && (Array.isArray(children) ? children.length > 0 : true);
  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-700 mb-2">{title}</h3>
      {hasItems ? <div className="space-y-2">{children}</div> : <p className="text-xs text-gray-400">{empty}</p>}
    </div>
  );
}

function UniqueList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <h4 className="text-xs font-semibold text-gray-600 mb-2">{title}</h4>
      {items.length === 0 ? (
        <p className="text-xs text-gray-400">None.</p>
      ) : (
        <ul className="list-disc pl-4 space-y-1 text-sm text-gray-700">
          {items.map((it, i) => <li key={i}>{it}</li>)}
        </ul>
      )}
    </div>
  );
}
