"use client";

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useModels } from '../../hooks/useModels';
import { createPortal } from 'react-dom';
import { FaTimes, FaPlus } from 'react-icons/fa';
import { useRouter } from 'next/navigation';
import { DEFAULT_MODEL, isValidModel } from '../../lib/modelConfig';
import type { AgentData } from '../../lib/agentGenerationSchema';

type ChatRole = 'assistant' | 'user';
type ChatMsg = { role: ChatRole; text: string };

type Stage =
  | 'goal'
  | 'usesDocs'
  | 'docPaths'
  | 'docTypes'
  | 'stepCount'
  | 'dependencyStyle'
  | 'customDependencies'
  | 'defaultModel'
  | 'constraints'
  | 'agentName'
  | 'confirm'
  | 'generated';

type DependencyStyle = 'linear' | 'independent' | 'custom';

export interface AIAssistCreateAgentModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  onSaved?: () => void;
}

type MaybeBool = boolean | null;

function parseMultilineList(input: string): string[] {
  return input
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function parseCustomDeps(input: string): Record<string, number[]> {
  const lines = parseMultilineList(input);
  const out: Record<string, number[]> = {};
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\s*(?:->|depends on|depends)\s*(.*)$/i);
    if (!m) continue;
    const step = m[1];
    const rhs = m[2] || '';
    const nums = rhs
      .split(/[, ]+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => parseInt(x, 10))
      .filter((x) => Number.isFinite(x) && x >= 1);
    out[step] = Array.from(new Set(nums));
  }
  return out;
}

function getDocLabel(doc: string): string {
  const trimmed = (doc || '').trim();
  if (!trimmed) return '';
  const normalized = trimmed.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : trimmed;
}

function buildConfirmationSummary(opts: {
  agentName: string;
  stepCount: number;
  stepNames: string[];
  stepTasks: string[];
  documentPaths: string[];
  planDocAssignments: Record<string, number[]>;
  dependencyStyle: 'linear' | 'independent' | 'custom';
  customDepsText: string;
  defaultModel: string;
}): string {
  const {
    agentName,
    stepCount,
    stepNames,
    stepTasks,
    documentPaths,
    planDocAssignments,
    dependencyStyle,
    customDepsText,
    defaultModel } = opts;

  const lines: string[] = [];
  
  lines.push(`╔════════════════════════════════════════════════════════╗`);
  lines.push(`║  📋 AGENT CREATION SUMMARY                             ║`);
  lines.push(`╚════════════════════════════════════════════════════════╝`);
  lines.push(``);
  lines.push(`🏷️  Agent Name: "${agentName || 'TBD'}"`);
  lines.push(`📊  Steps: ${stepCount}`);
  lines.push(`🤖  Model: ${defaultModel}`);
  lines.push(``);

  lines.push(`┌─────────────────────────────────────────────────────────┐`);
  lines.push(`│ STEPS                                                   │`);
  lines.push(`├─────────────────────────────────────────────────────────┤`);
  
  for (let i = 0; i < stepCount; i++) {
    const name = stepNames[i] || `Step ${i + 1}`;
    const task = stepTasks[i] || '(task will be generated)';
    const shortTask = task.length > 45 ? task.substring(0, 42) + '...' : task;
    lines.push(`│ [${i + 1}] ${name.padEnd(20)} │`);
    lines.push(`│     └─ ${shortTask.padEnd(47)} │`);
  }
  lines.push(`└─────────────────────────────────────────────────────────┘`);
  lines.push(``);

  lines.push(`┌─────────────────────────────────────────────────────────┐`);
  lines.push(`│ STEP DEPENDENCIES (${dependencyStyle.toUpperCase()})`.padEnd(58) + `│`);
  lines.push(`├─────────────────────────────────────────────────────────┤`);
  
  const customDeps = dependencyStyle === 'custom' ? parseCustomDeps(customDepsText) : {};
  
  if (stepCount <= 8) {
    let diagramLine = '│ ';
    for (let i = 1; i <= stepCount; i++) {
      diagramLine += `[${i}]`;
      if (i < stepCount) {
        if (dependencyStyle === 'linear') {
          diagramLine += ' ──► ';
        } else if (dependencyStyle === 'independent') {
          diagramLine += '  ';
        } else {
          const nextDeps = customDeps[String(i + 1)] || [];
          diagramLine += nextDeps.includes(i) ? ' ──► ' : '  ';
        }
      }
    }
    lines.push(diagramLine.padEnd(58) + '│');
    
    if (dependencyStyle === 'independent') {
      lines.push(`│     (all steps run independently)`.padEnd(58) + `│`);
    }
  } else {
    if (dependencyStyle === 'linear') {
      lines.push(`│ [1] → [2] → [3] → ... → [${stepCount}]`.padEnd(58) + `│`);
    } else if (dependencyStyle === 'independent') {
      lines.push(`│ All ${stepCount} steps run independently (no dependencies)`.padEnd(58) + `│`);
    } else {
      lines.push(`│ Custom dependencies:`.padEnd(58) + `│`);
      Object.entries(customDeps).slice(0, 3).forEach(([step, deps]) => {
        lines.push(`│   Step ${step} depends on: ${deps.join(', ')}`.padEnd(58) + `│`);
      });
      if (Object.keys(customDeps).length > 3) {
        lines.push(`│   ... and ${Object.keys(customDeps).length - 3} more`.padEnd(58) + `│`);
      }
    }
  }
  lines.push(`└─────────────────────────────────────────────────────────┘`);
  lines.push(``);

  if (documentPaths.length > 0) {
    lines.push(`┌─────────────────────────────────────────────────────────┐`);
    lines.push(`│ 📁 BIBLIOGRAPHY (${documentPaths.length} files)`.padEnd(58) + `│`);
    lines.push(`├─────────────────────────────────────────────────────────┤`);
    
    const docsByStep: Record<number, string[]> = {};
    const unassignedDocs: string[] = [];
    
    documentPaths.forEach((doc, idx) => {
      let assigned = false;
      Object.entries(planDocAssignments).forEach(([docPath, stepIndices]) => {
        if (docPath === doc || getDocLabel(docPath) === getDocLabel(doc)) {
          stepIndices.forEach(stepIdx => {
            if (!docsByStep[stepIdx]) docsByStep[stepIdx] = [];
            docsByStep[stepIdx].push(getDocLabel(doc));
            assigned = true;
          });
        }
      });
      
      if (!assigned) {
        const stepIdx = idx + 1;
        if (stepIdx <= stepCount) {
          if (!docsByStep[stepIdx]) docsByStep[stepIdx] = [];
          docsByStep[stepIdx].push(getDocLabel(doc));
        } else {
          unassignedDocs.push(getDocLabel(doc));
        }
      }
    });
    
    Object.entries(docsByStep).forEach(([stepIdx, docs]) => {
      docs.forEach(doc => {
        const shortDoc = doc.length > 40 ? doc.substring(0, 37) + '...' : doc;
        lines.push(`│ Step ${stepIdx}: 📄 ${shortDoc}`.padEnd(58) + `│`);
      });
    });
    
    if (unassignedDocs.length > 0) {
      lines.push(`│ Unassigned:`.padEnd(58) + `│`);
      unassignedDocs.forEach(doc => {
        const shortDoc = doc.length > 40 ? doc.substring(0, 37) + '...' : doc;
        lines.push(`│   📄 ${shortDoc}`.padEnd(58) + `│`);
      });
    }
    
    lines.push(`└─────────────────────────────────────────────────────────┘`);
  } else {
    lines.push(`📚 Bibliography: No files attached`);
  }
  
  lines.push(``);
  lines.push(`═════════════════════════════════════════════════════════`);
  lines.push(`Does this look correct? Reply "yes" to generate, or describe changes.`);
  
  return lines.join('\n');
}

