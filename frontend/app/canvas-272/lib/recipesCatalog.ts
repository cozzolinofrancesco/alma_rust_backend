
export type StepCategory = 'step' | 'import' | 'output' | 'actions' | 'flow';

export interface RecipeStep {
  label: string;
  category: StepCategory;
  featured?: boolean;
  col?: number;
  lane?: number;
}

export interface RecipeEdge {
  from: number;
  to: number;
}

export interface Recipe {
  id: string;
  name: string;
  description: string;
  featuredLabel: string;
  featuredCategory: StepCategory;
  steps: RecipeStep[];
  edges?: RecipeEdge[];
  wip?: boolean;
}

export const RECIPES: Recipe[] = [
  {
    id: 'training-cer-literature-search',
    name: 'CER Literature Search',
    description: 'Learn to build a CER literature pipeline: import references from a database, extract structured data, appraise study quality, then synthesise findings into a summary section.',
    featuredLabel: 'CER • MEDDEV 2.7/1',
    featuredCategory: 'import',
    wip: true,
    steps: [
      { label: 'Import references', category: 'import', featured: true },
      { label: 'Extract study data', category: 'step' },
      { label: 'Appraise quality', category: 'step' },
      { label: 'Synthesise findings', category: 'output' },
    ],
  },

  {
    id: 'training-benefit-risk-assessment',
    name: 'Benefit-Risk Assessment',
    description: 'Walk through a structured benefit-risk workflow per MEDDEV 2.7/1 Rev 4: define the scope and intended purpose, analyse clinical performance evidence, evaluate safety data, then draft the benefit-risk balance statement.',
    featuredLabel: 'B-R • Annex XIV',
    featuredCategory: 'step',
    wip: true,
    steps: [
      { label: 'Define scope & purpose', category: 'step', featured: true },
      { label: 'Analyse clinical performance', category: 'step' },
      { label: 'Evaluate safety data', category: 'step' },
      { label: 'Draft B-R statement', category: 'output' },
    ],
  },

  {
    id: 'training-state-of-the-art',
    name: 'State of the Art Review',
    description: 'Build a state-of-the-art (SOTA) section: search relevant standards and guidelines, extract key requirements, compare to the device under evaluation, then draft the SOTA narrative.',
    featuredLabel: 'SOTA • EN ISO 14971',
    featuredCategory: 'import',
    wip: true,
    steps: [
      { label: 'Search standards & guidelines', category: 'import', featured: true },
      { label: 'Extract key requirements', category: 'step' },
      { label: 'Compare to device', category: 'step' },
      { label: 'Draft SOTA section', category: 'output' },
    ],
  },

  {
    id: 'training-pmcf-plan-outline',
    name: 'PMCF Plan Outline',
    description: 'Create a Post-Market Clinical Follow-Up plan outline per EU MDR Annex XIV Part B: define PMCF objectives tied to residual risks, identify clinical data gaps, design follow-up methods, then draft the PMCF plan.',
    featuredLabel: 'PMCF • MDR Annex XIV',
    featuredCategory: 'step',
    wip: true,
    steps: [
      { label: 'Define PMCF objectives', category: 'step', featured: true },
      { label: 'Identify data gaps', category: 'step' },
      { label: 'Design follow-up methods', category: 'step' },
      { label: 'Draft PMCF plan', category: 'output' },
    ],
  },

  {
    id: 'training-regulatory-gap-analysis',
    name: 'Regulatory Gap Analysis',
    description: 'Run a GSPR conformity gap analysis: load the General Safety and Performance Requirements checklist, map existing technical and clinical evidence to each requirement, flag unmet items, then draft an action plan.',
    featuredLabel: 'GSPR • MDR Annex I',
    featuredCategory: 'flow',
    wip: true,
    steps: [
      { label: 'Load GSPR checklist', category: 'import', featured: true },
      { label: 'Map existing evidence', category: 'step' },
      { label: 'Flag missing items', category: 'flow' },
      { label: 'Draft action plan', category: 'output' },
    ],
  },

  {
    id: 'sales-report-digest',
    name: 'Daily Sales Digest',
    description: 'Pull yesterday\'s sales from the database, analyse key trends, draft a report, and email it to the team.',
    featuredLabel: 'DB → Email',
    featuredCategory: 'import',
    steps: [
      { label: 'Fetch sales data', category: 'import', featured: true },
      { label: 'Analyse trends', category: 'step' },
      { label: 'Draft report', category: 'step' },
      { label: 'Email to team', category: 'actions' },
    ],
  },

  {
    id: 'smart-db-alert',
    name: 'Smart DB Alert',
    description: 'Query the database for anomalies, route on severity: send an urgent email for high-severity issues, silently log everything else.',
    featuredLabel: 'Conditional route',
    featuredCategory: 'flow',
    steps: [
      { label: 'Query database',     category: 'import', col: 0, lane: 0 },
      { label: 'Detect anomalies',   category: 'step',   col: 1, lane: 0 },
      { label: 'Route on severity',  category: 'flow',   col: 2, lane: 0, featured: true },
      { label: 'Send email alert',   category: 'actions',col: 3, lane: -1 },
      { label: 'Log silently',       category: 'step',   col: 3, lane: 1 },
    ],
    edges: [
      { from: 0, to: 1 },
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 2, to: 4 },
    ],
  },

  {
    id: 'competitor-monitor',
    name: 'Competitor Monitor',
    description: 'Scrape competitor pages, fan out to analyse pricing and features in parallel, merge the results, then alert the team if changes are detected.',
    featuredLabel: 'Parallel split',
    featuredCategory: 'flow',
    steps: [
      { label: 'Search competitor pages', category: 'import', col: 0, lane: 0 },
      { label: 'Parallel split',          category: 'flow',   col: 1, lane: 0, featured: true },
      { label: 'Analyse pricing',         category: 'step',   col: 2, lane: -1 },
      { label: 'Analyse features',        category: 'step',   col: 2, lane: 1 },
      { label: 'Merge findings',          category: 'step',   col: 3, lane: 0 },
      { label: 'Send alert email',        category: 'actions',col: 4, lane: 0 },
    ],
    edges: [
      { from: 0, to: 1 },
      { from: 1, to: 2 },
      { from: 1, to: 3 },
      { from: 2, to: 4 },
      { from: 3, to: 4 },
      { from: 4, to: 5 },
    ],
  },

  {
    id: 'doc-approval',
    name: 'Document Approval',
    description: 'Draft a document, put it through an AI review, pause at a quality gate for human sign-off, then publish or send back for revision.',
    featuredLabel: 'Quality gate',
    featuredCategory: 'flow',
    steps: [
      { label: 'Draft document',      category: 'step',   col: 0, lane: 0 },
      { label: 'AI review',           category: 'step',   col: 1, lane: 0 },
      { label: 'Quality gate',        category: 'flow',   col: 2, lane: 0, featured: true },
      { label: 'Publish document',    category: 'output', col: 3, lane: -1 },
      { label: 'Send back for revision', category: 'step',col: 3, lane: 1 },
    ],
    edges: [
      { from: 0, to: 1 },
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 2, to: 4 },
    ],
  },

  {
    id: 'api-live-monitor',
    name: 'API Live Monitor',
    description: 'Poll an external API endpoint for live metrics, transform the payload, route on threshold: store normally in SQL or fire an alert email when limits are breached.',
    featuredLabel: 'API endpoint',
    featuredCategory: 'actions',
    steps: [
      { label: 'Call API endpoint',    category: 'actions', col: 0, lane: 0, featured: true },
      { label: 'Transform payload',    category: 'step',    col: 1, lane: 0 },
      { label: 'Route on threshold',   category: 'flow',    col: 2, lane: 0 },
      { label: 'Write to database',    category: 'output',  col: 3, lane: -1 },
      { label: 'Send alert email',     category: 'actions', col: 3, lane: 1 },
    ],
    edges: [
      { from: 0, to: 1 },
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 2, to: 4 },
    ],
  },

  {
    id: 'clinical-data-review',
    name: 'Clinical Data Review',
    description: 'Load trial data, run efficacy and safety analyses in parallel, merge results, then pass through a quality gate before exporting the final report.',
    featuredLabel: 'Parallel + gate',
    featuredCategory: 'flow',
    steps: [
      { label: 'Load trial data',    category: 'import', col: 0, lane: 0 },
      { label: 'Parallel split',     category: 'flow',   col: 1, lane: 0, featured: true },
      { label: 'Efficacy analysis',  category: 'step',   col: 2, lane: -1 },
      { label: 'Safety analysis',    category: 'step',   col: 2, lane: 1 },
      { label: 'Merge results',      category: 'step',   col: 3, lane: 0 },
      { label: 'Quality gate',       category: 'flow',   col: 4, lane: 0 },
      { label: 'Export report',      category: 'output', col: 5, lane: 0 },
    ],
    edges: [
      { from: 0, to: 1 },
      { from: 1, to: 2 },
      { from: 1, to: 3 },
      { from: 2, to: 4 },
      { from: 3, to: 4 },
      { from: 4, to: 5 },
      { from: 5, to: 6 },
    ],
  },

  {
    id: 'code-review-gate',
    name: 'Code Review & Gate',
    description: 'Import a GitHub branch, AI-review the code quality, pause at a quality gate for human approval, then either merge and push or request changes.',
    featuredLabel: 'GitHub → gate',
    featuredCategory: 'import',
    steps: [
      { label: 'Import from GitHub',   category: 'import', col: 0, lane: 0, featured: true },
      { label: 'AI code review',       category: 'step',   col: 1, lane: 0 },
      { label: 'Quality gate',         category: 'flow',   col: 2, lane: 0 },
      { label: 'Merge & push',         category: 'output', col: 3, lane: -1 },
      { label: 'Request changes',      category: 'step',   col: 3, lane: 1 },
    ],
    edges: [
      { from: 0, to: 1 },
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 2, to: 4 },
    ],
  },

  {
    id: 'research-briefing',
    name: 'Research Briefing',
    description: 'A researcher queries the knowledge base and the web in parallel, synthesises findings, then fans out to save a brief to Drive and email stakeholders simultaneously.',
    featuredLabel: 'Multi-source',
    featuredCategory: 'import',
    steps: [
      { label: 'Search knowledge base', category: 'import', col: 0, lane: -1 },
      { label: 'Search online',         category: 'import', col: 0, lane: 1, featured: true },
      { label: 'Synthesise findings',   category: 'step',   col: 1, lane: 0 },
      { label: 'Save brief to Drive',   category: 'output', col: 2, lane: -1 },
      { label: 'Email stakeholders',    category: 'actions',col: 2, lane: 1 },
    ],
    edges: [
      { from: 0, to: 2 },
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 2, to: 4 },
    ],
  },

  {
    id: 'multi-agent-research',
    name: 'Multi-Agent Research',
    description: 'Search the web for raw material, hand off to a specialist analyst agent, merge the deep-analysis response, and store the result in the knowledge base.',
    featuredLabel: 'Agent handoff',
    featuredCategory: 'actions',
    steps: [
      { label: 'Search online',          category: 'import'  },
      { label: 'Pre-process data',       category: 'step'    },
      { label: 'Send to analyst agent',  category: 'actions', featured: true },
      { label: 'Merge findings',         category: 'step'    },
      { label: 'Update knowledge base',  category: 'output'  },
    ],
  },

  {
    id: 'ci-failure-triage',
    name: 'CI Failure Triage',
    description: 'Import a failed GitLab pipeline, diagnose the root cause, draft a fix, then fan out to post to Confluence and email the team at the same time.',
    featuredLabel: 'GitLab → fan-out',
    featuredCategory: 'import',
    steps: [
      { label: 'Import GitLab CI run',  category: 'import', col: 0, lane: 0, featured: true },
      { label: 'Diagnose failure',      category: 'step',   col: 1, lane: 0 },
      { label: 'Draft fix suggestion',  category: 'step',   col: 2, lane: 0 },
      { label: 'Post to Confluence',    category: 'output', col: 3, lane: -1 },
      { label: 'Email team',            category: 'actions',col: 3, lane: 1 },
    ],
    edges: [
      { from: 0, to: 1 },
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 2, to: 4 },
    ],
  },
];

export type RecipeTranslateFn = (key: string, vars?: Record<string, string | number>) => string;

export function localizeRecipes(t: RecipeTranslateFn): Recipe[] {
  return RECIPES.map((recipe) => {
    const base = `canvas272Page.recipes.byId.${recipe.id}`;
    return {
      ...recipe,
      name: t(`${base}.name`),
      description: t(`${base}.description`),
      featuredLabel: t(`${base}.featuredLabel`),
      steps: recipe.steps.map((step, i) => ({
        ...step,
        label: t(`${base}.step${i}`),
      })),
    };
  });
}
