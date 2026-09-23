import { z } from 'zod';
import { load, JSON_SCHEMA } from 'js-yaml';
import { loadTemplates } from '../templateLoader';
import { DEFAULT_MODEL, isImageModel } from '../modelConfig';
import { bundleSchema, identifierSchema, sourceSchema, skillSchema, textSchema } from '../agentExecution/schema';
import { AgentExecutionError } from '../agentExecution/errors';
import type { ExecutionContext } from '../agentExecution/http.server';
import { executePortableStep } from '../agentExecution/step.server';
import { hashValue } from '../agentExecution/hash.server';
import { buildReportCreationAgent } from './compiler';
import { buildSourceSummaryPrompt, parseSourceSummary } from './sourceSummary';

const templateSchema = z.object({ id: z.string().min(1).max(512), user_instruction: textSchema.refine(value => Boolean(value.trim()), 'Template instruction is required'), user_input: textSchema.optional() }).passthrough();
const templatesSchema = z.record(z.string().max(512), templateSchema);
const sectionStepSchema = z.object({ id: identifierSchema, name: z.string().min(1).max(1000), instruction: textSchema.min(1), userInput: textSchema.optional(), selected: z.boolean().default(true) }).strict();
const metaStepSchema = z.object({ id: identifierSchema, typeName: z.string().min(1).max(1000), instruction: textSchema.min(1), keywords: z.array(z.string().max(512)).max(100).default([]), userInput: textSchema.optional() }).strict();

const compileSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  agentName: z.string().trim().min(1).max(240),
  studies: z.array(z.object({
    id: identifierSchema, fileName: z.string().min(1).max(512), docTitle: z.string().max(5000),
    summary: textSchema.default(''), keywords: z.union([z.string().max(10000), z.array(z.string().max(512)).max(100)]).default('').transform(value => Array.isArray(value) ? value.join(', ') : value),
    studyType: z.string().max(1000).default(''), templateId: z.string().min(1).max(512),
    selected: z.boolean().default(true), protocolNumber: z.string().max(1000).optional(), userInput: textSchema.optional(),
    sourceIds: z.array(identifierSchema).max(5).default([]),
  }).strict()).min(1).max(200),
  metaFiles: z.array(z.object({ id: identifierSchema, name: z.string().min(1).max(512), metaStepId: identifierSchema.optional(),
    userInput: textSchema.optional(), sourceIds: z.array(identifierSchema).max(5).default([]) }).strict()).max(200).default([]),
  sec1Steps: z.array(sectionStepSchema).max(100).default([]),
  sec3Steps: z.array(sectionStepSchema).max(100).default([]),
  sect1MetaSteps: z.array(metaStepSchema).max(100).default([]),
  sources: z.array(sourceSchema).max(1000).default([]),
  skills: z.array(skillSchema).max(100).default([]),
  templates: templatesSchema.optional(),
  templatesYamlText: textSchema.optional(),
  templatesSheetId: z.string().min(1).max(512).optional(),
  model: z.string().min(1).max(512).default(DEFAULT_MODEL),
  corpusId: z.string().min(1).max(512).optional(),
  corpusName: z.string().max(512).optional(),
  metaCorpusId: z.string().min(1).max(512).optional(),
  metaCorpusName: z.string().max(512).optional(),
  projectId: z.string().min(1).max(256).optional(),
  sharedMetaInstruction: textSchema.optional(),
  reportCreationDisplayName: z.string().max(1000).optional(),
  biomaterialSkipped: z.boolean().default(false),
}).strict();

