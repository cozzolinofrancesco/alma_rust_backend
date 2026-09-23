'use client';

import {
  ArrowRight, ArrowDown, Link2, FileText, Database, Globe, Network,
  ListChecks, ShieldCheck, Archive, Boxes, FlaskRound, Scale,
} from 'lucide-react';
import type { ReactNode } from 'react';

// Hand-built SVG/Tailwind diagrams shared across the in-app tutorials. No
// external diagram library — matches the repo's in-app diagram convention.
// Box / Arrow / Col are exported as primitives for SectionDiagrams.tsx.

export function Box({ children, tone = 'indigo' }: { children: ReactNode; tone?: 'indigo' | 'gray' | 'green' | 'amber' | 'red' }) {
  const tones: Record<string, string> = {
    indigo: 'border-indigo-200 bg-indigo-50 text-indigo-900',
    gray: 'border-gray-200 bg-gray-50 text-gray-700',
    green: 'border-green-200 bg-green-50 text-green-800',
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    red: 'border-red-200 bg-red-50 text-red-800',
  };
  return (
    <div className={`rounded-lg border px-3 py-2 text-xs font-medium text-center ${tones[tone]}`}>
      {children}
    </div>
  );
}

export function Arrow({ down = false }: { down?: boolean }) {
  return down
    ? <ArrowDown className="w-4 h-4 text-gray-300 shrink-0 mx-auto" />
    : <ArrowRight className="w-4 h-4 text-gray-300 shrink-0" />;
}

// ── Subject × Reference grid ────────────────────────────────────────────────
const SUBJECTS = ['Document', 'Knowledge base', 'Database'];
const REFERENCES = ['Self', 'Corpus', 'Public', 'Another doc', 'Database'];
// availability heat: which intersections are live (✓) vs conceptual
const CELLS: Record<string, '✓' | '·'> = {
  'Document|Self': '✓', 'Document|Corpus': '✓', 'Document|Public': '✓',
  'Document|Another doc': '✓', 'Document|Database': '✓',
  'Knowledge base|Corpus': '✓', 'Knowledge base|Self': '✓',
  'Database|Database': '✓',
};

