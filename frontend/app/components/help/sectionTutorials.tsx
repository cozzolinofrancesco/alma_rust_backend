'use client';

import {
  Compass, Share2, Boxes, HelpCircle, Bug,
  FolderTree, FolderPlus, MousePointerClick, Users, RefreshCw,
  Upload, ScanText, AlertTriangle, FileText,
  Sparkles,
  Bot, ListChecks, Workflow, Wrench, Play,
  FileSignature, FlaskRound, Save, RotateCcw,
} from 'lucide-react';
import { P, H, Pill, Bullets, Diagram, VALIDATION_STEPS } from './tutorialSteps';
import type { TutorialStep } from './tutorialSteps';
import {
  PlatformPillars, PlatformLoop, ProjectWorkspace, ProjectLifecycle,
  UploadFlow, RagPipeline, AgentDag, AgentViews, Ctd272Pipeline,
} from './SectionDiagrams';

// Per-section tutorials, each a step-carousel rendered by SectionTutorialModal.
// Content is hardcoded English JSX, matching the existing validation tutorial
// (tutorialSteps.tsx) convention. Navbar *labels* remain i18n; this is body copy.

// ── Home — app overview ──────────────────────────────────────────────────────
export const HOME_STEPS: TutorialStep[] = [
  {
    id: 'home-what',
    target: 'home-hero',
    placement: 'bottom',
    title: 'Welcome to ALMA',
    icon: <Compass className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>ALMA is an AI research platform for pharmaceutical and scientific work. Everything is organised around a <strong>project</strong> &mdash; a Google&nbsp;Drive-backed workspace that holds your documents, knowledge bases, agents and reports.</P>
        <H>Three pillars</H>
        <Bullets>
          <li><strong>Data</strong> &mdash; upload &amp; OCR documents, build searchable RAG knowledge bases.</li>
          <li><strong>Agents</strong> &mdash; compose multi-step AI workflows that read your data and produce drafts.</li>
          <li><strong>Validation &amp; reporting</strong> &mdash; check claims against evidence and assemble regulatory reports.</li>
        </Bullets>
        <Diagram><PlatformPillars /></Diagram>
      </div>
    ),
  },
  {
    id: 'nav-home-step',
    target: 'nav-tools',
    placement: 'bottom',
    title: '1. Home',
    icon: <Compass className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>Open <strong>Tools</strong> and choose <strong>Home</strong> to return to the main research platform dashboard.</P>
        <Bullets>
          <li><strong>Hero &amp; Quick Actions</strong> &mdash; launch getting started guides and dev updates.</li>
          <li><strong>Team Support</strong> &mdash; contact project leads and support staff.</li>
          <li><strong>Recent Patches</strong> &mdash; view weekly platform changelogs and new feature releases.</li>
        </Bullets>
      </div>
    ),
  },
  {
    id: 'nav-projects-step',
    target: 'nav-project-switcher',
    placement: 'bottom',
    title: '2. Projects',
    icon: <FolderTree className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>The <strong>Project</strong> selector opens your research workspaces backed by Google Drive. Choose <strong>View All Projects</strong> to manage them.</P>
        <Bullets>
          <li><strong>Create Projects</strong> &mdash; automatically sets up required Drive folders (PDFs, Extracts, Agents, Reports).</li>
          <li><strong>Switch Workspaces</strong> &mdash; pick an active project from the panel or table.</li>
          <li><strong>Repair &amp; Patch</strong> &mdash; automatically fix deleted sub-folders with a single click.</li>
        </Bullets>
      </div>
    ),
  },
  {
    id: 'nav-add-data-step',
    target: 'nav-tools',
    placement: 'bottom',
    title: '3. Data Tools',
    icon: <Upload className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>Open <strong>Tools &gt; Data</strong> to upload, process, and index research documents:</P>
        <Bullets>
          <li><strong>PDF Dropzone</strong> &mdash; drag PDFs straight onto the menu for fast background import.</li>
          <li><strong>OCR Text Extraction</strong> &mdash; extract scanned PDF text using Gemini (~40s per page).</li>
          <li><strong>Data Storage</strong> &mdash; file manager for previews, tags, and complete document views.</li>
          <li><strong>RAG Knowledge Manager</strong> &mdash; index PDFs, DOCX, and PPTX into searchable corpora.</li>
        </Bullets>
      </div>
    ),
  },
  {
    id: 'nav-agent-builder-step',
    target: 'nav-tools',
    placement: 'bottom',
    title: '5. Agent Builder (Multi-Step Workflows)',
    icon: <Bot className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>Open <strong>Tools &gt; Workspace &gt; Agent Builder</strong> to build multi-step AI research workflows structured as Directed Acyclic Graphs (DAGs):</P>
        <Bullets>
          <li><strong>Step Configuration</strong> &mdash; define title, prompts, LLM model (Gemini, Claude, GPT), output schemas, and RAG corpora per step.</li>
          <li><strong>Step References &amp; Cascading</strong> &mdash; steps feed their output forward into downstream steps automatically.</li>
          <li><strong>Per-Step Quality Control (QC)</strong> &mdash; fact-check generated step text against source documents.</li>
          <li><strong>Linear &amp; Canvas Views</strong> &mdash; edit steps in form lists or interactive React Flow DAG diagrams.</li>
          <li><strong>Skills &amp; Export</strong> &mdash; stack global prompt directives and export finished drafts to PDF, DOCX, or Google Docs.</li>
        </Bullets>
      </div>
    ),
  },
  {
    id: 'nav-validation-step',
    target: 'nav-tools',
    placement: 'bottom',
    title: '6. Validation Suite',
    icon: <ListChecks className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>Open <strong>Tools &gt; Validation</strong> to fact-check claims against evidence and record audit proof.</P>
        <Bullets>
          <li><strong>Validation Studio</strong> &mdash; matrix of document, corpus, public record, and database modes.</li>
          <li><strong>Per-Claim Spine</strong> &mdash; extract atomic claims and evaluate support vs contradiction verdicts.</li>
          <li><strong>Chains of Evidence</strong> &mdash; SHA-512 tamper-evident hash chain linking claims and verdicts.</li>
          <li><strong>Verification Archive</strong> &mdash; inspect past validation reports saved directly to Google Drive.</li>
        </Bullets>
      </div>
    ),
  },
  {
    id: 'nav-sct272-step',
    target: 'nav-tools',
    placement: 'bottom',
    title: '7. CTD 2.7.2',
    icon: <FileSignature className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>Open <strong>Tools &gt; Workspace &gt; CTD 2.7.2</strong> for the guided wizard for drafting regulatory pharmacology summaries.</P>
        <Bullets>
          <li><strong>Study Matching</strong> &mdash; match extracted clinical studies to standardized report templates.</li>
          <li><strong>Biomaterial Summaries</strong> &mdash; assign study files to required HB subsection tables.</li>
          <li><strong>Autosave &amp; Resume</strong> &mdash; all section drafts save automatically to Google Drive for multi-session work.</li>
        </Bullets>
      </div>
    ),
  },
  {
    id: 'nav-questions-step',
    target: 'nav-questions',
    placement: 'bottom',
    title: '8. Questions & Support',
    icon: <HelpCircle className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>Open the <strong>Help</strong> icon to access support channels, tutorials, and platform training:</P>
        <Bullets>
          <li><strong>Need Help Modal</strong> &mdash; view team contact cards for Francesco, Team Leads, and Support.</li>
          <li><strong>FAQ / Page Tutorial</strong> &mdash; launch interactive spotlight tours tailored to the page you are on.</li>
          <li><strong>Chat With Us</strong> &mdash; join the official ALMA Google Chat channel directly.</li>
        </Bullets>
      </div>
    ),
  },
  {
    id: 'nav-docs-step',
    target: 'nav-questions',
    placement: 'bottom',
    title: '9. API & Documentation',
    icon: <FileText className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>Open <strong>Help &gt; API</strong> for technical documentation and developer resources.</P>
        <Bullets>
          <li><strong>API Endpoints</strong> &mdash; REST &amp; SDK endpoints for document ingestion and agent execution.</li>
          <li><strong>User Guides</strong> &mdash; comprehensive technical tutorials and system architecture docs.</li>
        </Bullets>
      </div>
    ),
  },
  {
    id: 'voice-ball-step',
    target: 'voice-ball',
    placement: 'bottom',
    title: '10. AI Voice & Chat Ball',
    icon: <Sparkles className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>The floating <strong>AI Ball</strong> provides voice and chat assistance anywhere in ALMA.</P>
        <Bullets>
          <li><strong>Voice Mode</strong> &mdash; speak naturally with real-time audio waveforms and text-to-speech feedback.</li>
          <li><strong>Text Mode</strong> &mdash; type questions directly when audio input is paused.</li>
          <li><strong>Thinking Indicator</strong> &mdash; glowing aurora ring shows active AI reasoning.</li>
        </Bullets>
      </div>
    ),
  },
  {
    id: 'bug-report-step',
    target: 'bug-report-button',
    placement: 'top',
    title: '11. Guided Bug & Issue Reporter',
    icon: <Bug className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>Encountered an issue or unexpected behavior? Click the floating red <strong>Bug Button</strong> in the bottom-right corner to open the AI-assisted Bug Reporter:</P>
        <Bullets>
          <li><strong>Guided 4-Question Form</strong> &mdash; systematically describes where, what, and how the issue occurred with AI prompt enhancement.</li>
          <li><strong>Interactive Element Picker &amp; Annotations</strong> &mdash; click any element on the page to automatically capture DOM paths, attach screenshots, and draw annotations.</li>
          <li><strong>Screen Recording &amp; Console Logs</strong> &mdash; record video reproduction steps and attach runtime console/network logs for developers.</li>
          <li><strong>Automated Tracking</strong> &mdash; submits bug reports directly to team trackers, creates Google Drive reproduction folders, and emails engineering.</li>
        </Bullets>
      </div>
    ),
  },
  {
    id: 'home-start',
    target: 'home-get-started',
    placement: 'top',
    title: 'Getting Started & Dev Blog',
    icon: <MousePointerClick className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>Use the quick action buttons in the hero section to launch key workflows:</P>
        <Bullets>
          <li><strong>Get Started</strong> &mdash; interactive guide to creating your first project and uploading files.</li>
          <li><strong>Chat With Us</strong> &mdash; direct Google Chat channel with the ALMA team.</li>
          <li><strong>Dev Blog</strong> &mdash; latest architecture notes, releases, and platform updates.</li>
        </Bullets>
      </div>
    ),
  },
  {
    id: 'home-connect',
    target: 'home-team',
    placement: 'top',
    title: 'Team Support & Platform Loop',
    icon: <Share2 className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>The sections feed each other in one connected loop:</P>
        <Diagram><PlatformLoop /></Diagram>
        <P>Need support? Contact our team members directly via cards on the homepage or reach out via email.</P>
      </div>
    ),
  },
];