export async function compilePortableReport(raw: unknown, context: ExecutionContext) {
  const input = compileSchema.parse(raw);
  if ([input.templates, input.templatesYamlText, input.templatesSheetId].filter(value => value !== undefined).length !== 1) {
    throw new AgentExecutionError('TEMPLATES_REQUIRED', 'Supply exactly one templates object, templatesYamlText, or authorized templatesSheetId.');
  }
  let templates = input.templates;
  if (input.templatesYamlText !== undefined) {
    try {
      templates = z.object({ templates: templatesSchema }).parse(load(input.templatesYamlText, { schema: JSON_SCHEMA })).templates;
    } catch { throw new AgentExecutionError('INVALID_TEMPLATES', 'The supplied template YAML is invalid.'); }
  }
  if (input.templatesSheetId) {
    if (!context.google?.accessToken) throw new AgentExecutionError('GOOGLE_AUTH_REQUIRED', 'Google OAuth is required to read a template sheet.', 403, 'authorization');
    const loaded = await loadTemplates(context.google.accessToken, { sheetId: input.templatesSheetId });
    if (!loaded) throw new AgentExecutionError('TEMPLATES_UNAVAILABLE', 'The requested Google Sheet could not be read.', 403, 'input');
    templates = templatesSchema.parse(loaded.templates);
  }
  if (!templates || !Object.keys(templates).length) throw new AgentExecutionError('TEMPLATES_REQUIRED', 'At least one template is required.');
  const templateIds = Object.values(templates).map(template => template.id);
  if (new Set(templateIds).size !== templateIds.length) throw new AgentExecutionError('DUPLICATE_TEMPLATE', 'Template IDs must be unique.');
  const sources = new Map(input.sources.map(source => [source.sourceId, source]));
  if (sources.size !== input.sources.length) throw new AgentExecutionError('DUPLICATE_SOURCE', 'Source IDs must be unique.');
  const studies = input.studies.filter(study => study.selected);
  const sec1Steps = input.sec1Steps.filter(step => step.selected);
  const sec3Steps = input.sec3Steps.filter(step => step.selected);
  const bindings: Record<string, string[]> = {};
  const bind = (stepId: string, sourceIds: string[], corpusId?: string) => {
    if (corpusId && sourceIds.length) throw new AgentExecutionError('AMBIGUOUS_SOURCE_MODE', 'Choose supplied files or corpus documents for each source group, not both.');
    if (!corpusId && !sourceIds.length) throw new AgentExecutionError('MISSING_SOURCE', `Source bindings are required for ${stepId}.`);
    if (new Set(sourceIds).size !== sourceIds.length || sourceIds.some(sourceId => !sources.has(sourceId))) throw new AgentExecutionError('INVALID_SOURCE_BINDING', `Invalid sources for ${stepId}.`);
    if (sourceIds.length) bindings[stepId] = sourceIds;
  };
  studies.forEach((study, index) => {
    if (!templateIds.includes(study.templateId)) throw new AgentExecutionError('TEMPLATE_NOT_FOUND', `Template ${study.templateId} is not in the supplied snapshot.`);
    bind(`layer-${index + 1}`, study.sourceIds, input.corpusId);
  });
  input.metaFiles.forEach((file, index) => {
    if (file.metaStepId && !input.sect1MetaSteps.some(step => step.id === file.metaStepId)) throw new AgentExecutionError('TEMPLATE_NOT_FOUND', `Biomaterial template ${file.metaStepId} is not in the supplied snapshot.`);
    bind(`meta-layer-${index + 1}`, file.sourceIds, input.metaCorpusId);
  });
  const boundIds = new Set(Object.values(bindings).flat());
  if (input.sources.some(source => !boundIds.has(source.sourceId))) throw new AgentExecutionError('UNBOUND_SOURCE', 'Remove sources that are not bound to a selected study or biomaterial step.');
  const agent = buildReportCreationAgent({ ...input, studies, sec1Steps, sec3Steps }, templates, input.sect1MetaSteps,
    { localMetaSources: input.metaFiles.length > 0 && !input.metaCorpusId });
  const snapshot = { templates, sect1MetaSteps: input.sect1MetaSteps };
  const bundle = bundleSchema.parse({ agent: { ...agent, metadata: { ...agent.metadata, templateSnapshot: snapshot, templateHash: hashValue(snapshot) } },
    sources: input.sources, bindings, skills: input.skills, projectId: input.projectId });
  return { schemaVersion: 1, bundle, requiredSources: bindings };
}

const prepareSchema = z.object({
  source: sourceSchema,
  model: z.string().min(1).max(512).default(DEFAULT_MODEL),
  attemptId: identifierSchema.optional(),
}).strict();

export async function preparePortableSource(raw: unknown, files: Map<string, File>, context: ExecutionContext) {
  const input = prepareSchema.parse(raw);
  if (isImageModel(input.model)) throw new AgentExecutionError('UNSUPPORTED_MODEL', 'Source preparation requires a text model.');
  const response = await executePortableStep({ step: {
    id: 'prepare-source', name: 'Prepare source', userInstruction: buildSourceSummaryPrompt(input.source.name, 'attached'),
    systemInstruction: 'Return JSON only. Do not include any extra text.', selectedModel: input.model, maxTokens: 4096,
  }, sources: [input.source], attemptId: input.attemptId }, files, context);
  const summary = parseSourceSummary(response.output.result);
  return {
    schemaVersion: 1, status: 'succeeded', source: input.source,
    metadata: { fileName: input.source.name, protocolNumber: summary.protocol_number, docTitle: summary.title, summary: summary.summary, keywords: summary.keywords },
    diagnostics: response.diagnostics,
  };
}