export function SubjectReferenceGrid() {
  return (
    <div className="overflow-x-auto">
      <table className="border-collapse text-xs">
        <thead>
          <tr>
            <th className="p-2" />
            {REFERENCES.map((r) => (
              <th key={r} className="p-2 font-semibold text-gray-500 whitespace-nowrap">{r}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SUBJECTS.map((s) => (
            <tr key={s}>
              <th className="p-2 text-right font-semibold text-gray-500 whitespace-nowrap">{s}</th>
              {REFERENCES.map((r) => {
                const v = CELLS[`${s}|${r}`];
                return (
                  <td key={r} className="p-1">
                    <div className={`w-9 h-9 rounded-md flex items-center justify-center text-sm font-bold ${
                      v === '✓' ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-300'
                    }`}>
                      {v === '✓' ? '✓' : '·'}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-gray-400 mt-2">Pick a <span className="font-medium">subject</span> (row) and a <span className="font-medium">reference</span> (column). Filled cells are live modes.</p>
    </div>
  );
}

// ── Per-claim spine ─────────────────────────────────────────────────────────
export function PerClaimSpine() {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Box tone="gray"><FileText className="w-3.5 h-3.5 inline mr-1" />Extract claims</Box>
      <Arrow />
      <Box><Boxes className="w-3.5 h-3.5 inline mr-1" />Adapter<br />gather evidence</Box>
      <Arrow />
      <Box tone="amber"><Scale className="w-3.5 h-3.5 inline mr-1" />Judge<br />verdict</Box>
      <Arrow />
      <Box tone="green"><ListChecks className="w-3.5 h-3.5 inline mr-1" />Results<br />(live)</Box>
      <Arrow />
      <Box tone="indigo"><ShieldCheck className="w-3.5 h-3.5 inline mr-1" />Integrity<br />chain</Box>
    </div>
  );
}

// ── Integrity chain ─────────────────────────────────────────────────────────
function ChainBlock({ n }: { n: number }) {
  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-[11px] text-indigo-900 min-w-[120px]">
      <div className="font-semibold mb-1">Record {n}</div>
      <div className="text-gray-600">claim + evidence + verdict</div>
      <div className="mt-1 font-mono text-[10px] text-indigo-700">hash = SHA512(self + prev)</div>
    </div>
  );
}

export function IntegrityChainViz() {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      <ChainBlock n={1} />
      <Link2 className="w-4 h-4 text-indigo-300 shrink-0" />
      <ChainBlock n={2} />
      <Link2 className="w-4 h-4 text-indigo-300 shrink-0" />
      <ChainBlock n={3} />
      <span className="text-gray-300 text-sm">…</span>
    </div>
  );
}

// ── Archive split (run → two archives) ──────────────────────────────────────
export function ArchiveSplit() {
  return (
    <div className="flex flex-col items-center gap-2">
      <Box tone="indigo">One validation run</Box>
      <div className="flex items-start gap-8">
        <div className="flex flex-col items-center gap-1">
          <Arrow down />
          <Box tone="gray"><FileText className="w-3.5 h-3.5 inline mr-1" />Results</Box>
          <ArrowDown className="w-4 h-4 text-gray-300" />
          <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-[11px] text-center">
            <div className="font-semibold text-gray-800"><Archive className="w-3.5 h-3.5 inline mr-1" />Verification Archive</div>
            <div className="text-gray-500">what was concluded</div>
          </div>
        </div>
        <div className="flex flex-col items-center gap-1">
          <Arrow down />
          <Box tone="indigo"><ShieldCheck className="w-3.5 h-3.5 inline mr-1" />SHA-512 chain</Box>
          <ArrowDown className="w-4 h-4 text-gray-300" />
          <div className="rounded-lg border border-indigo-200 bg-white px-3 py-2 text-[11px] text-center">
            <div className="font-semibold text-indigo-800"><Link2 className="w-3.5 h-3.5 inline mr-1" />Chains of Evidence</div>
            <div className="text-gray-500">proof it's unaltered</div>
          </div>
        </div>
      </div>
      <p className="text-[11px] text-gray-400 mt-1">Linked by the run's final chain hash.</p>
    </div>
  );
}

// ── System map ──────────────────────────────────────────────────────────────
export function Col({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 min-w-[130px]">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 text-center">{title}</div>
      {children}
    </div>
  );
}

export function SystemMap() {
  return (
    <div className="flex items-center gap-3 overflow-x-auto pb-2">
      <Col title="Sources">
        <Box tone="gray"><FileText className="w-3.5 h-3.5 inline mr-1" />PDF</Box>
        <Box tone="gray"><Boxes className="w-3.5 h-3.5 inline mr-1" />RAG corpora</Box>
        <Box tone="gray"><Database className="w-3.5 h-3.5 inline mr-1" />Databases</Box>
        <Box tone="gray"><Globe className="w-3.5 h-3.5 inline mr-1" />Public APIs</Box>
      </Col>
      <Arrow />
      <Col title="Validation Studio">
        <Box><Network className="w-3.5 h-3.5 inline mr-1" />9 modes</Box>
        <Box tone="amber"><FlaskRound className="w-3.5 h-3.5 inline mr-1" />shared spine</Box>
      </Col>
      <Arrow />
      <Col title="Storage (Drive)">
        <Box tone="gray">QC-reports</Box>
        <Box tone="indigo">Integrity-Keys</Box>
      </Col>
      <Arrow />
      <Col title="Archives">
        <Box tone="green"><Archive className="w-3.5 h-3.5 inline mr-1" />Verification</Box>
        <Box tone="indigo"><ShieldCheck className="w-3.5 h-3.5 inline mr-1" />Chains</Box>
      </Col>
    </div>
  );
}
