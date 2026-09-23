import type { Canvas272Layer } from '../../canvas-272/lib/types';
import { DEFAULT_MODEL } from '../modelConfig';
import { buildSec1ReferencedSteps, buildSec3ReferencedSteps, sec1SelectionRequiresBiomaterialCorpus } from '../reportCreationLayerRefs';
import { formatMetaInstruction, matchMetaFileToStep, type Sect1MetaStepRow } from '../sect1MetaSteps';
import { AgentExecutionError } from '../agentExecution/errors';
import { sanitizeReportCreationLayers } from './synthesisCorpus';

export const META_SECTION_PROMPT_FALLBACK = 'Summarize and extract all key information from the document: {pdf_name}.';

export interface ReportStudy {
  id: string;
  fileName: string;
  docTitle: string;
  summary: string;
  keywords: string;
  studyType: string;
  templateId: string;
  selected: boolean;
  protocolNumber?: string;
  userInput?: string;
}

export interface ReportSectionStep {
  id: string;
  name: string;
  instruction: string;
  userInput?: string;
  selected?: boolean;
}

export interface ReportMetaFile {
  id: string;
  name: string;
  metaStepId?: string;
  userInput?: string;
}

export interface ReportCreationInput {
  agentName: string;
  studies: ReportStudy[];
  sec3Steps?: ReportSectionStep[];
  sec1Steps?: ReportSectionStep[];
  metaFiles?: ReportMetaFile[];
  metaCorpusId?: string;
  metaCorpusName?: string;
  model?: string;
  corpusId?: string;
  corpusName?: string;
  sharedMetaInstruction?: string;
  reportCreationDisplayName?: string;
  biomaterialSkipped?: boolean;
}