// ── Projects ─────────────────────────────────────────────────────────────────
export const PROJECTS_STEPS: TutorialStep[] = [
  {
    id: 'proj-what',
    target: 'nav-project-switcher',
    placement: 'bottom',
    title: 'What a project is',
    icon: <FolderTree className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>A <strong>project</strong> is a research workspace backed by a Google&nbsp;Drive folder (named <code className="text-[11px] bg-gray-100 px-1 rounded">alma_&lt;name&gt;_&lt;timestamp&gt;</code>). It owns everything you do: uploaded files, RAG knowledge bases, agents, and validation runs.</P>
        <Bullets>
          <li>On creation, a full folder structure (PDFs, Extracts, Agents, RAG-Knowledge, Reports-output, &hellip;) is set up automatically.</li>
          <li>Projects are either <Pill>owned</Pill> by you or <Pill tone="gray">shared</Pill> with you.</li>
          <li>The active project is remembered across sessions &mdash; all uploads and runs default to it.</li>
        </Bullets>
        <Diagram><ProjectWorkspace /></Diagram>
      </div>
    ),
  },
  {
    id: 'proj-create',
    target: 'projects-header-actions',
    placement: 'bottom',
    title: 'Create a project',
    icon: <FolderPlus className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>Open <Pill>Projects</Pill> &rarr; <strong>New Project</strong>. Enter a name (letters, numbers, spaces, <code className="text-[11px] bg-gray-100 px-1 rounded">_</code> and <code className="text-[11px] bg-gray-100 px-1 rounded">-</code>; up to 60 chars) and confirm.</P>
        <Bullets>
          <li>A Drive folder plus its required sub-folders are created in one go.</li>
          <li>The new project appears in the list and in the header&rsquo;s Project panel.</li>
          <li>Special characters are stripped, so the saved name can differ slightly from what you typed.</li>
        </Bullets>
      </div>
    ),
  },
  {
    id: 'proj-select',
    target: 'projects-table-container',
    placement: 'top',
    title: 'Select &amp; switch projects',
    icon: <MousePointerClick className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>Click any row on the <Pill>Projects</Pill> page to activate it, or use the header&rsquo;s Project panel to select a workspace and open its Projects page.</P>
        <Bullets>
          <li>The active project shows an <Pill>ACTIVE</Pill> badge.</li>
          <li>Switching updates everything app-wide &mdash; no page reload needed.</li>
          <li>The navbar shows the clean name (Drive prefix and timestamp hidden).</li>
        </Bullets>
      </div>
    ),
  },
  {
    id: 'proj-share',
    target: 'projects-table-container',
    placement: 'top',
    title: 'Sharing &amp; collaborators',
    icon: <Users className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>Sharing is handled by Google&nbsp;Drive itself. Open the project folder in Drive and use its native <strong>Share</strong> dialog &mdash; ALMA detects the shared folder on the next refresh.</P>
        <Bullets>
          <li>Shared-with-you projects show the owner&rsquo;s email and a <Pill tone="gray">shared</Pill> badge.</li>
          <li>ALMA trusts Drive&rsquo;s permission model: anyone who can see the folder can work in that project.</li>
        </Bullets>
      </div>
    ),
  },
  {
    id: 'proj-fix',
    target: 'projects-refresh-btn',
    placement: 'left',
    title: 'Refresh &amp; repair',
    icon: <RefreshCw className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>The project list is cached. If a new project is missing, click <strong>Refresh Projects</strong> (or the refresh icon in the Project panel) to force a fresh Drive query.</P>
        <Bullets>
          <li>If folders were deleted in Drive, the project shows a <Pill tone="amber">Needs Patch</Pill> badge &mdash; click <strong>Patch</strong> to recreate the missing folders.</li>
          <li>Seeing duplicates or stale data? Clearing browser storage and refreshing resolves it.</li>
        </Bullets>
        <Diagram><ProjectLifecycle /></Diagram>
      </div>
    ),
  },
];

