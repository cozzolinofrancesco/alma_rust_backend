import { z } from 'zod';

export const AgentNoteSchema = z.object({
  username: z.string(),
  text: z.string(),
  timestamp: z.string(),
}).strict();

export const BibliographyItemSchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['file', 'url', 'reference']).optional(),
  description: z.string().optional(),
}).strict();

export const AgentLayerSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['system', 'user', 'assistant', 'function', 'tool']).default('user'),
  prompt: z.string(),
  isActive: z.boolean(),
  order: z.number().int().nonnegative(),

  pod: z.string(),
  systemInstruction: z.string(),
  userInstruction: z.string(),
  assistantResponse: z.string(),
  functionCall: z.string(),
  toolCall: z.string(),

  selectedModel: z.string(),
  referencedSteps: z.array(z.string()),
  collection: z.union([z.number().int(), z.null()]).optional(),
  userInput: z.string(),
  result: z.string(),
  imageUrls: z.array(z.string()),
  urlContent: z.array(z.unknown()),
  condition: z.string(),
  isFrozen: z.boolean(),
  keepMaster: z.boolean(),
  outputType: z.enum(['basic', 'code']),
  image: z.union([z.string(), z.null()]),
  inputUrl: z.string(),
  inputUrlType: z.enum(['webpage', 'gdrive', 'gdoc', 'gsheet', 'database', '']).default(''),

  bibliography: z.array(BibliographyItemSchema).optional(),

  selectedPersona: z.string().optional(),
  selectedPersonaIcon: z.string().optional(),
}).strict();

export const AgentMetadataSchema = z.object({
  created: z.string(),
  modified: z.string(),
  description: z.string(),
  notes: z.array(AgentNoteSchema).optional(),
}).strict();

export const AgentDataSchema = z.object({
  version: z.string(),
  name: z.string(),
  layers: z.array(AgentLayerSchema),
  metadata: AgentMetadataSchema,
}).strict();

export type AgentData = z.infer<typeof AgentDataSchema>;

