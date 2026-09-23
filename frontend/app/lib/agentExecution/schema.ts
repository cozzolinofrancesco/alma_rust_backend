import { z } from 'zod';
import { stepCorpusInputSchema } from '../agentInputRequest';

export const identifierSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/)
  .refine(value => !['__proto__', 'constructor', 'prototype'].includes(value), 'Reserved identifier');
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const textSchema = z.string().max(2_000_000);
export const imageUrlSchema = z.string().max(20_000_000).regex(/^data:image\/(?:png|jpeg|gif|webp);base64,[a-zA-Z0-9+/]+=*$/);
export const outputVersionSchema = z.object({
  version: z.number().int().positive(),
  timestamp: z.string().datetime({ offset: true }),
  result: textSchema,
  imageUrls: z.array(imageUrlSchema).max(8).default([]),
});

export const layerSchema = z.object({
  id: identifierSchema,
  name: z.string().min(1).max(1000),
  userInstruction: textSchema.default(''),
  systemInstruction: textSchema.optional(),
  userInput: textSchema.optional(),
  outputType: z.enum(['basic', 'code']).optional(),
  selectedModel: z.string().min(1).max(512).optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  includeThoughts: z.boolean().optional(),
  referencedSteps: z.array(identifierSchema).max(500).default([]),
  isActive: z.boolean().optional(),
  isFrozen: z.boolean().optional(),
  order: z.number().finite().optional(),
  tag: z.string().max(1000).optional(),
  result: textSchema.optional(),
  output: textSchema.optional(),
  assistantResponse: textSchema.optional(),
  imageUrls: z.array(imageUrlSchema).max(8).optional(),
  outputHistory: z.array(outputVersionSchema).max(1000).optional(),
  corpusId: z.string().min(1).max(512).optional(),
  documentSelections: stepCorpusInputSchema.shape.documentSelections,
  metadataFilter: stepCorpusInputSchema.shape.metadataFilter,
  ragKnowledge: z.array(z.object({ id: z.string().min(1).max(512), filename: z.string().max(512).optional() }).passthrough()).max(100).optional(),
}).passthrough();

const sourceBase = { sourceId: identifierSchema, name: z.string().min(1).max(512) };
export const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ ...sourceBase, kind: z.literal('upload'), mimeType: z.string().min(1).max(128), sha256: digestSchema }).strict(),
  z.object({ ...sourceBase, kind: z.literal('text'), text: textSchema.min(1) }).strict(),
]);
export const skillSchema = z.object({ id: identifierSchema, text: textSchema.min(1), version: z.string().max(128).optional() }).strict();

export const bundleSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  agent: z.unknown(),
  version: z.string().min(1).max(128).optional(),
  sources: z.array(sourceSchema).max(1000).default([]),
  bindings: z.record(identifierSchema, z.array(identifierSchema).max(5)).default({}),
  sharedSourceIds: z.array(identifierSchema).max(5).default([]),
  skills: z.array(skillSchema).max(100).default([]),
  projectId: z.string().min(1).max(256).optional(),
  graph: z.object({
    nodes: z.array(z.object({ id: identifierSchema, data: z.object({ layerId: identifierSchema.optional() }).passthrough() }).passthrough()).max(1000),
    edges: z.array(z.object({ source: identifierSchema, target: identifierSchema }).passthrough()).max(5000),
  }).passthrough().optional(),
}).strict();

export const stepExecuteSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  step: layerSchema,
  sources: z.array(sourceSchema).max(5).default([]),
  skills: z.array(skillSchema).max(100).default([]),
  previousOutputs: z.record(identifierSchema, outputVersionSchema).default({}),
  referenceNames: z.record(identifierSchema, z.string().max(1000)).default({}),
  corpora: z.array(stepCorpusInputSchema).max(50).default([]),
  projectId: z.string().min(1).max(256).optional(),
  attemptId: identifierSchema.optional(),
}).strict();

export type ExecutionLayer = z.infer<typeof layerSchema>;
export type ExecutionSource = z.infer<typeof sourceSchema>;
export type StepExecuteInput = z.infer<typeof stepExecuteSchema>;
export type OutputVersion = z.infer<typeof outputVersionSchema>;
export type ExecutionBundle = z.infer<typeof bundleSchema>;

export const agentSchema = z.object({
  id: identifierSchema.default('portable-agent'),
  name: z.string().min(1).max(1000),
  version: z.string().min(1).max(128).optional(),
  currentVersion: z.string().min(1).max(128).optional(),
  layers: z.array(layerSchema).min(1).max(500),
  metadata: z.object({
    skillIds: z.array(identifierSchema).max(100).optional(),
    skillRefs: z.array(z.object({ skillId: identifierSchema, version: z.number().int().positive() }).passthrough()).max(100).optional(),
    fileIds: z.array(identifierSchema).max(1000).optional(),
    corpusRefs: z.array(stepCorpusInputSchema).max(50).optional(),
  }).passthrough().default({}),
}).passthrough();

export const planRequestSchema = z.object({
  bundle: bundleSchema,
  stepId: identifierSchema.optional(),
  previousOutputs: z.record(identifierSchema, outputVersionSchema).default({}),
}).strict();

export const planSchema = z.object({
  schemaVersion: z.literal(1),
  runId: identifierSchema,
  createdAt: z.string().datetime({ offset: true }),
  request: planRequestSchema,
  order: z.array(identifierSchema).max(500),
  dependencies: z.record(identifierSchema, z.array(identifierSchema).max(500)),
  planHash: digestSchema,
}).strict();

export const receiptSchema = z.object({
  stepId: identifierSchema,
  attemptId: identifierSchema,
  output: outputVersionSchema,
  diagnostics: z.record(z.unknown()),
  sources: z.array(z.unknown()).max(10000),
  responseMetadata: z.record(z.unknown()).optional(),
}).strict();

export const checkpointSchema = z.object({
  schemaVersion: z.literal(1),
  runId: identifierSchema,
  planHash: digestSchema,
  revision: z.number().int().nonnegative(),
  status: z.enum(['ready', 'completed', 'failed']),
  completed: z.array(receiptSchema).max(500),
  attempts: z.array(z.object({
    stepId: identifierSchema, attemptId: identifierSchema, status: z.enum(['succeeded', 'failed']),
    code: z.string().max(128).optional(), finalInferenceAttempted: z.boolean(),
  }).strict()).max(2000),
}).strict();

export type PortableAgent = z.infer<typeof agentSchema>;
export type ExecutionPlan = z.infer<typeof planSchema>;
export type ExecutionCheckpoint = z.infer<typeof checkpointSchema>;