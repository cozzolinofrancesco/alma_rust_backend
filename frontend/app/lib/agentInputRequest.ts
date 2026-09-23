import { z } from 'zod';
import { agentCorpusRefSchema, driveFileIdSchema } from './agentFiles';

export const stepCorpusInputSchema = agentCorpusRefSchema.extend({
  documentSelections: z.array(z.string().min(1).max(512)).max(10000).optional(),
  metadataFilter: z.string().max(20000).optional(),
});

export const agentStepRequestSchema = z.object({
  model: z.string().min(1).max(512),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant', 'model', 'system']), text: z.string() })).min(1).max(200),
  systemInstruction: z.union([z.string(), z.object({ role: z.literal('system'), text: z.string() })]).optional(),
  agentInputs: z.object({ corpora: z.array(stepCorpusInputSchema).max(50) }),
  projectId: driveFileIdSchema.optional(),
  ragKnowledge: z.array(z.object({ id: z.string().min(1).max(512), filename: z.string().max(512).optional() })).max(100).optional(),
  optimizeQuery: z.boolean().optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  includeThoughts: z.boolean().optional(),
});

export type AgentStepRequest = z.infer<typeof agentStepRequestSchema>;

export async function readAgentInputRequest(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('multipart/form-data')) return { raw: await request.json() as unknown, files: [] as File[] };
  const form = await request.formData();
  const raw: Record<string, unknown> = {};
  const files: File[] = [];
  for (const [key, value] of form.entries()) {
    if (value instanceof File) { files.push(value); continue; }
    if (['model', 'projectId', 'thinkingLevel'].includes(key)) raw[key] = value;
    else {
      try { raw[key] = JSON.parse(value); } catch { raw[key] = value; }
    }
  }
  return { raw, files };
}