// ── Add Data ─────────────────────────────────────────────────────────────────
export const ADD_DATA_STEPS: TutorialStep[] = [
  {
    id: 'data-entry',
    title: 'Three ways to add data',
    icon: <Upload className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P><Pill>Tools &gt; Data</Pill> has three entry points (an active project is required):</P>
        <Bullets>
          <li><strong>PDF dropzone</strong> &mdash; drag a PDF straight onto the menu for a quick import.</li>
          <li><strong>Open Data Storage</strong> (<code className="text-[11px] bg-gray-100 px-1 rounded">/upload</code>) &mdash; the full file manager.</li>
          <li><strong>RAG Knowledge Manager</strong> (<code className="text-[11px] bg-gray-100 px-1 rounded">/rag-corpus</code>) &mdash; build searchable knowledge bases.</li>
        </Bullets>
      </div>
    ),
  },
  {
    id: 'data-ocr',
    title: 'Upload &amp; OCR a PDF',
    icon: <ScanText className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>Drop a PDF on the dropzone and choose:</P>
        <Bullets>
          <li><strong>Just Import</strong> &mdash; store the file in the project&rsquo;s <em>PDFs</em> folder (near-instant).</li>
          <li><strong>Import + OCR</strong> &mdash; also extract text with Gemini (about ~40s per page). Pick a page range and model.</li>
        </Bullets>
        <P>Extracted text lands in <em>Extracts/&lt;PDF name&gt;/</em>. OCR runs in the background &mdash; progress survives closing the popup, and failed pages can be retried per-page with a different model.</P>
        <Diagram><UploadFlow /></Diagram>
      </div>
    ),
  },
  {
    id: 'data-storage',
    title: 'Manage files in Data Storage',
    icon: <FileText className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P><Pill>Open Data Storage</Pill> is the project&rsquo;s media manager: a folder tree (PDFs, Docs, Images, Extracts, &hellip;) with search and filters.</P>
        <Bullets>
          <li>Search by filename, AI description or tag; filter by date or type.</li>
          <li>Preview or download files; re-OCR an existing PDF with a new page range or model.</li>
          <li>&ldquo;View Complete Document&rdquo; stitches per-page extracts back into one view.</li>
        </Bullets>
      </div>
    ),
  },
  {
    id: 'data-rag',
    title: 'Build a RAG knowledge base',
    icon: <Boxes className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>In the <Pill>RAG Knowledge Manager</Pill>, pick files from Drive and create a corpus. Indexing runs as a background job (watch the <strong>Jobs</strong> tab); the corpus appears once it completes.</P>
        <Diagram><RagPipeline /></Diagram>
        <Bullets>
          <li>Supports PDF, DOCX, PPTX, XLSX, TXT, code and more (Workspace files are exported automatically).</li>
          <li>For PDFs you can restrict to a page range.</li>
          <li>Per-corpus limits apply (a handful of files / a few million characters) &mdash; split very large datasets.</li>
        </Bullets>
        <P className="text-gray-500">These knowledge bases power Data Explorer, agent steps, and corpus-based validation.</P>
      </div>
    ),
  },
  {
    id: 'data-limits',
    title: 'Size limits &amp; gotchas',
    icon: <AlertTriangle className="w-5 h-5" />,
    content: (
      <div className="space-y-2.5 text-sm text-gray-600">
        <div><H>How big can a file be?</H><P>Uploads are capped at <strong>30&nbsp;MB</strong> per file. Larger files fail before they reach the server.</P></div>
        <div><H>Why is OCR slow?</H><P>~40s per page &mdash; a 100-page PDF can take over an hour. Use page ranges to limit scope.</P></div>
        <div><H>Database modes don&rsquo;t connect?</H><P>The dev server must be restarted after database drivers are added (a config change that doesn&rsquo;t hot-reload).</P></div>
        <div><H>RAG corpus failed to create?</H><P>You likely exceeded the file / character / chunk limits. Reduce the file count or trim page ranges.</P></div>
      </div>
    ),
  },
];


