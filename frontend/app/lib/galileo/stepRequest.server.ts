import { z } from 'zod';
import { GalileoGatewayError } from './errors.server';

const messageSchema = z.object({ role: z.enum(['user', 'assistant', 'model', 'system']), text: z.string() });
const requestSchema = z.object({
  model: z.string().min(1).max(512),
  messages: z.array(messageSchema).min(1).max(200),
  systemInstruction: z.union([z.string(), z.object({ role: z.literal('system'), text: z.string() })]).optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  includeThoughts: z.boolean().optional(),
  ragKnowledge: z.array(z.object({ id: z.string().min(1).max(512), filename: z.string().optional() })).max(100).optional(),
  projectId: z.string().optional(),
  metadataFilter: z.string().max(10000).optional(),
  corpusId: z.string().max(512).optional(),
  corpusIds: z.array(z.string().min(1).max(512)).max(100).optional(),
  optimizeQuery: z.boolean().optional(),
});

export function parseGalileoStepRequest(raw: unknown) {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw new GalileoGatewayError('INVALID_STEP_REQUEST');
  const data = parsed.data;
  return {
    ...data,
    messages: data.messages.map(message => ({ ...message, role: message.role === 'model' ? 'assistant' as const : message.role })),
    systemInstruction: typeof data.systemInstruction === 'string' ? data.systemInstruction : data.systemInstruction?.text,
  };
}

export async function readGalileoStepRequest(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('multipart/form-data')) {
    return { raw: await request.json() as unknown, files: [] as File[] };
  }
  const form = await request.formData();
  const raw: Record<string, unknown> = { model: form.get('model') };
  for (const field of ['messages', 'ragKnowledge', 'maxTokens', 'temperature', 'includeThoughts', 'agentInputs', 'optimizeQuery', 'corpusIds'] as const) {
    const value = form.get(field);
    if (typeof value === 'string' && value) raw[field] = JSON.parse(value);
  }
  for (const field of ['projectId', 'thinkingLevel', 'metadataFilter', 'corpusId'] as const) {
    const value = form.get(field);
    if (typeof value === 'string' && value) raw[field] = value;
  }
  const system = form.get('systemInstruction');
  if (typeof system === 'string') {
    try { raw.systemInstruction = JSON.parse(system); } catch { raw.systemInstruction = system; }
  }
  const files = Array.from(form.values()).filter((value): value is File => value instanceof File);
  return { raw, files };
}