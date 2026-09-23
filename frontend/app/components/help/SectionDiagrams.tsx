'use client';

import {
  FileText, ScanText, Boxes, Network, MessagesSquare, Sigma,
  Bot, Play, Download, FolderTree, FlaskRound, Save, RotateCcw,
} from 'lucide-react';
import { Box, Arrow, Col } from './TutorialDiagrams';

// Per-section hand-built diagrams for the navbar section tutorials. Built from
// the shared Box / Arrow / Col primitives (TutorialDiagrams.tsx) — no diagram
// library, matching the validation tutorial's convention. Each is embedded via
// the <Diagram> wrapper inside a step's content.

// ── Home ─────────────────────────────────────────────────────────────────────
export function PlatformPillars() {
  return (
    <div className="flex items-start justify-center gap-3">
      <Col title="Data">
        <Box tone="gray">Upload &amp; OCR</Box>
        <Box tone="gray"><Boxes className="w-3.5 h-3.5 inline mr-1" />RAG knowledge</Box>
      </Col>
      <Col title="Agents">
        <Box><Bot className="w-3.5 h-3.5 inline mr-1" />Multi-step</Box>
        <Box>Run &amp; export</Box>
      </Col>
      <Col title="Validate &amp; report">
        <Box tone="green">Claim checks</Box>
        <Box tone="indigo">CTD 2.7.2</Box>
      </Col>
    </div>
  );
}

export function PlatformLoop() {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Box tone="gray">Add Data</Box>
      <Arrow />
      <Box tone="gray"><Boxes className="w-3.5 h-3.5 inline mr-1" />RAG KB</Box>
      <Arrow />
      <Box>Explorer / Agents</Box>
      <Arrow />
      <Box tone="amber">Validation</Box>
      <Arrow />
      <Box tone="green">Reports</Box>
    </div>
  );
}

// ── Projects ─────────────────────────────────────────────────────────────────
export function ProjectWorkspace() {
  return (
    <div className="flex items-center gap-3">
      <Box tone="indigo"><FolderTree className="w-3.5 h-3.5 inline mr-1" />Project<br />(Drive folder)</Box>
      <Arrow />
      <div className="grid grid-cols-2 gap-1.5">
        <Box tone="gray">PDFs</Box>
        <Box tone="gray">Extracts</Box>
        <Box tone="gray">RAG-Knowledge</Box>
        <Box tone="gray">Agents</Box>
        <Box tone="gray">Reports-output</Box>
        <Box tone="gray">&hellip;</Box>
      </div>
    </div>
  );
}

export function ProjectLifecycle() {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Box>Create</Box>
      <Arrow />
      <Box tone="green">Select = Active</Box>
      <Arrow />
      <Box tone="amber">Needs patch?</Box>
      <Arrow />
      <Box>Patch folders</Box>
      <Arrow />
      <Box tone="indigo">Use</Box>
    </div>
  );
}

// ── Add Data ─────────────────────────────────────────────────────────────────
export function UploadFlow() {
  return (
    <div className="flex flex-col items-center gap-2">
      <Box tone="gray"><FileText className="w-3.5 h-3.5 inline mr-1" />PDF</Box>
      <Arrow down />
      <div className="flex items-start gap-6">
        <div className="flex flex-col items-center gap-1">
          <Box>Just Import</Box>
          <Arrow down />
          <Box tone="green">PDFs folder</Box>
        </div>
        <div className="flex flex-col items-center gap-1">
          <Box tone="amber"><ScanText className="w-3.5 h-3.5 inline mr-1" />Import + OCR</Box>
          <Arrow down />
          <Box tone="green">Extracts/</Box>
        </div>
      </div>
    </div>
  );
}

export function RagPipeline() {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Box tone="gray">Drive files</Box>
      <Arrow />
      <Box>Create corpus</Box>
      <Arrow />
      <Box tone="amber">Index job<br />(chunk)</Box>
      <Arrow />
      <Box tone="green"><Boxes className="w-3.5 h-3.5 inline mr-1" />Queryable KB</Box>
    </div>
  );
}

// ── Data Explorer ────────────────────────────────────────────────────────────
export function ExplorerFlow() {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Box tone="gray"><Boxes className="w-3.5 h-3.5 inline mr-1" />Corpora</Box>
      <Arrow />
      <Box tone="amber">Gemini extract</Box>
      <Arrow />
      <Box tone="indigo"><Network className="w-3.5 h-3.5 inline mr-1" />Entity graph</Box>
      <Arrow />
      <Col title="explore">
        <Box>Expand node</Box>
        <Box><MessagesSquare className="w-3.5 h-3.5 inline mr-1" />Q&amp;A chat</Box>
        <Box><Sigma className="w-3.5 h-3.5 inline mr-1" />Topology</Box>
      </Col>
    </div>
  );
}

// ── Agent Builder ────────────────────────────────────────────────────────────
export function AgentDag() {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Box>Step 1</Box>
      <Arrow />
      <Box>Step 2<br />(refs 1)</Box>
      <Arrow />
      <Box>Step 3<br />(refs 2)</Box>
      <Arrow />
      <Box tone="amber"><Play className="w-3.5 h-3.5 inline mr-1" />Run All</Box>
      <Arrow />
      <Box tone="green">Results</Box>
      <Arrow />
      <Box tone="indigo"><Download className="w-3.5 h-3.5 inline mr-1" />Export</Box>
    </div>
  );
}

export function AgentViews() {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="flex items-center justify-center gap-4">
        <Col title="Linear">
          <Box tone="gray">Step list</Box>
        </Col>
        <span className="text-lg text-gray-300">&hArr;</span>
        <Col title="Graph">
          <Box tone="indigo"><Bot className="w-3.5 h-3.5 inline mr-1" />Nodes + edges</Box>
        </Col>
      </div>
      <p className="text-[11px] text-gray-400">Two views over the same agent &mdash; edits sync both ways.</p>
    </div>
  );
}

// ── CTD 2.7.2 ────────────────────────────────────────────────────────────────
export function Ctd272Pipeline() {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <Box>Session</Box>
      <Arrow />
      <Box tone="gray">Study corpus</Box>
      <Arrow />
      <Box>Match templates</Box>
      <Arrow />
      <Box tone="amber"><FlaskRound className="w-3.5 h-3.5 inline mr-1" />Biomaterial?</Box>
      <Arrow />
      <Box>Section 3</Box>
      <Arrow />
      <Box>Section 1</Box>
      <Arrow />
      <Box tone="green"><Save className="w-3.5 h-3.5 inline mr-1" />Save</Box>
      <Arrow />
      <Box tone="indigo"><RotateCcw className="w-3.5 h-3.5 inline mr-1" />Resume</Box>
    </div>
  );
}