// ── Agent Builder ────────────────────────────────────────────────────────────
export const AGENT_STEPS: TutorialStep[] = [
  {
    id: 'agent-what',
    target: 'nav-tools',
    placement: 'bottom',
    title: 'What an Agent & Step Workflow is',
    icon: <Bot className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>An <strong>agent</strong> is a multi-step AI research workflow structured as a Directed Acyclic Graph (DAG). Instead of a single prompt, work is broken into discrete <strong>steps</strong> that process information sequentially or in parallel.</P>
        <Bullets>
          <li><strong>Modular Steps</strong> &mdash; each step owns a specific instruction, AI model, and optional RAG knowledge base.</li>
          <li><strong>Context Cascading</strong> &mdash; steps reference earlier step outputs, passing findings forward into synthesis steps.</li>
          <li><strong>Drive Persistence</strong> &mdash; agents and execution runs save automatically to your active project's Google Drive folder.</li>
        </Bullets>
      </div>
    ),
  },
  {
    id: 'agent-dashboard',
    target: 'agent-create-btn',
    placement: 'bottom',
    title: 'Dashboard & Agent Creation',
    icon: <ListChecks className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>The Agents Dashboard gives you complete control over your workflow library:</P>
        <Bullets>
          <li><strong>Create New Agent</strong> &mdash; start from scratch with a blank single-step agent.</li>
          <li><strong>AI-Assist Creation</strong> &mdash; generate a complete multi-step agent automatically from a natural language prompt.</li>
          <li><strong>Report Creation Wizard</strong> &mdash; assemble specialized clinical pharmacology and CTD 2.7.2 agents.</li>
          <li><strong>Card Actions</strong> &mdash; preview agent health, duplicate, export JSON schema, or launch the editor.</li>
        </Bullets>
      </div>
    ),
  },
  {
    id: 'agent-views',
    title: 'Linear Form vs Graph Canvas View',
    icon: <Workflow className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>The editor provides two bidirectionally synced views over the same agent model:</P>
        <Bullets>
          <li><strong>Linear (Form Editor)</strong> &mdash; reorder steps, edit prompts, and manage settings in a structured sidebar list.</li>
          <li><strong>Graph (React Flow Canvas)</strong> &mdash; view steps as visual nodes and step dependencies as directional connecting edges.</li>
          <li><strong>Canvas Tools</strong> &mdash; drag-and-drop node placement, auto-layout algorithms, tag filtering, and canvas image export.</li>
        </Bullets>
        <Diagram><AgentViews /></Diagram>
      </div>
    ),
  },
  {
    id: 'agent-step-details',
    title: 'In-Depth: Step Configuration & Prompts',
    icon: <Wrench className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>Each step in an agent operates as an isolated execution unit configured across three main tabs:</P>
        <Bullets>
          <li><strong>Step Title &amp; Description</strong> &mdash; uniquely identifies the step's role (e.g. "Extract Pharmacokinetics").</li>
          <li><strong>User Instruction</strong> &mdash; the core prompt explaining what the LLM should analyze or draft.</li>
          <li><strong>System Instruction</strong> &mdash; persona, constraints, and output formatting rules specific to this step.</li>
          <li><strong>Model Selector</strong> &mdash; pick the best AI model for the task (Gemini 1.5 Pro/Flash, Claude 3.5 Sonnet, GPT-4o).</li>
          <li><strong>Output Format</strong> &mdash; choose between free-form Markdown, structured JSON schemas, or markdown tables.</li>
        </Bullets>
      </div>
    ),
  },
  {
    id: 'agent-step-references',
    title: 'In-Depth: Step References & Data Cascading',
    icon: <Share2 className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>Step references determine how data flows through your agent DAG:</P>
        <Bullets>
          <li><strong>Selecting Upstream Steps</strong> &mdash; check earlier steps in the "References" tab to include their execution output as input context.</li>
          <li><strong>Template Variables</strong> &mdash; reference previous step outputs directly in prompts using variable placeholders.</li>
          <li><strong>Parallel &amp; Join Patterns</strong> &mdash; branch work into parallel independent steps (e.g. "Summarize Study A" &amp; "Summarize Study B") and join them in a downstream synthesis step.</li>
        </Bullets>
      </div>
    ),
  },
  {
    id: 'agent-step-rag-qc',
    title: 'In-Depth: RAG Knowledge & Per-Step Quality Control',
    icon: <Boxes className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>Ground individual steps in primary literature and enforce fact-checking:</P>
        <Bullets>
          <li><strong>RAG Corpus Attachment</strong> &mdash; attach a specific RAG knowledge base to a step so the model queries uploaded documents before drafting.</li>
          <li><strong>Per-Step Quality Control (QC)</strong> &mdash; enable automated QC to extract claims from the step's generated output and fact-check them against the attached corpus, highlighting unsupported statements.</li>
        </Bullets>
      </div>
    ),
  },
  {
    id: 'agent-skills',
    title: 'Skills: Reusable Global Directives',
    icon: <Sparkles className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P><strong>Skills</strong> are shared system-level directives stored in a central library:</P>
        <Bullets>
          <li><strong>Global Application</strong> &mdash; attaching a skill applies its rules (e.g. "Regulatory Compliance", "ICH Guidelines") across <em>every</em> step in the agent.</li>
          <li><strong>Central Updates</strong> &mdash; updating a skill in your library automatically updates all agents using that skill.</li>
          <li><strong>Document Import</strong> &mdash; create new skills directly from uploaded PDFs, Word documents, or Google Docs.</li>
        </Bullets>
      </div>
    ),
  },
  {
    id: 'agent-run',
    title: 'Topological Run Execution & Exporting',
    icon: <Play className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>Execute and export completed research documents with full auditability:</P>
        <Bullets>
          <li><strong>Topological Execution</strong> &mdash; <strong>Run All</strong> automatically evaluates step dependencies and executes steps in optimal order.</li>
          <li><strong>Live Streaming &amp; Control</strong> &mdash; watch text stream per-step in real-time with live progress trackers and pause/cancel options.</li>
          <li><strong>Multi-Format Export</strong> &mdash; export finalized reports to PDF, DOCX, Markdown, or directly publish to a Google Doc.</li>
        </Bullets>
        <Diagram><AgentDag /></Diagram>
      </div>
    ),
  },
];