function extractStudyId(fileName: string, title: string) {
  const patterns = [/\bProtocol\s+((?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{2,})\b/i,
    /\bStudy\s+((?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{2,})\b/i, /\b([A-Z]{2,}-?\d+[A-Z]?)\b/, /\b(\d{6,})\b/];
  for (const pattern of patterns) {
    const match = pattern.exec(`${fileName} ${title}`);
    if (match?.[1]) return match[1];
  }
  return '';
}

function blankLayer(model: string, fields: Partial<Canvas272Layer> & { id: string; name: string }): Canvas272Layer {
  return {
    type: 'user', isActive: true, pod: '', systemInstruction: '', userInstruction: '', assistantResponse: '',
    functionCall: '', toolCall: '', selectedModel: model, referencedSteps: [], collection: undefined,
    ragKnowledge: [], userInput: '', result: '', imageUrls: [], urlContent: [], condition: '', isFrozen: false,
    keepMaster: false, outputType: 'basic', image: null, inputUrl: '', inputUrlType: '', selectedPersona: undefined,
    selectedPersonaIcon: undefined, bibliography: [], documentSelections: [], ...fields,
  };
}

const STUDY_SYSTEM_INSTRUCTION = `Each output must check all:
[ ] A Bias Check section naming the main biases you controlled for.
    Bias: agreement bias, confirmation bias, pattern-matching shortcuts.
    Resist sycophancy: never treat user claims as true just because they said them.
    Logic: leaps, narrative-filling, missing alternatives.
[ ] Harvard-style references.
[ ] An explicit answer to: "Did I understand the task?"

IMPORTANT OUTPUT RULE (override):
- You MUST perform the Bias Check + Task Understanding check, but do NOT print/return those sections verbatim in the user-visible output.
- DO include Harvard-style references in the user-visible output when applicable.`;

export function buildReportCreationAgent(
  input: ReportCreationInput,
  templates: Record<string, { id?: string; user_instruction?: string; user_input?: string }>,
  metaStepRows: Sect1MetaStepRow[] = [],
  options: { localMetaSources?: boolean; timestamp?: string } = {},
) {
  const { studies, agentName, corpusId, corpusName, metaCorpusName, sharedMetaInstruction, reportCreationDisplayName } = input;
  const biomaterialSkipped = Boolean(input.biomaterialSkipped);
  const metaFiles = biomaterialSkipped ? [] : input.metaFiles ?? [];
  const metaCorpusId = biomaterialSkipped ? undefined : input.metaCorpusId;
  const sec1Steps = input.sec1Steps ?? [];
  if (!agentName || !studies?.length) throw new AgentExecutionError('INVALID_REPORT', 'Agent name and at least one study are required', 400);
  if (biomaterialSkipped && input.metaFiles?.length) throw new AgentExecutionError('INVALID_BIOMATERIAL_SELECTION', 'biomaterialSkipped cannot be used with biomaterial PDFs. Remove meta files or clear the skip.', 400);
  if (!biomaterialSkipped && !metaFiles.length && sec1SelectionRequiresBiomaterialCorpus(sec1Steps)) {
    throw new AgentExecutionError('BIOMATERIAL_REQUIRED', 'HB_Table requires biomaterial sources or an explicit biomaterialSkipped selection.', 400);
  }
  if (metaFiles.length && !metaCorpusId && !options.localMetaSources) throw new AgentExecutionError('BIOMATERIAL_REQUIRED', 'metaCorpusId is required when biomaterial (meta) PDFs are included.', 400);
  const timestamp = options.timestamp ?? new Date().toISOString();
  const model = input.model || DEFAULT_MODEL;
  const ragKnowledge = corpusId ? [{ id: corpusId, filename: corpusName || corpusId, theme: 'Report Creation Corpus',
    description: `Corpus created for report generation containing ${studies.length} clinical studies`, createdAt: timestamp }] : [];
  const metaRagKnowledge = metaCorpusId && metaFiles.length ? [{ id: metaCorpusId, filename: metaCorpusName || metaCorpusId,
    theme: 'Meta Section Corpus', description: `Corpus created for meta-section containing ${metaFiles.length} documents`, createdAt: timestamp }] : [];
  const studyLayers = studies.map((study, index) => {
    const template = Object.values(templates).find(candidate => candidate.id === study.templateId);
    const studyId = study.protocolNumber?.trim() || extractStudyId(study.fileName, study.docTitle);
    const label = studyId || study.fileName.replace(/\.(pdf|docx?|txt)$/i, '').substring(0, 30) || `Study ${index + 1}`;
    const instruction = (template?.user_instruction || '').replace(/\[INSERT STUDY ID\]/g, studyId || '[extract from source document]')
      .replace(/\[Drug Name\]/g, '[Drug Name from source]');
    const studyInfo = ['Study Info:', studyId ? `- Study Number/ID: ${studyId}` : '- Study Number/ID: (not provided \u2014 extract from the source document per the prompt above)',
      `- Study Title: ${study.docTitle}`, `- Filename: ${study.fileName}`].join('\n');
    return blankLayer(model, {
      id: `layer-${index + 1}`, name: `[SECTION 2] ${label} - ${study.docTitle.substring(0, 40)}${study.docTitle.length > 40 ? '...' : ''}`,
      tag: 'Section 2', order: index, systemInstruction: STUDY_SYSTEM_INSTRUCTION,
      userInstruction: `${instruction.trim()}\n\n${studyInfo}`, userInput: (study.userInput || '').trim(), ragKnowledge,
      bibliography: [{ name: study.fileName, path: study.fileName, type: 'file', description: `Source document for ${study.docTitle}` }],
      corpusId: corpusId || undefined, documentSelections: corpusId && study.fileName ? [study.fileName] : [],
    });
  });
  const studyIds = studyLayers.map(layer => layer.id);
  const metaLayers = metaFiles.map((file, index) => {
    const picked = file.metaStepId?.trim() ? metaStepRows.find(row => row.id === file.metaStepId?.trim()) : undefined;
    let instruction: string;
    let displayType: string;
    let userInput = file.userInput?.trim() || '';
    if (picked) {
      instruction = formatMetaInstruction(picked.instruction, file.name, picked.typeName);
      displayType = picked.typeName.trim() || 'Biomaterial';
    } else if (sharedMetaInstruction?.trim()) {
      instruction = formatMetaInstruction(sharedMetaInstruction.trim(), file.name, 'Biomaterial');
      displayType = 'Biomaterial';
    } else {
      const matched = matchMetaFileToStep(file.name, metaStepRows);
      instruction = matched ? formatMetaInstruction(matched.instruction, file.name, matched.typeName)
        : formatMetaInstruction(META_SECTION_PROMPT_FALLBACK, file.name, 'Default');
      displayType = matched?.typeName?.trim() || 'Biomaterial';
      if (!userInput) userInput = matched?.userInput?.trim() || '';
    }
    return blankLayer(model, {
      id: `meta-layer-${index + 1}`, name: `[META] ${displayType} \u00b7 ${file.name}`, tag: 'meta-section', order: studyLayers.length + index,
      userInstruction: instruction, userInput, ragKnowledge: metaRagKnowledge,
      bibliography: [{ name: file.name, path: file.name, type: 'file', description: `Source document for ${file.name}` }],
      corpusId: metaCorpusId || undefined, documentSelections: metaCorpusId && file.name ? [file.name] : [],
    });
  });
  const metaIds = metaLayers.map(layer => layer.id);
  const sec3Layers = (input.sec3Steps ?? []).map((step, index) => blankLayer(model, {
    id: `sec3-layer-${index + 1}`, name: `[SECTION 3] ${step.name}`, tag: 'Section 3', order: studyLayers.length + metaLayers.length + index,
    userInstruction: step.instruction, userInput: (step.userInput || '').trim(), referencedSteps: buildSec3ReferencedSteps(studyIds, metaIds, index),
  }));
  const sec3Ids = sec3Layers.map(layer => layer.id);
  const sec1Layers = sec1Steps.map((step, index) => blankLayer(model, {
    id: `sec1-layer-${index + 1}`, name: `[SECTION 1] ${step.name}`, tag: 'Section 1', order: studyLayers.length + metaLayers.length + sec3Layers.length + index,
    userInstruction: step.instruction, userInput: (step.userInput || '').trim(), referencedSteps: buildSec1ReferencedSteps(step.name, sec1Steps, studyIds, metaIds, sec3Ids),
  }));
  const displayTitle = reportCreationDisplayName?.trim() || undefined;
  return {
    version: '1.0.0', name: agentName, layers: sanitizeReportCreationLayers([...studyLayers, ...metaLayers, ...sec3Layers, ...sec1Layers]),
    metadata: { created: timestamp, modified: timestamp,
      description: `Report agent generated from ${studies.length} clinical studies. Types: ${[...new Set(studies.map(study => `${study.studyType}`))].join(', ')}`,
      notes: [], generatedBy: 'Report Creation Tool', studyTypes: [...new Set(studies.map(study => study.studyType))],
      ...(displayTitle ? { displayTitle } : {}), ...(biomaterialSkipped ? { biomaterialSkipped: true } : {}) },
  };
}