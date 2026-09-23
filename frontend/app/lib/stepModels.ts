import { z } from 'zod';
import type { ModelOption } from './modelConfig';

export type GalileoVendor = 'openai' | 'claude';
export type GalileoProvider = 'openai' | 'bedrock' | 'azure-openai';
export const GALILEO_CATALOG_FRESH_MS = 60 * 60 * 1000;
export const GALILEO_CATALOG_MAX_AGE_MS = 24 * GALILEO_CATALOG_FRESH_MS;

export interface StepModelOption extends ModelOption {
  disabled?: boolean;
}

export interface GalileoModelOption extends StepModelOption {
  vendor: GalileoVendor;
  provider: GalileoProvider;
  providerName: string;
  catalogId: string;
  modelId: string;
  modelName?: string;
  modelAlias?: string;
  releaseDate: string;
  apiTypes: string[];
  inputModalities: string[];
  outputModalities: string[];
  supportsAttachments: boolean;
  supportsTemperature: boolean;
  supportsReasoning: boolean;
  supportsTools: boolean;
  euInferenceProfile?: string;
  contextWindowTokens: number;
  cost?: { input: number; output?: number; cache_read?: number; cache_write?: number };
}

export interface GalileoCatalog {
  source?: 'remote' | 'configured-file';
  models: GalileoModelOption[];
  state: 'fresh' | 'stale' | 'unavailable';
  fetchedAt: string | null;
  rejectedRows: number;
  duplicateRows: number;
  error?: string;
  gateway?: {
    state: 'disabled' | 'configuration-required' | 'ready';
    endpoint?: string;
  };
}

const dateSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/);
const priceSchema = z.number().finite().nonnegative();
const catalogRowSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  providerName: z.string().min(1),
  name: z.string().min(1),
  model_id: z.string().min(1),
  model_name: z.string().min(1).optional(),
  model_alias: z.string().min(1).optional(),
  release_date: dateSchema,
  lifecycle: z.enum(['preview', 'active', 'deprecated', 'retired']),
  type: z.string(),
  gateway_region: z.array(z.enum(['us', 'eu'])),
  api_type: z.array(z.string()).min(1),
  attachment: z.boolean(),
  temperature: z.boolean(),
  reasoning: z.boolean(),
  tool_call: z.boolean(),
  limit: z.object({ context: z.number().int().positive(), output: z.number().int().positive() }),
  modalities: z.object({ input: z.array(z.string()), output: z.array(z.string()) }),
  inference_profiles: z.object({ eu: z.string().min(1).optional() }).optional(),
  cost: z.object({
    input: priceSchema,
    output: priceSchema.optional(),
    cache_read: priceSchema.optional(),
    cache_write: priceSchema.optional(),
  }).optional(),
}).refine(row => row.id === `${row.provider}:${row.model_id}`);

export const isGalileoModel = (model: unknown): boolean =>
  typeof model === 'string' && model.startsWith('galileo:');

export function canSelectStepModel(value: string, models: readonly StepModelOption[]): boolean {
  const option = models.find(model => model.value === value);
  return isGalileoModel(value) ? option?.disabled === false : option?.disabled !== true;
}

export function parseGalileoCatalog(input: unknown): Pick<GalileoCatalog, 'models' | 'rejectedRows' | 'duplicateRows'> {
  if (!Array.isArray(input)) throw new Error('Galileo returned an invalid model catalog.');

  const candidates: GalileoModelOption[] = [];
  let rejectedRows = 0;
  for (const entry of input) {
    const parsed = catalogRowSchema.safeParse(entry);
    if (!parsed.success) {
      rejectedRows += 1;
      continue;
    }
    const row = parsed.data;
    const claudeId = /^(?:(?:eu|us|global)\.)?anthropic\.claude(?:[-.]|$)|^claude(?:[-.]|$)/i;
    const vendor: GalileoVendor | undefined = row.provider === 'openai'
      ? 'openai'
      : (row.provider === 'bedrock' || row.provider === 'azure-openai') && claudeId.test(row.model_id)
        ? 'claude'
        : undefined;
    if (!vendor || row.lifecycle !== 'active' || row.type !== 'LLM' ||
        !row.gateway_region.includes('eu') || !row.modalities.input.includes('text') ||
        !row.modalities.output.includes('text') ||
        !row.api_type.some(api => ['request', 'completions', 'responses'].includes(api))) continue;

    candidates.push({
      value: `galileo:${row.id}`,
      label: `${row.name} (Galileo / ${row.providerName})`,
      description: `${row.providerName}, EU`,
      capabilities: row.modalities.input,
      maxInputTokens: row.limit.context,
      maxOutputTokens: row.limit.output,
      contextWindowTokens: row.limit.context,
      vendor,
      provider: row.provider as GalileoProvider,
      providerName: row.providerName,
      catalogId: row.id,
      modelId: row.model_id,
      modelName: row.model_name,
      modelAlias: row.model_alias,
      releaseDate: row.release_date,
      apiTypes: row.api_type,
      inputModalities: row.modalities.input,
      outputModalities: row.modalities.output,
      supportsAttachments: row.attachment,
      supportsTemperature: row.temperature,
      supportsReasoning: row.reasoning,
      supportsTools: row.tool_call,
      euInferenceProfile: row.inference_profiles?.eu,
      cost: row.cost,
    });
  }
  const counts = new Map<string, number>();
  candidates.forEach(model => counts.set(model.value, (counts.get(model.value) ?? 0) + 1));
  const models = candidates.filter(model => counts.get(model.value) === 1);
  models.sort((first, second) => first.vendor.localeCompare(second.vendor) ||
    second.releaseDate.localeCompare(first.releaseDate) || first.value.localeCompare(second.value));
  return { models, rejectedRows, duplicateRows: candidates.length - models.length };
}