// ── CTD 2.7.2 ────────────────────────────────────────────────────────────────
export const SCT272_STEPS: TutorialStep[] = [
  {
    id: 'ctd-what',
    title: 'What CTD 2.7.2 is',
    icon: <FileSignature className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>CTD&nbsp;2.7.2 is a guided wizard for drafting the <strong>Summary of Clinical Pharmacology</strong> regulatory section. It matches your clinical studies to report templates and assembles a structured, resumable report.</P>
        <P className="text-gray-500">You&rsquo;ll need an active project and to be signed in. Opening <Pill>CTD&nbsp;2.7.2</Pill> launches the Report Creation wizard.</P>
        <Diagram><Ctd272Pipeline /></Diagram>
      </div>
    ),
  },
  {
    id: 'ctd-session',
    title: 'Start a session &amp; corpus',
    icon: <FolderPlus className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>Name a new session, then choose a clinical study corpus:</P>
        <Bullets>
          <li><strong>New</strong> &mdash; pick study PDFs from Drive to build a corpus.</li>
          <li><strong>Existing</strong> &mdash; reuse a previously created corpus.</li>
        </Bullets>
        <P className="text-gray-500">Corpus building is an async job; watch the processing view before moving on. Your session is saved to the project&rsquo;s Drive folder so it can be resumed.</P>
      </div>
    ),
  },
  {
    id: 'ctd-match',
    title: 'Match studies to templates',
    icon: <ListChecks className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>The matching screen lists every extracted study with an auto-matched template, protocol number, title and keywords.</P>
        <Bullets>
          <li>Override the template per study and add your own input/notes.</li>
          <li>Check / uncheck studies to include or exclude them.</li>
          <li>Your inputs autosave as you type and are restored when you resume.</li>
        </Bullets>
      </div>
    ),
  },
  {
    id: 'ctd-bio',
    title: 'Biomaterial data',
    icon: <FlaskRound className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>If a template needs a biomaterial summary (HB table), select or create a biomaterial corpus and assign each file to the right subsection.</P>
        <P>If it doesn&rsquo;t apply, click <strong>Skip Biomaterial</strong> &mdash; otherwise the wizard blocks saving until biomaterial documents are provided.</P>
      </div>
    ),
  },
  {
    id: 'ctd-sections',
    title: 'Fill the sections',
    icon: <FileText className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P>Work through <strong>Section&nbsp;3</strong> (study summaries) and <strong>Section&nbsp;1</strong> (general principles). Each step shows a template instruction, keywords and a text area.</P>
        <Bullets>
          <li>All text autosaves to Drive as you edit.</li>
          <li>Use <strong>Back</strong> / <strong>Next</strong> to move between steps; you can loop back to matching.</li>
        </Bullets>
      </div>
    ),
  },
  {
    id: 'ctd-save',
    title: 'Save &amp; resume',
    icon: <Save className="w-5 h-5" />,
    content: (
      <div className="space-y-3">
        <P><strong>Save &amp; Finish</strong> validates that every step has an instruction, then generates a report agent in your project&rsquo;s Agents folder, structured by section.</P>
        <P>Reopen the wizard and choose <Pill><RotateCcw className="w-3 h-3 inline mr-0.5" />Load Existing Session</Pill> to resume &mdash; matched studies and all text are rehydrated automatically. Delete removes a session manifest.</P>
      </div>
    ),
  },
];

// ── Registry ─────────────────────────────────────────────────────────────────
export type TutorialSectionKey =
  | 'home' | 'projects' | 'addData' | 'agentBuilder' | 'validation' | 'sct272';

export const SECTION_TUTORIALS: Record<TutorialSectionKey, { steps: TutorialStep[]; ariaKey: string }> = {
  home: { steps: HOME_STEPS, ariaKey: 'nav.faqAria.home' },
  projects: { steps: PROJECTS_STEPS, ariaKey: 'nav.faqAria.projects' },
  addData: { steps: ADD_DATA_STEPS, ariaKey: 'nav.faqAria.addData' },
  agentBuilder: { steps: AGENT_STEPS, ariaKey: 'nav.faqAria.agentBuilder' },
  validation: { steps: VALIDATION_STEPS, ariaKey: 'nav.faqAria.validation' },
  sct272: { steps: SCT272_STEPS, ariaKey: 'nav.faqAria.sct272' },
};