export default function AIAssistCreateAgentModal({ isOpen, onClose, projectId, onSaved }: AIAssistCreateAgentModalProps) {
    const models = useModels();
  const router = useRouter();
  const [portalEl, setPortalEl] = useState<HTMLElement | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [stage, setStage] = useState<Stage>('goal');
  const [input, setInput] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftAgent, setDraftAgent] = useState<AgentData | null>(null);
  const [rawPreview, setRawPreview] = useState<string>('');
  const [previewMode, setPreviewMode] = useState<'steps' | 'json'>('steps');
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  const [goal, setGoal] = useState('');
  const [outputExample, setOutputExample] = useState('');
  const [usesDocuments, setUsesDocuments] = useState<MaybeBool>(null);
  const [documentPaths, setDocumentPaths] = useState<string[]>([]);
  const [documentTypes, setDocumentTypes] = useState<string[]>([]);
  const [planDocumentAssignments, setPlanDocumentAssignments] = useState<Record<string, number[]>>({});
  const [documentAssignments, setDocumentAssignments] = useState<Record<string, string[]>>({});
  const [stepCount, setStepCount] = useState<number | null>(null);
  const [stepNames, setStepNames] = useState<string[]>([]);
  const [stepTasks, setStepTasks] = useState<string[]>([]);
  const [stepModels, setStepModels] = useState<string[]>([]);
  const [dependencyStyle, setDependencyStyle] = useState<DependencyStyle | null>(null);
  const [customDependenciesText, setCustomDependenciesText] = useState('');
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [constraints, setConstraints] = useState('');
  const [agentNameHint, setAgentNameHint] = useState('');

  const [modalWidth, setModalWidth] = useState(1400);
  const [modalHeight, setModalHeight] = useState(850);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  
  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const resetAll = () => {
    setMessages([]);
    setStage('goal');
    setInput('');
    setIsBusy(false);
    setError(null);
    setDraftAgent(null);
    setRawPreview('');
    setPreviewMode('steps');

    setGoal('');
    setOutputExample('');
    setUsesDocuments(null);
    setDocumentPaths([]);
    setDocumentTypes([]);
    setPlanDocumentAssignments({});
    setDocumentAssignments({});
    setStepCount(null);
    setStepNames([]);
    setStepTasks([]);
    setStepModels([]);
    setDependencyStyle(null);
    setCustomDependenciesText('');
    setDefaultModel(null);
    setConstraints('');
    setAgentNameHint('');
    setShowCloseConfirm(false);
  };

  const normalizeModelInput = (raw: string | null | undefined) => {
    const v = (raw || '').trim();
    if (!v) return DEFAULT_MODEL;
    if (v.toLowerCase() === 'default') return DEFAULT_MODEL;
    if (isValidModel(v)) return v;
    return DEFAULT_MODEL;
  };

  const promptForStage = useMemo((): string => {
    switch (stage) {
      case 'goal':
        return [
          `Tell me what agent you'd like to create. Be as detailed as you want!`,
          ``,
          `Examples:`,
          `• "Create a 5-step analysis where step 3 depends on step 1. Name the steps: Roberto, Marco, Luca, Andrea, Paolo. Each step prints a random Italian name. Use Flash model for all except the last which uses Pro."`,
          `• "Build an agent with 3 steps to analyze research papers. Attach Study_001.pdf and Study_002.pdf from C:\\Documents\\"`,
          `• "Make a simple 2-step agent: first extract key points, then summarize"`,
          ``,
          `I'll extract all the details (steps, dependencies, models, files) and show you a summary before generating!`,
        ].join('\n');
      case 'agentName':
        return `What should we name this agent?`;
      case 'confirm':
        return `Review the summary above. Reply "yes" to generate, or describe any changes you'd like.`;
      case 'generated':
        return `Agent ready! You can now:\n• Ask me to refine it (e.g., "add a step", "change step 2 to use Pro model")\n• Click "Save Agent" to save and open the editor`;
      default:
        return `Continue.`;
    }
  }, [stage]);

  const pushAssistant = (text: string) => setMessages((prev) => [...prev, { role: 'assistant', text }]);
  const pushUser = (text: string) => setMessages((prev) => [...prev, { role: 'user', text }]);

  useEffect(() => {
    if (typeof window !== 'undefined') setPortalEl(document.body);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    resetAll();
    pushAssistant(`Welcome! Let's create your agent.`);
    pushAssistant(promptForStage);

  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [isOpen, messages.length]);

  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  const promptForStageFor = (s: Stage): string => {
    switch (s) {
      case 'goal':
        return [
          `Tell me what agent you'd like to create. Be as detailed as you want!`,
          ``,
          `Examples:`,
          `• "Create a 5-step analysis where step 3 depends on step 1. Name the steps: Roberto, Marco, Luca, Andrea, Paolo. Each step prints a random Italian name. Use Flash model for all except the last which uses Pro."`,
          `• "Build an agent with 3 steps to analyze research papers. Attach Study_001.pdf and Study_002.pdf from C:\\Documents\\"`,
          `• "Make a simple 2-step agent: first extract key points, then summarize"`,
          ``,
          `I'll extract all the details (steps, dependencies, models, files) and show you a summary before generating!`,
        ].join('\n');
      case 'agentName':
        return `What should we name this agent?`;
      case 'confirm':
        return `Review the summary above. Reply "yes" to generate, or describe any changes you'd like.`;
      case 'generated':
        return `Agent ready! You can now:\n• Ask me to refine it (e.g., "add a step", "change step 2 to use Pro model")\n• Click "Save Agent" to save and open the editor`;
      default:
        return `Continue.`;
    }
  };

  const handleSend = async () => {
    if (isBusy) return;
    const text = input.trim();
    if (!text) return;

    setError(null);
    pushUser(text);
    setInput('');

    if (stage === 'goal') {
      const cleanedText = text;
      
      setIsBusy(true);
      pushAssistant(`Analyzing your request...`);
      try {
        const res = await fetch('/api/ai-agents/plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: cleanedText }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error((data as { error?: string })?.error || `Plan failed (${res.status})`);
        }

        const plan = (data as { plan?: Record<string, unknown> }).plan || {};
        const plannedGoal = (typeof plan.goal === 'string' && plan.goal.trim()) ? plan.goal : text;
        setGoal(plannedGoal);

        if (typeof plan.outputExample === 'string') setOutputExample(plan.outputExample);
        if (typeof plan.constraints === 'string') setConstraints(plan.constraints);
        if (typeof plan.agentNameHint === 'string') setAgentNameHint(plan.agentNameHint);

        const extractedPaths = Array.isArray(plan.documentPaths) ? plan.documentPaths as string[] : [];
        if (extractedPaths.length > 0) {
          setDocumentPaths(extractedPaths);
          setUsesDocuments(true);
        }
        if (Array.isArray(plan.documentTypes) && plan.documentTypes.length > 0) {
          setDocumentTypes(plan.documentTypes as string[]);
        }
        if (typeof plan.usesDocuments === 'boolean') {
          setUsesDocuments(plan.usesDocuments);
        }
        const extractedDocAssignments = (plan.documentAssignments && typeof plan.documentAssignments === 'object') 
          ? plan.documentAssignments as Record<string, number[]> 
          : {};
        if (Object.keys(extractedDocAssignments).length > 0) {
          setPlanDocumentAssignments(extractedDocAssignments);
        }

        const extractedStepCount = typeof plan.stepCount === 'number' ? plan.stepCount : 3;
        const extractedStepNames = Array.isArray(plan.stepNames) ? plan.stepNames as string[] : [];
        const extractedStepTasks = Array.isArray(plan.stepTasks) ? plan.stepTasks as string[] : [];
        
        setStepCount(extractedStepCount);
        if (extractedStepNames.length > 0) setStepNames(extractedStepNames);
        if (extractedStepTasks.length > 0) setStepTasks(extractedStepTasks);
        if (Array.isArray(plan.stepModels)) setStepModels(plan.stepModels as string[]);
        
        const extractedDepStyle = (typeof plan.dependencyStyle === 'string' ? plan.dependencyStyle : 'linear') as DependencyStyle;
        setDependencyStyle(extractedDepStyle);
        
        const extractedCustomDeps = typeof plan.customDependenciesText === 'string' ? plan.customDependenciesText : '';
        if (extractedCustomDeps) setCustomDependenciesText(extractedCustomDeps);

        const extractedModel = typeof plan.defaultModel === 'string' ? plan.defaultModel : DEFAULT_MODEL;
        setDefaultModel(extractedModel);

        const extractedName = typeof plan.agentNameHint === 'string' ? plan.agentNameHint : '';
        
        if (!extractedName.trim()) {
        setStage('agentName');
        pushAssistant(promptForStageFor('agentName'));
          return;
        }
        
        setAgentNameHint(extractedName);

        const summary = buildConfirmationSummary({
          agentName: extractedName,
          stepCount: extractedStepCount,
          stepNames: extractedStepNames,
          stepTasks: extractedStepTasks,
          documentPaths: extractedPaths,
          planDocAssignments: extractedDocAssignments,
          dependencyStyle: extractedDepStyle,
          customDepsText: extractedCustomDeps,
          defaultModel: extractedModel });
        
        pushAssistant(summary);
        setStage('confirm');
        
      } catch {
        setGoal(text);
        setStage('agentName');
        pushAssistant(`Got it! What should we name this agent?`);
      } finally {
        setIsBusy(false);
      }
      return;
    }

    if (stage === 'agentName') {
      setAgentNameHint(text);
      
      const effectiveStepCount = stepCount ?? 3;
      const effectiveDepStyle = dependencyStyle ?? 'linear';
      const effectiveModel = normalizeModelInput(defaultModel);
      
      const summary = buildConfirmationSummary({
        agentName: text,
        stepCount: effectiveStepCount,
        stepNames: stepNames,
        stepTasks: stepTasks,
        documentPaths: documentPaths,
        planDocAssignments: planDocumentAssignments,
        dependencyStyle: effectiveDepStyle,
        customDepsText: customDependenciesText,
        defaultModel: effectiveModel });
      
      pushAssistant(summary);
      setStage('confirm');
      return;
    }

    if (stage === 'confirm') {
      const lower = text.toLowerCase().trim();
      const isConfirm = lower === 'yes' || lower === 'y' || lower === 'ok' || lower === 'confirm' || 
                        lower === 'looks good' || lower === 'correct' || lower === 'go ahead' ||
                        lower.includes('yes') || lower.includes('correct') || lower.includes('generate');
      
      if (isConfirm) {
        pushAssistant(`Great! Generating your agent...`);
        
        const confirmationContext = [
          `CONFIRMED PLAN:`,
          `- Agent Name: ${agentNameHint}`,
          `- Steps: ${stepCount}`,
          `- Step Names: ${stepNames.join(', ') || '(auto-generate)'}`,
          `- Dependencies: ${dependencyStyle}`,
          `- Bibliography: ${documentPaths.length} files`,
          documentPaths.length > 0 ? `- Files: ${documentPaths.map(d => getDocLabel(d)).join(', ')}` : '',
        ].filter(Boolean).join('\n');
        
        await runGenerate({ confirmationContext });
      } else {
        pushAssistant(`Got it! I'll update based on your feedback. What would you like to change?`);
        
        setGoal(`${goal}\n\nUser refinement: ${text}`);
        setStage('goal');
        handleSend();
      }
      return;
    }

    if (stage === 'generated') {
      await refineAgent(text);
      return;
    }
  };

  const validateAndCorrect = async (
    agent: AgentData,
    payload: {
      goal: string;
      outputExample?: string;
      usesDocuments?: boolean | null;
      documentPaths?: string[];
      documentTypes?: string[];
      documentAssignments?: Record<string, number[]>;
      stepCount?: number | null;
      stepNames?: string[];
      stepTasks?: string[];
      stepModels?: string[];
      dependencyStyle?: DependencyStyle | null;
      customDependencies?: Record<string, number[]>;
      defaultModel?: string | null;
      constraints?: string | null;
      agentNameHint?: string | null;
    },
    effectiveStepCount: number,
    effectiveGoal: string
  ): Promise<AgentData> => {
    const actualSteps = agent.layers.length;
    const requestedSteps = effectiveStepCount;
    const requestedNames = stepNames.length > 0 ? stepNames : [];
    const requestedDocs = documentPaths.length;
    const attachedDocs = agent.layers.filter(l => l.bibliography && l.bibliography.length > 0).length;
    
    const layersWithEmptyUserInstruction = agent.layers.filter(l => !l.userInstruction || l.userInstruction.trim() === '');

    const summary = [
      `\n📋 Quality Check:`,
      `• Steps: ${actualSteps}/${requestedSteps} ${actualSteps === requestedSteps ? '✓' : '✗'}`,
    ];

    if (requestedNames.length > 0) {
      const actualNames = agent.layers.map(l => l.name);
      summary.push(`• Names: ${actualNames.join(', ')}`);
    }

    if (requestedDocs > 0) {
      summary.push(`• Bibliography: ${requestedDocs} requested, ${attachedDocs} attached ${attachedDocs >= requestedDocs ? '✓' : '✗'}`);
    }
    
    const hasFieldIssues = layersWithEmptyUserInstruction.length > 0;
    if (hasFieldIssues) {
      summary.push(`• Field mapping: ${layersWithEmptyUserInstruction.length} layer(s) missing userInstruction ✗`);
    } else {
      const layersWithUserInstruction = agent.layers.filter(l => l.userInstruction && l.userInstruction.trim() !== '').length;
      summary.push(`• Field mapping: ${layersWithUserInstruction}/${actualSteps} layers have userInstruction ✓`);
    }

    pushAssistant(summary.join('\n'));

    const needsCorrection = actualSteps !== requestedSteps || (requestedDocs > 0 && attachedDocs === 0) || hasFieldIssues;

    if (needsCorrection) {
      pushAssistant(`\n⚠️ Issues detected. Auto-correcting...`);

      const correctionInstructions = [];
      if (actualSteps !== requestedSteps) {
        correctionInstructions.push(`YOU MUST CREATE EXACTLY ${requestedSteps} STEPS (you only created ${actualSteps})`);
      }
      if (requestedNames.length > 0) {
        correctionInstructions.push(`Step names must be: ${requestedNames.join(', ')}`);
      }
      if (requestedDocs > 0 && attachedDocs === 0) {
        correctionInstructions.push(`Documents must be added to bibliography field of appropriate steps`);
      }
      if (hasFieldIssues) {
        correctionInstructions.push(`CRITICAL FIELD MAPPING: 
- "userInstruction" field MUST contain the main task (e.g., "Print a random Italian name." or "Draft a narrative...").
- "prompt" field should contain style/persona instructions (e.g., "You are an Expert Medical Writer...") or be empty.
- "userInput" field should be empty unless user provides specific data to process.
- ALWAYS put the task in userInstruction, NOT in userInput or prompt!`);
      }

      const correctedPayload = {
        ...payload,
        goal: `${effectiveGoal}\n\n${'='.repeat(50)}\nCRITICAL REQUIREMENTS:\n${correctionInstructions.map((i, idx) => `${idx + 1}. ${i}`).join('\n')}\n${'='.repeat(50)}` };

      const correctionRes = await fetch('/api/ai-agents/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(correctedPayload) });

      if (correctionRes.ok) {
        const correctedData = (await correctionRes.json()) as { agent: AgentData };
        const correctedSteps = correctedData.agent.layers.length;
        const correctedDocs = correctedData.agent.layers.filter(l => l.bibliography && l.bibliography.length > 0).length;
        const correctedUserInstructions = correctedData.agent.layers.filter(l => l.userInstruction && l.userInstruction.trim() !== '').length;

        pushAssistant(`\n✅ Corrected: ${correctedSteps} steps, ${correctedDocs} bibliography, ${correctedUserInstructions} with userInstruction`);
        return correctedData.agent;
      }
    } else {
      pushAssistant(`\n✅ Perfect! All requirements met.`);
    }

    return agent;
  };

  const runGenerate = async (opts?: { goalOverride?: string; confirmationContext?: string }) => {
    if (isBusy) return;
    const effectiveGoal = (opts?.goalOverride ?? goal).trim();
    if (!effectiveGoal) {
      pushAssistant(`Tell me what the agent should do first, then I can generate it.`);
      return;
    }

    const effectiveUsesDocs = usesDocuments === true;
    const effectiveStepCount = stepCount ?? 3;
    const effectiveDepStyle = dependencyStyle ?? 'linear';
    const effectiveModel = normalizeModelInput(defaultModel);

    setIsBusy(true);
    pushAssistant(`Generating agent...`);
    
    try {
      const goalWithContext = opts?.confirmationContext 
        ? `${effectiveGoal}\n\n${opts.confirmationContext}`
        : effectiveGoal;
      
      const payload = {
        goal: goalWithContext,
        outputExample: outputExample || undefined,
        usesDocuments: effectiveUsesDocs,
        documentPaths,
        documentTypes,
        documentAssignments: Object.keys(planDocumentAssignments).length > 0 ? planDocumentAssignments : undefined,
        stepCount: effectiveStepCount,
        stepNames: stepNames.length > 0 ? stepNames : undefined,
        stepTasks: stepTasks.length > 0 ? stepTasks : undefined,
        stepModels: stepModels.length > 0 ? stepModels : undefined,
        dependencyStyle: effectiveDepStyle,
        customDependencies: effectiveDepStyle === 'custom' ? parseCustomDeps(customDependenciesText) : undefined,
        defaultModel: effectiveModel,
        constraints: constraints || undefined,
        agentNameHint: agentNameHint || undefined };

      const res = await fetch('/api/ai-agents/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload) });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || `Generate failed (${res.status})`);
      }

      const data = (await res.json()) as { agent: AgentData };
      
      const finalAgent = await validateAndCorrect(data.agent, payload, effectiveStepCount, effectiveGoal);
      
      const syncedAssignments: Record<string, string[]> = {};
      finalAgent.layers.forEach((layer) => {
        if (layer.bibliography && layer.bibliography.length > 0) {
          syncedAssignments[layer.id] = layer.bibliography.map(b => b.path);
        } else {
          syncedAssignments[layer.id] = [];
        }
      });
      setDocumentAssignments(syncedAssignments);
      
      setDraftAgent(finalAgent);
      setRawPreview(JSON.stringify(finalAgent, null, 2));
      setStage('generated');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      pushAssistant(`Generation failed. Please try again or rephrase your request.`);
    } finally {
      setIsBusy(false);
    }
  };

  const refineAgent = async (refinementRequest: string) => {
    if (isBusy || !draftAgent) return;

    setIsBusy(true);
    pushAssistant(`Refining agent...`);
    try {
      const res = await fetch('/api/ai-agents/refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentAgent: draftAgent,
          refinementRequest,
          documentPaths }) });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || `Refinement failed (${res.status})`);
      }

      const data = (await res.json()) as { agent: AgentData; explanation?: string };
      
      const syncedAssignments: Record<string, string[]> = {};
      data.agent.layers.forEach((layer) => {
        if (layer.bibliography && layer.bibliography.length > 0) {
          syncedAssignments[layer.id] = layer.bibliography.map(b => b.path);
        } else {
          syncedAssignments[layer.id] = [];
        }
      });
      setDocumentAssignments(syncedAssignments);
      
      setDraftAgent(data.agent);
      setRawPreview(JSON.stringify(data.agent, null, 2));
      
      pushAssistant(data.explanation || `Updated! ✅ You can continue refining or save the agent.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      pushAssistant(`I couldn't apply that change. Please try rephrasing your request.`);
    } finally {
      setIsBusy(false);
    }
  };

  const handleSave = async () => {
    if (!draftAgent) return;
    if (!projectId) {
      setError('No project selected');
      return;
    }

    setIsBusy(true);
    setError(null);
    pushAssistant(`Saving agent to AF/ ...`);

    try {
      const { saveAgentWithVersioning } = await import('../../lib/versionUtils');
      const agentName = draftAgent.name || agentNameHint || 'New Agent';

      const agentToSave: AgentData = {
        ...draftAgent,
        name: agentName,
        metadata: {
          ...draftAgent.metadata,
          modified: new Date().toISOString() } };

      const result = await saveAgentWithVersioning(projectId, agentName, agentToSave);
      if (!result.success || !result.fileId) {
        throw new Error(result.error || 'Save failed');
      }

      pushAssistant(`Saved ✅ Opening editor...`);
      onSaved?.();
      onClose();
      router.push(`/ai-agents/edit/${encodeURIComponent(result.fileId)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      pushAssistant(`Save failed. Please try again.`);
    } finally {
      setIsBusy(false);
    }
  };

  const updateDraftAndPreview = (next: AgentData) => {
    setDraftAgent(next);
    setRawPreview(JSON.stringify(next, null, 2));
  };

  const applyDocsToAgent = (agent: AgentData, assignments: Record<string, string[]>) => {
    return {
      ...agent,
      layers: agent.layers.map((l) => {
        const docs = assignments[l.id] || [];
        if (!docs.length) return l;
        
        const bibliographyItems = docs.map((doc) => ({
          name: getDocLabel(doc),
          path: doc,
          type: 'file' as const,
          description: 'Document attached during agent creation' }));
        
        return { 
          ...l, 
          bibliography: bibliographyItems };
      }) };
  };

  const ensureDefaultAssignments = (agent: AgentData, docs: string[]) => {
    if (!agent.layers.length || !docs.length) return {};
    const existing = documentAssignments;
    if (Object.keys(existing).length) return existing;
    const out: Record<string, string[]> = {};
    agent.layers.forEach((l, idx) => {
      const doc = docs[idx];
      out[l.id] = doc ? [doc] : [];
    });
    return out;
  };

  useEffect(() => {
    if (!draftAgent) return;
    if (!documentPaths.length) return;
    const defaults = ensureDefaultAssignments(draftAgent, documentPaths);
    if (Object.keys(defaults).length && !Object.keys(documentAssignments).length) {
      setDocumentAssignments(defaults);
      updateDraftAndPreview(applyDocsToAgent(draftAgent, defaults));
    }

  }, [draftAgent, documentPaths]);

  const handleRenameStep = (layerId: string, name: string) => {
    if (!draftAgent) return;
    updateDraftAndPreview({
      ...draftAgent,
      layers: draftAgent.layers.map((l) => (l.id === layerId ? { ...l, name } : l)) });
  };

  const handleUpdateModel = (layerId: string, selectedModel: string) => {
    if (!draftAgent) return;
    updateDraftAndPreview({
      ...draftAgent,
      layers: draftAgent.layers.map((l) => (l.id === layerId ? { ...l, selectedModel } : l)) });
  };

  const handleUpdateUserInstruction = (layerId: string, userInstruction: string) => {
    if (!draftAgent) return;
    updateDraftAndPreview({
      ...draftAgent,
      layers: draftAgent.layers.map((l) => (l.id === layerId ? { 
        ...l, 
        userInstruction
      } : l)) });
  };

  const handleUpdateUserInput = (layerId: string, userInput: string) => {
    if (!draftAgent) return;
    updateDraftAndPreview({
      ...draftAgent,
      layers: draftAgent.layers.map((l) => (l.id === layerId ? { ...l, userInput } : l)) });
  };

  const handleToggleDependency = (layerId: string, dependsOnLayerId: string) => {
    if (!draftAgent) return;
    updateDraftAndPreview({
      ...draftAgent,
      layers: draftAgent.layers.map((l) => {
        if (l.id !== layerId) return l;
        const has = (l.referencedSteps || []).includes(dependsOnLayerId);
        const next = has
          ? (l.referencedSteps || []).filter((x) => x !== dependsOnLayerId)
          : [...(l.referencedSteps || []), dependsOnLayerId];
        return { ...l, referencedSteps: next };
      }) });
  };

  const handleToggleDocForStep = (layerId: string, doc: string) => {
    if (!draftAgent) return;
    const prev = documentAssignments[layerId] || [];
    const next = prev.includes(doc) ? prev.filter((d) => d !== doc) : [...prev, doc];
    const updatedAssignments = { ...documentAssignments, [layerId]: next };
    setDocumentAssignments(updatedAssignments);
    updateDraftAndPreview(applyDocsToAgent(draftAgent, updatedAssignments));
  };

  const handleUpdateDocList = (text: string) => {
    const docs = parseMultilineList(text);
    setDocumentPaths(docs);
    setDocumentAssignments({});
  };

  const handleFilePickerChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    
    const newFileNames = Array.from(files).map(file => file.name);
    const updatedPaths = [...new Set([...documentPaths, ...newFileNames])];
    setDocumentPaths(updatedPaths);
    
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    resizeStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      width: modalWidth,
      height: modalHeight };
  };

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeStartRef.current) return;
      
      const deltaX = e.clientX - resizeStartRef.current.x;
      const deltaY = e.clientY - resizeStartRef.current.y;
      
      const newWidth = Math.max(1000, Math.min(resizeStartRef.current.width + deltaX, window.innerWidth - 32));
      const newHeight = Math.max(600, Math.min(resizeStartRef.current.height + deltaY, window.innerHeight - 32));
      
      setModalWidth(newWidth);
      setModalHeight(newHeight);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      resizeStartRef.current = null;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  if (!isOpen || !portalEl) return null;

  const requestClose = () => {
    if (isBusy) return;
    setShowCloseConfirm(true);
  };

  const modal = (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        background: 'var(--alma-overlay)',
        backdropFilter: 'blur(18px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16 }}
    >
      <div
        style={{
          width: Math.min(modalWidth, window.innerWidth * 0.96),
          height: Math.min(modalHeight, window.innerHeight * 0.88),
          background: 'var(--alma-surface)',
          borderRadius: 16,
          boxShadow: '0 25px 60px rgba(0,0,0,0.35)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          border: '1px solid var(--alma-border)',
          position: 'relative' }}
        onMouseDown={(e) => {
          e.stopPropagation();
        }}
      >
        {}
        <div
          style={{
            padding: '14px 16px',
            borderBottom: '1px solid var(--alma-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--alma-surface-sunken)' }}
        >
          <div style={{ fontWeight: 700, color: 'var(--alma-accent)' }}>AI Assist Create Agent</div>
          <button
            type="button"
            onClick={requestClose}
            disabled={isBusy}
            style={{
              border: 'none',
              background: 'transparent',
              cursor: isBusy ? 'not-allowed' : 'pointer',
              color: 'var(--alma-text-muted)',
              fontSize: 16,
              opacity: isBusy ? 0.6 : 1 }}
            aria-label="Close"
          >
            <FaTimes />
          </button>
        </div>

        {}
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '60% 40%', minHeight: 0 }}>
          {}
          <div style={{ borderRight: '1px solid var(--alma-border)', display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
            <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
              {messages.map((m, idx) => (
                <div
                  key={idx}
                  style={{
                    display: 'flex',
                    justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start',
                    marginBottom: 10 }}
                >
                  <div
                    style={{
                      maxWidth: '85%',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      overflowWrap: 'break-word',
                      padding: '10px 12px',
                      borderRadius: 12,
                      fontSize: 14,
                      lineHeight: 1.35,
                      background: m.role === 'user' ? 'var(--alma-accent)' : 'var(--alma-surface-sunken)',
                      color: m.role === 'user' ? 'var(--alma-on-accent)' : 'var(--alma-text)' }}
                  >
                    {m.text}
                  </div>
                </div>
              ))}
              
              <div ref={chatBottomRef} />
            </div>

            <div style={{ padding: 12, borderTop: '1px solid var(--alma-border)', display: 'flex', gap: 8 }}>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder={isBusy ? 'Working...' : 'Type your answer...'}
                disabled={isBusy}
                style={{
                  flex: 1,
                  border: '1px solid var(--alma-border)',
                  borderRadius: 10,
                  padding: '10px 12px',
                  fontSize: 14,
                  outline: 'none' }}
              />
              <button
                type="button"
                onClick={handleSend}
                disabled={isBusy || !input.trim()}
                style={{
                  background: 'var(--alma-accent)',
                  color: 'var(--alma-on-accent)',
                  border: 'none',
                  borderRadius: 10,
                  padding: '10px 14px',
                  fontWeight: 700,
                  cursor: isBusy ? 'not-allowed' : 'pointer',
                  opacity: isBusy ? 0.7 : 1 }}
              >
                Send
              </button>
            </div>
            {error && (
              <div style={{ padding: '0 12px 12px 12px', color: 'var(--alma-danger)', fontSize: 13 }}>
                {error}
              </div>
            )}
          </div>

          {}
          <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
            <div style={{ padding: 16, borderBottom: '1px solid var(--alma-border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 700, color: 'var(--alma-accent)', marginBottom: 6 }}>Agent Preview</div>
                  <div style={{ color: 'var(--alma-text-muted)', fontSize: 13 }}>
                    Edit step names, tasks (User Instruction), models, and dependencies.
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => setPreviewMode('steps')}
                    disabled={isBusy}
                    style={{
                      borderRadius: 10,
                      padding: '8px 10px',
                      fontWeight: 800,
                      border: previewMode === 'steps' ? '2px solid var(--alma-accent)' : '1px solid var(--alma-border)',
                      background: previewMode === 'steps' ? 'var(--alma-accent-soft)' : 'var(--alma-surface)',
                      color: 'var(--alma-accent)',
                      cursor: isBusy ? 'not-allowed' : 'pointer',
                      opacity: isBusy ? 0.6 : 1 }}
                  >
                    Steps
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewMode('json')}
                    disabled={isBusy}
                    style={{
                      borderRadius: 10,
                      padding: '8px 10px',
                      fontWeight: 800,
                      border: previewMode === 'json' ? '2px solid var(--alma-accent)' : '1px solid var(--alma-border)',
                      background: previewMode === 'json' ? 'var(--alma-accent-soft)' : 'var(--alma-surface)',
                      color: 'var(--alma-accent)',
                      cursor: isBusy ? 'not-allowed' : 'pointer',
                      opacity: isBusy ? 0.6 : 1 }}
                  >
                    Corpus
                  </button>
                </div>
              </div>
            </div>
            {previewMode === 'steps' ? (
              <div style={{ flex: 1, overflow: 'auto', padding: 16, background: 'var(--alma-surface)' }}>
                {!draftAgent ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {}
                    <div style={{ border: '1px solid var(--alma-border)', borderRadius: 12, padding: 12, background: 'var(--alma-surface-sunken)' }}>
                      <div style={{ fontWeight: 800, color: 'var(--alma-accent)', marginBottom: 6 }}>🏷️ Agent Name</div>
                      <div style={{ 
                        padding: '10px 12px', 
                        background: 'var(--alma-surface)', 
                        borderRadius: 8, 
                        border: '1px solid var(--alma-border)',
                        color: agentNameHint ? 'var(--alma-text)' : 'var(--alma-text-muted)',
                        fontSize: 14 }}>
                        {agentNameHint || '(will be set after goal is described)'}
                      </div>
                    </div>

                    {}
                    <div style={{ border: '1px solid var(--alma-border)', borderRadius: 12, padding: 12, background: 'var(--alma-surface-sunken)' }}>
                      <div style={{ fontWeight: 800, color: 'var(--alma-accent)', marginBottom: 6 }}>
                        📊 Steps: {stepCount ?? '?'}
                      </div>
                      {(stepCount ?? 0) > 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {Array.from({ length: stepCount ?? 0 }).map((_, idx) => (
                            <div key={idx} style={{ 
                              display: 'flex', 
                              alignItems: 'center', 
                              gap: 8,
                              padding: '8px 10px',
                              background: 'var(--alma-surface)',
                              borderRadius: 8,
                              border: '1px solid var(--alma-border)' }}>
                              <div style={{
                                width: 24,
                                height: 24,
                                borderRadius: 999,
                                background: 'var(--alma-accent)',
                                color: 'var(--alma-on-accent)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontWeight: 700,
                                fontSize: 12,
                                flexShrink: 0 }}>
                                {idx + 1}
                              </div>
                              <div style={{ flex: 1, fontSize: 13, color: 'var(--alma-text)' }}>
                                {stepNames[idx] || `Step ${idx + 1}`}
                              </div>
                              <div style={{ fontSize: 11, color: 'var(--alma-text-muted)' }}>
                                {stepModels[idx] || defaultModel || 'default'}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div style={{ color: 'var(--alma-text-muted)', fontSize: 13 }}>
                          Describe your agent to see steps here
                        </div>
                      )}
                    </div>

                    {}
                    <div style={{ border: '1px solid var(--alma-border)', borderRadius: 12, padding: 12, background: 'var(--alma-surface-sunken)' }}>
                      <div style={{ fontWeight: 800, color: 'var(--alma-accent)', marginBottom: 6 }}>🔗 Dependencies</div>
                      <div style={{ 
                        padding: '10px 12px', 
                        background: 'var(--alma-surface)', 
                        borderRadius: 8, 
                        border: '1px solid var(--alma-border)',
                        fontSize: 13,
                        fontFamily: 'ui-monospace, monospace' }}>
                        {dependencyStyle === 'linear' && (stepCount ?? 0) > 0 ? (
                          <span style={{ color: 'var(--alma-text)' }}>
                            {Array.from({ length: stepCount ?? 0 }).map((_, i) => `[${i + 1}]`).join(' → ')}
                          </span>
                        ) : dependencyStyle === 'independent' ? (
                          <span style={{ color: 'var(--alma-text-muted)' }}>All steps run independently</span>
                        ) : dependencyStyle === 'custom' ? (
                          <span style={{ color: 'var(--alma-text)' }}>Custom dependencies</span>
                        ) : (
                          <span style={{ color: 'var(--alma-text-muted)' }}>Will be determined from your request</span>
                        )}
                      </div>
                    </div>

                    {}
                    <div style={{ border: '1px solid var(--alma-border)', borderRadius: 12, padding: 12, background: 'var(--alma-surface-sunken)' }}>
                      <div style={{ fontWeight: 800, color: 'var(--alma-accent)', marginBottom: 6 }}>
                        📚 Bibliography: {documentPaths.length} file{documentPaths.length !== 1 ? 's' : ''}
                      </div>
                      {documentPaths.length > 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {documentPaths.slice(0, 5).map((doc, idx) => (
                            <div key={idx} style={{ 
                              padding: '6px 10px', 
                              background: 'var(--alma-surface)', 
                              borderRadius: 6,
                              border: '1px solid var(--alma-border)',
                              fontSize: 12,
                              color: 'var(--alma-text)',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6 }}>
                              <span>📄</span>
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {getDocLabel(doc)}
                              </span>
                            </div>
                          ))}
                          {documentPaths.length > 5 && (
                            <div style={{ fontSize: 12, color: 'var(--alma-text-muted)', paddingLeft: 10 }}>
                              +{documentPaths.length - 5} more...
                            </div>
                          )}
                        </div>
                      ) : (
                        <div style={{ color: 'var(--alma-text-muted)', fontSize: 13 }}>
                          No bibliography attached
                        </div>
                      )}
                    </div>

                    {}
                    <div style={{ 
                      padding: 12, 
                      background: stage === 'confirm' ? 'var(--alma-surface-sunken)' : 'var(--alma-surface-sunken)', 
                      borderRadius: 12,
                      border: stage === 'confirm' ? '1px solid var(--alma-warning)' : '1px solid var(--alma-border)' }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: stage === 'confirm' ? 'var(--alma-warning)' : 'var(--alma-text-muted)' }}>
                        {stage === 'goal' && '⏳ Waiting for your request...'}
                        {stage === 'agentName' && '✏️ Enter agent name to continue'}
                        {stage === 'confirm' && '👆 Review the summary and confirm to generate'}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {}
                    <div style={{ border: '1px solid var(--alma-border)', borderRadius: 12, padding: 12, background: 'var(--alma-surface)' }}>
                      <div style={{ fontWeight: 800, color: 'var(--alma-accent)', marginBottom: 6 }}>Documents</div>
                      <div style={{ color: 'var(--alma-text-muted)', fontSize: 12, marginBottom: 10 }}>
                        Paste filenames or local paths below. Reminder: you still need to upload them manually via Add Data.
                      </div>
                      <textarea
                        value={documentPaths.join('\n')}
                        onChange={(e) => handleUpdateDocList(e.target.value)}
                        disabled={isBusy}
                        placeholder="Study_001.pdf&#10;Study_002.pdf"
                        style={{
                          width: '100%',
                          minHeight: 72,
                          border: '1px solid var(--alma-border)',
                          borderRadius: 10,
                          padding: '10px 12px',
                          fontSize: 13,
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                          resize: 'vertical',
                          opacity: isBusy ? 0.7 : 1 }}
                      />
                      {documentPaths.length > 0 && (
                        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {documentPaths.map((d, i) => (
                            <span
                              key={`${d}-${i}`}
                              style={{
                                fontSize: 12,
                                padding: '6px 8px',
                                borderRadius: 999,
                                border: '1px solid var(--alma-border)',
                                background: 'var(--alma-surface-sunken)',
                                color: 'var(--alma-text)' }}
                              title={d}
                            >
                              {getDocLabel(d)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <div style={{ fontWeight: 800, color: 'var(--alma-accent)' }}>Agent name:</div>
                      <input
                        value={draftAgent.name}
                        onChange={(e) => updateDraftAndPreview({ ...draftAgent, name: e.target.value })}
                        disabled={isBusy}
                        style={{
                          flex: 1,
                          border: '1px solid var(--alma-border)',
                          borderRadius: 10,
                          padding: '8px 10px',
                          fontSize: 14,
                          opacity: isBusy ? 0.7 : 1 }}
                      />
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {draftAgent.layers.map((layer, idx) => (
                        <div
                          key={layer.id}
                          style={{
                            border: '1px solid var(--alma-border)',
                            borderRadius: 12,
                            padding: 12,
                            background: 'var(--alma-surface-sunken)' }}
                        >
                          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
                            <div
                              style={{
                                width: 28,
                                height: 28,
                                borderRadius: 999,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: 'var(--alma-accent)',
                                color: 'var(--alma-on-accent)',
                                fontWeight: 900,
                                fontSize: 13,
                                flexShrink: 0 }}
                            >
                              {idx + 1}
                            </div>
                            <input
                              value={layer.name}
                              onChange={(e) => handleRenameStep(layer.id, e.target.value)}
                              disabled={isBusy}
                              style={{
                                flex: 1,
                                border: '1px solid var(--alma-border)',
                                borderRadius: 10,
                                padding: '8px 10px',
                                fontSize: 14,
                                fontWeight: 700,
                                color: 'var(--alma-text)',
                                opacity: isBusy ? 0.7 : 1 }}
                            />
                            <select
                              value={layer.selectedModel}
                              onChange={(e) => handleUpdateModel(layer.id, e.target.value)}
                              disabled={isBusy}
                              style={{
                                border: '1px solid var(--alma-border)',
                                borderRadius: 10,
                                padding: '8px 10px',
                                fontSize: 12,
                                color: 'var(--alma-text)',
                                background: 'var(--alma-surface)',
                                cursor: isBusy ? 'not-allowed' : 'pointer',
                                opacity: isBusy ? 0.7 : 1 }}
                            >
                              {models.map((model) => (
                                <option 
                                  key={model.value} 
                                  value={model.value}
                                  style={{ color: 'var(--alma-text)', background: 'var(--alma-surface)' }}
                                >
                                  {model.label}
                                </option>
                              ))}
                            </select>
                          </div>

                          {}
                          <div style={{ marginBottom: 12 }}>
                            <div style={{ color: 'var(--alma-accent)', fontSize: 12, marginBottom: 6, fontWeight: 700 }}>
                              User Instruction:
                            </div>
                            <textarea
                              value={layer.userInstruction}
                              onChange={(e) => handleUpdateUserInstruction(layer.id, e.target.value)}
                              disabled={isBusy}
                              placeholder="What should this step do? (e.g., 'Print a single random name in Italian')"
                              style={{
                                width: '100%',
                                minHeight: 100,
                                border: '2px solid var(--alma-accent)',
                                borderRadius: 10,
                                padding: '10px 12px',
                                fontSize: 13,
                                lineHeight: 1.5,
                                fontFamily: 'inherit',
                                resize: 'vertical',
                                opacity: isBusy ? 0.7 : 1 }}
                            />
                          </div>

                          {}
                          <div style={{ marginBottom: 12 }}>
                            <div style={{ color: 'var(--alma-text-muted)', fontSize: 12, marginBottom: 6, fontWeight: 600 }}>
                              User Input (Optional):
                            </div>
                            <textarea
                              value={layer.userInput}
                              onChange={(e) => handleUpdateUserInput(layer.id, e.target.value)}
                              disabled={isBusy}
                              placeholder="User input text or data for this step (optional)"
                              style={{
                                width: '100%',
                                minHeight: 80,
                                border: '1px solid var(--alma-border)',
                                borderRadius: 10,
                                padding: '10px 12px',
                                fontSize: 13,
                                lineHeight: 1.5,
                                fontFamily: 'inherit',
                                resize: 'vertical',
                                opacity: isBusy ? 0.7 : 1 }}
                            />
                          </div>

                          <div style={{ color: 'var(--alma-text-muted)', fontSize: 12, marginBottom: 8 }}>
                            Depends on:
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                            {draftAgent.layers
                              .slice(0, idx)
                              .map((dep) => {
                                const checked = (layer.referencedSteps || []).includes(dep.id);
                                return (
                                  <label
                                    key={dep.id}
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: 6,
                                      border: checked ? '2px solid var(--alma-accent)' : '1px solid var(--alma-border)',
                                      padding: '6px 8px',
                                      borderRadius: 999,
                                      background: checked ? 'var(--alma-accent-soft)' : 'var(--alma-surface)',
                                      cursor: 'pointer',
                                      fontSize: 12,
                                      color: 'var(--alma-text)',
                                      userSelect: 'none' }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      disabled={isBusy}
                                      onChange={() => handleToggleDependency(layer.id, dep.id)}
                                    />
                                    {dep.name}
                                  </label>
                                );
                              })}
                            {idx === 0 && <div style={{ color: 'var(--alma-text-muted)', fontSize: 12 }}>No dependencies</div>}
                          </div>

                          {}
                          <div style={{ marginTop: 12 }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                              <div style={{ color: 'var(--alma-text-muted)', fontSize: 12 }}>
                                Documents for this step:
                              </div>
                              <button
                                type="button"
                                onClick={() => fileInputRef.current?.click()}
                                disabled={isBusy}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 4,
                                  padding: '4px 8px',
                                  fontSize: 11,
                                  fontWeight: 700,
                                  border: '1px solid var(--alma-accent)',
                                  borderRadius: 6,
                                  background: 'var(--alma-surface)',
                                  color: 'var(--alma-accent)',
                                  cursor: isBusy ? 'not-allowed' : 'pointer',
                                  opacity: isBusy ? 0.6 : 1 }}
                                title="Add files from your computer"
                              >
                                <FaPlus size={10} />
                                Add Files
                              </button>
                            </div>
                            {documentPaths.length > 0 ? (
                              <>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                  {documentPaths.map((doc, di) => {
                                    const inAssignments = (documentAssignments[layer.id] || []).includes(doc);
                                    const inBibliography = (layer.bibliography || []).some(b => 
                                      b.path === doc || b.name === getDocLabel(doc)
                                    );
                                    const checked = inAssignments || inBibliography;
                                    return (
                                      <label
                                        key={`${layer.id}-${doc}-${di}`}
                                        style={{
                                          display: 'inline-flex',
                                          alignItems: 'center',
                                          gap: 6,
                                          border: checked ? '2px solid var(--alma-accent)' : '1px solid var(--alma-border)',
                                          padding: '6px 8px',
                                          borderRadius: 999,
                                          background: checked ? 'var(--alma-accent-soft)' : 'var(--alma-surface)',
                                          cursor: 'pointer',
                                          fontSize: 12,
                                          color: 'var(--alma-text)',
                                          userSelect: 'none' }}
                                        title={doc}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={checked}
                                          disabled={isBusy}
                                          onChange={() => handleToggleDocForStep(layer.id, doc)}
                                        />
                                        {getDocLabel(doc)}
                                      </label>
                                    );
                                  })}
                                </div>
                                {layer.bibliography && layer.bibliography.length > 0 && (
                                  <div style={{
                                    marginTop: 8,
                                    padding: '6px 10px',
                                    backgroundColor: 'var(--alma-surface-sunken)',
                                    borderRadius: 8,
                                    fontSize: 12,
                                    color: 'var(--alma-success)',
                                    fontWeight: 600,
                                    border: '1px solid var(--alma-success)' }}>
                                    ✓ {layer.bibliography.length} document{layer.bibliography.length > 1 ? 's' : ''} in bibliography
                                  </div>
                                )}
                              </>
                            ) : (
                              <div style={{ color: 'var(--alma-text-muted)', fontSize: 12 }}>
                                No documents added yet
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ flex: 1, overflow: 'auto', padding: 16, background: 'var(--alma-surface-sunken)' }}>
                <pre style={{ margin: 0, color: 'var(--alma-text)', fontSize: 12, lineHeight: 1.35 }}>
                  {rawPreview || JSON.stringify({
                    _status: 'Planning in progress...',
                    name: agentNameHint || '(pending)',
                    stepCount: stepCount ?? '(pending)',
                    stepNames: stepNames.length > 0 ? stepNames : '(will be extracted)',
                    dependencyStyle: dependencyStyle || 'linear',
                    documents: documentPaths.length > 0 ? documentPaths.map(d => getDocLabel(d)) : [],
                    model: defaultModel || DEFAULT_MODEL }, null, 2)}
                </pre>
              </div>
            )}
            <div style={{ padding: 12, borderTop: '1px solid var(--alma-border)', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={requestClose}
                disabled={isBusy}
                style={{
                  background: 'var(--alma-surface)',
                  color: 'var(--alma-text)',
                  border: '1px solid var(--alma-border)',
                  borderRadius: 10,
                  padding: '10px 14px',
                  fontWeight: 700,
                  cursor: isBusy ? 'not-allowed' : 'pointer',
                  opacity: isBusy ? 0.7 : 1 }}
              >
                Close
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!draftAgent || isBusy}
                style={{
                  background: !draftAgent ? 'var(--alma-text-muted)' : 'var(--alma-accent)',
                  color: 'var(--alma-on-accent)',
                  border: 'none',
                  borderRadius: 10,
                  padding: '10px 14px',
                  fontWeight: 700,
                  cursor: !draftAgent || isBusy ? 'not-allowed' : 'pointer',
                  opacity: isBusy ? 0.8 : 1 }}
              >
                Save Agent
              </button>
            </div>
          </div>
        </div>

        {}
        <div
          onMouseDown={handleResizeStart}
          style={{
            position: 'absolute',
            bottom: 0,
            right: 0,
            width: 20,
            height: 20,
            cursor: 'nwse-resize',
            zIndex: 10002 }}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            style={{
              position: 'absolute',
              bottom: 0,
              right: 0,
              opacity: 0.5 }}
          >
            <path
              d="M20 15 L15 20 M20 10 L10 20 M20 5 L5 20"
              stroke="var(--alma-text-muted)"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </div>
      </div>

      {}
      {showCloseConfirm && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10001,
            background: 'var(--alma-overlay)',
            backdropFilter: 'blur(18px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16 }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <div
            style={{
              width: 'min(520px, 96vw)',
              background: 'var(--alma-surface)',
              borderRadius: 16,
              border: '1px solid var(--alma-border)',
              boxShadow: '0 25px 60px rgba(0,0,0,0.35)',
              padding: 16 }}
          >
            <div style={{ fontWeight: 800, color: 'var(--alma-accent)', fontSize: 16, marginBottom: 8 }}>
              Close AI Assist?
            </div>
            <div style={{ color: 'var(--alma-text-muted)', fontSize: 13, lineHeight: 1.4, marginBottom: 14 }}>
              Are you sure you want to close? Any unsaved changes in this window will be lost.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                onClick={() => setShowCloseConfirm(false)}
                style={{
                  background: 'var(--alma-surface)',
                  color: 'var(--alma-text)',
                  border: '1px solid var(--alma-border)',
                  borderRadius: 10,
                  padding: '10px 14px',
                  fontWeight: 800,
                  cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCloseConfirm(false);
                  onClose();
                }}
                style={{
                  background: 'var(--alma-accent)',
                  color: 'var(--alma-on-accent)',
                  border: 'none',
                  borderRadius: 10,
                  padding: '10px 14px',
                  fontWeight: 900,
                  cursor: 'pointer' }}
              >
                Yes, close
              </button>
            </div>
          </div>
        </div>
      )}

      {}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.doc,.docx,.txt,.csv"
        onChange={handleFilePickerChange}
        style={{ display: 'none' }}
      />
    </div>
  );

  return createPortal(modal, portalEl);
}

