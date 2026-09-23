'use client';

import React, { type ReactNode } from 'react';
import {
  Compass, LayoutGrid, Workflow, ListChecks, ShieldCheck, Archive,
  Scale, Database, Share2, HelpCircle,
} from 'lucide-react';
import {
  SubjectReferenceGrid, PerClaimSpine, IntegrityChainViz, ArchiveSplit, SystemMap,
} from './TutorialDiagrams';

export interface TutorialStep {
  id: string;
  title: string;
  subtitle?: string;
  target?: string;
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'auto';
  icon: ReactNode;
  content: ReactNode;
}

// ── small presentational helpers (shared by all section tutorials) ───────────
export function P({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={`text-sm leading-relaxed ${className ?? 'text-gray-600'}`}>{children}</p>;
}
export function H({ children }: { children: ReactNode }) {
  return <h4 className="text-sm font-semibold text-gray-800 mt-1">{children}</h4>;
}
export function Diagram({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-4 my-1 overflow-x-auto">{children}</div>;
}
export function Bullets({ children }: { children: ReactNode }) {
  return <ul className="text-sm text-gray-600 space-y-1.5 list-disc pl-5">{children}</ul>;
}
export function Pill({ children, tone = 'indigo' }: { children: ReactNode; tone?: 'indigo' | 'gray' | 'amber' }) {
  const t = tone === 'amber' ? 'bg-amber-50 text-amber-700' : tone === 'gray' ? 'bg-gray-100 text-gray-600' : 'bg-indigo-50 text-indigo-700';
  return <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${t}`}>{children}</span>;
}

interface ModeRow {
  subject: string; reference: string; what: string; inputs: string; output: string; when: string; caveat?: string;
}
const MODES: ModeRow[] = [
  { subject: 'Document', reference: 'Knowledge base', what: 'Extract atomic claims from a PDF and validate each against a RAG corpus, with an integrity chain.', inputs: 'PDF + a corpus', output: 'Per-claim verdicts (table/graph)', when: 'You have an internal knowledge base to check a document against.' },
  { subject: 'Document', reference: 'Citations + literature (CrossRef)', what: 'Map claims↔evidence and build a reference network, verified against the CrossRef database.', inputs: 'PDF', output: 'Sequence diagram + reference network', when: 'You want to vet a paper’s citations and evidence structure.' },
  { subject: 'Knowledge base(s)', reference: 'Internal analysis', what: 'Analyze one or more corpora together: claims-evidence + evidence-references network.', inputs: '1+ corpora', output: 'Sequence + network graphs', when: 'You want a structural view of a whole knowledge base.' },
  { subject: 'Database', reference: 'Connect & preview', what: 'Connect a SQL database (read-only) and preview its tables as a validation source.', inputs: 'A DB connection', output: 'Table preview', when: 'Setting up / inspecting a database source.' },
  { subject: 'Document', reference: 'Another document', what: 'Extract claims from one PDF and check each against a second PDF.', inputs: 'Two PDFs', output: 'Per-claim verdicts', when: 'Comparing two papers / a draft vs a source.' },
  { subject: 'Document', reference: 'Itself (self-consistency)', what: 'Extract claims and detect internal contradictions between them.', inputs: 'One PDF', output: 'Per-claim contradiction verdicts', when: 'Checking a document doesn’t contradict itself.' },
  { subject: 'Document', reference: 'Broader public record', what: 'Check each claim against OpenAlex / CrossRef / PubMed.', inputs: 'One PDF', output: 'Per-claim support verdicts + sources', when: 'Checking claims against the wider literature.', caveat: 'Titles + abstracts only — not full text.' },
  { subject: 'Document', reference: 'Database (reconcile figures)', what: 'Reconcile a report’s numeric figures against a read-only database of record.', inputs: 'PDF + a DB connection', output: 'Per-figure match / mismatch', when: 'Auditing reported numbers against a source of truth.', caveat: 'NUMERICAL / STATISTICAL claims only; read-only SQL.' },
  { subject: 'Knowledge base', reference: 'Another knowledge base', what: 'Compare two corpora for agreements, contradictions, and coverage gaps.', inputs: 'Two corpora', output: 'Comparison table', when: 'Comparing two bodies of work.' },
];

export const VALIDATION_STEPS: TutorialStep[] = [
  {
    id: 'overview',
    title: 'What is the Validation suite?',
    icon: <Compass className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>The Validation suite checks <strong>claims</strong> against <strong>evidence</strong> and records a tamper-evident audit trail. Every tool is one idea: pick <strong>what you&rsquo;re checking</strong> (the <em>subject</em>) and <strong>what to check it against</strong> (the <em>reference</em>).</P>
        <Diagram><SubjectReferenceGrid /></Diagram>
        <P>The breadth of the reference is the &ldquo;degrees of freedom&rdquo;: one paper checked against the public record is a light check; an n-paper corpus gives much richer triangulation.</P>
      </div>
    ),
  },
  {
    id: 'studio',
    title: 'Validation Studio — one front door',
    icon: <LayoutGrid className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>Open <Pill>Validation &rarr; Validation Studio</Pill> to see a grid of modes. Each card is a <em>subject &times; reference</em> pairing. Click one and the right engine opens inline &mdash; no jumping between separate tools.</P>
        <H>The four families</H>
        <ul className="text-sm text-gray-600 space-y-1.5 list-disc pl-5">
          <li><strong>Per-claim verdicts</strong> &mdash; extract claims, judge each (doc&rarr;corpus, doc&rarr;doc, self, doc&rarr;public, doc&rarr;database).</li>
          <li><strong>Graph analysis</strong> &mdash; claims-evidence + reference networks (doc citations, corpus internal).</li>
          <li><strong>Comparison</strong> &mdash; corpus vs corpus.</li>
          <li><strong>Sources</strong> &mdash; connect &amp; preview a database.</li>
        </ul>
      </div>
    ),
  },
  {
    id: 'spine',
    title: 'How a validation runs',
    icon: <Workflow className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>The per-claim modes all share one pipeline. Only the <strong>evidence source</strong> (and sometimes the <strong>judge</strong>) changes between modes.</P>
        <Diagram><PerClaimSpine /></Diagram>
        <ul className="text-sm text-gray-600 space-y-1.5 list-disc pl-5">
          <li><strong>Extract</strong> &mdash; atomic, checkable claims are pulled from the document.</li>
          <li><strong>Adapter</strong> &mdash; gathers evidence for each claim (another doc, sibling claims, public APIs, or a database query).</li>
          <li><strong>Judge</strong> &mdash; produces a verdict (supported / contradicted / insufficient; numeric reconciliation for databases).</li>
          <li><strong>Results</strong> stream in live; an <strong>integrity chain</strong> is threaded as proof.</li>
        </ul>
      </div>
    ),
  },
  {
    id: 'modes',
    title: 'Every mode, in detail',
    icon: <ListChecks className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>The full menu. Scroll through &mdash; each is a <em>subject &times; reference</em> pairing.</P>
        <div className="space-y-2.5">
          {MODES.map((m, i) => (
            <div key={i} className="rounded-lg border border-gray-200 bg-white p-3">
              <div className="flex flex-wrap items-center gap-1.5 mb-1">
                <Pill>{m.subject}</Pill>
                <span className="text-gray-300">&rarr;</span>
                <Pill tone="gray">{m.reference}</Pill>
              </div>
              <p className="text-sm text-gray-700">{m.what}</p>
              <div className="mt-1.5 grid grid-cols-1 sm:grid-cols-3 gap-1 text-[11px] text-gray-500">
                <span><strong className="text-gray-600">In:</strong> {m.inputs}</span>
                <span><strong className="text-gray-600">Out:</strong> {m.output}</span>
                <span><strong className="text-gray-600">Use when:</strong> {m.when}</span>
              </div>
              {m.caveat && <p className="mt-1 text-[11px] text-amber-700">&#9888; {m.caveat}</p>}
            </div>
          ))}
        </div>
      </div>
    ),
  },
  {
    id: 'chains',
    title: 'Chains of Evidence',
    icon: <ShieldCheck className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>Every per-claim run threads a <strong>SHA-512 integrity chain</strong>. Each record hashes the claim + evidence + verdict <em>and the previous record&rsquo;s hash</em>.</P>
        <Diagram><IntegrityChainViz /></Diagram>
        <P>Because each link depends on the one before it, changing any input after the fact breaks every downstream hash. That makes a run <strong>tamper-evident</strong> &mdash; you can prove the conclusions came from exactly those inputs. Browse them under <Pill>Validation &rarr; Chains of Evidence</Pill>.</P>
      </div>
    ),
  },
  {
    id: 'archive',
    title: 'Verification Archive',
    icon: <Archive className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>The <strong>Verification Archive</strong> stores the <em>results</em> of past runs &mdash; the claims, verdicts, evidence quotes and summary.</P>
        <ul className="text-sm text-gray-600 space-y-1.5 list-disc pl-5">
          <li>Browse past runs for the selected project.</li>
          <li>Open one to view it as a table or graph.</li>
          <li>Download a run as JSON, or import an external run to view it.</li>
        </ul>
        <P>It answers: <em>&ldquo;what did the validation conclude?&rdquo;</em></P>
      </div>
    ),
  },
  {
    id: 'vs',
    title: 'Archive vs Chains — the difference',
    icon: <Scale className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>One run produces both, but they answer different questions.</P>
        <Diagram><ArchiveSplit /></Diagram>
        <P>The <strong>Verification Archive</strong> is the <em>report</em> (the conclusions). <strong>Chains of Evidence</strong> is the <em>notary seal</em> (proof nobody edited the inputs or verdicts). They cross-link by the run&rsquo;s final chain hash.</P>
      </div>
    ),
  },
  {
    id: 'sources',
    title: 'Data Sources (databases)',
    icon: <Database className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>Under <Pill>Validation &rarr; Data Sources</Pill> you connect SQL databases (Postgres, MySQL, SQL Server, SQLite). The form is driven by the engine <code className="text-[11px] bg-gray-100 px-1 rounded">type</code> &mdash; choosing it swaps the fields.</P>
        <H>Safe by design</H>
        <ul className="text-sm text-gray-600 space-y-1.5 list-disc pl-5">
          <li><strong>Read-only</strong> is locked on &mdash; only single <code className="text-[11px] bg-gray-100 px-1 rounded">SELECT</code> queries ever run.</li>
          <li>Credentials are stored <strong>server-side only</strong>; the browser never sees them again.</li>
          <li>Generated SQL is guarded, row-capped, and runs in a read-only transaction.</li>
        </ul>
        <P>A connected database powers the <em>Document &rarr; Database (reconcile figures)</em> mode.</P>
      </div>
    ),
  },
  {
    id: 'connect',
    title: 'How it all connects',
    icon: <Share2 className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>Sources feed the Studio; the Studio produces results + a chain; both land in Google Drive; the archives read them back.</P>
        <Diagram><SystemMap /></Diagram>
        <P>Results &rarr; <strong>QC-reports</strong> (Verification Archive). Integrity chains &rarr; <strong>Integrity-Keys</strong> (Chains of Evidence).</P>
      </div>
    ),
  },
  {
    id: 'faq',
    title: 'FAQ & limits',
    icon: <HelpCircle className="w-5 h-5" />,
    content: (
      <div className="space-y-2.5 text-sm text-gray-600">
        <div><H>Does &ldquo;public record&rdquo; read full papers?</H><P>No &mdash; OpenAlex / CrossRef / PubMed give titles and abstracts. It checks alignment with the abstract-level record, not full text.</P></div>
        <div><H>What can the database mode check?</H><P>Numeric / statistical figures only, against a read-only database. It shows the generated SQL and the matched rows.</P></div>
        <div><H>Where does my data live?</H><P>Run results and integrity chains save to your project&rsquo;s Google Drive folders (QC-reports, Integrity-Keys), with a local server mirror.</P></div>
        <div><H>The database modes don&rsquo;t connect.</H><P>The dev server must be restarted after the database drivers were added (a config change that doesn&rsquo;t hot-reload).</P></div>
        <div><H>Why isn&rsquo;t a new mode&rsquo;s run in the Verification Archive?</H><P>The newer per-claim modes currently save the integrity chain (Chains of Evidence) but not yet a results snapshot &mdash; that wiring is a planned follow-up.</P></div>
      </div>
    ),
  },
];
