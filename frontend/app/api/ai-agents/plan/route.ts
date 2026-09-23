import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { z } from 'zod';
import { DEFAULT_MODEL, isValidModel } from '../../../lib/modelConfig';
import { geminiChat } from '../../../lib/gemini';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PlanRequestSchema = z.object({
  message: z.string().min(1),
}).strict();

const PlanResponseSchema = z.object({
  goal: z.string().min(1).optional(),
  wantsImmediateGenerate: z.boolean().optional(),

  usesDocuments: z.boolean().optional(),
  documentPaths: z.array(z.string()).optional(),
  documentTypes: z.array(z.string()).optional(),
  documentAssignments: z.record(z.array(z.number())).optional(),

  stepCount: z.number().int().min(1).max(50).optional(),
  stepNames: z.array(z.string()).optional(),
  stepTasks: z.array(z.string()).optional(),
  stepModels: z.array(z.string()).optional(),
  dependencyStyle: z.enum(['linear', 'independent', 'custom']).optional(),
  customDependenciesText: z.string().optional(),

  defaultModel: z.string().optional(),
  constraints: z.string().optional(),
  agentNameHint: z.string().optional(),
  outputExample: z.string().optional(),
}).strict();

function normalizeModel(inputModel?: string): string {
  const raw = (inputModel || '').trim();
  if (!raw) return DEFAULT_MODEL;
  if (raw.toLowerCase() === 'default') return DEFAULT_MODEL;
  if (isValidModel(raw)) return raw;
  return DEFAULT_MODEL;
}

function extractJsonObject(text: string): string {
  const trimmed = (text || '').trim();
  if (!trimmed) return '';
  const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/i) || trimmed.match(/```\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) return candidate.slice(firstBrace, lastBrace + 1).trim();
  return candidate;
}

function buildPlanPrompt(message: string): string {
  return [
    `You are an expert assistant that extracts ALL possible agent-creation requirements from a user's message.`,
    `Your goal is to extract MAXIMUM information to avoid asking follow-up questions.`,
    `Return ONLY a JSON object (no markdown).`,
    ``,
    `CRITICAL: If the user message contains multiple requests separated by bullet points (•) or "OR", extract ONLY the FIRST request BEFORE the first bullet/OR.`,
    `Example: "Request A • Request B" → extract ONLY Request A`,
    ``,
    `Output schema (only these keys, omit unknowns):`,
    `{`,
    `  "goal"?: string,`,
    `  "wantsImmediateGenerate"?: boolean,`,
    `  "usesDocuments"?: boolean,`,
    `  "documentPaths"?: string[],`,
    `  "documentTypes"?: string[],`,
    `  "stepCount"?: number,`,
    `  "stepNames"?: string[],`,
    `  "stepTasks"?: string[],`,
    `  "stepModels"?: string[],`,
    `  "documentAssignments"?: Record<string, number[]>,`,
    `  "dependencyStyle"?: "linear"|"independent"|"custom",`,
    `  "customDependenciesText"?: string,`,
    `  "defaultModel"?: string,`,
    `  "constraints"?: string,`,
    `  "agentNameHint"?: string,`,
    `  "outputExample"?: string`,
    `}`,
    ``,
    `CRITICAL EXTRACTION RULES:`,
    ``,
    `0. FIRST REQUEST ONLY:`,
    `   - If message contains "•" or multiple agent descriptions, extract ONLY the FIRST complete request`,
    `   - Stop extraction at the first "•" character`,
    `   - Ignore any text after bullets`,
    ``,
    `1. STEP COUNT (MOST IMPORTANT):`,
    `   - If user says "5 steps" or "5-step analysis" → stepCount: 5`,
    `   - If user says "35 steps" → stepCount: 35`,
    `   - Extract the EXACT number mentioned in the FIRST request`,
    `   - NEVER change the number`,
    ``,
    `2. STEP NAMES:`,
    `   - Extract ALL step names from FIRST request only`,
    `   - If 5 steps requested but only 4 names ("roberto, marco, luca, andrea") → add 5th: ["roberto", "marco", "luca", "andrea", "paolo"]`,
    `   - Common Italian names for auto-generation: paolo, giuseppe, maria, francesca, giovanni`,
    ``,
    `3. STEP TASKS:`,
    `   - Extract task from FIRST request only`,
    `   - If same task for all steps, repeat it stepCount times`,
    ``,
    `4. MODELS:`,
    `   - "flash" / "pro" → "gemini-3.1-pro-preview" (only model available)`,
    `   - "all use flash except last uses pro" with 5 steps → ["gemini-3.1-pro-preview", "gemini-3.1-pro-preview", "gemini-3.1-pro-preview", "gemini-3.1-pro-preview", "gemini-3.1-pro-preview"]`,
    ``,
    `5. DOCUMENTS:`,
    `   - Extract from FIRST request only`,
    `   - "attach to every odd step" for 5 steps → [1, 3, 5]`,
    ``,
    `6. DEPENDENCIES:`,
    `   - "step 3 depends on step 1" → dependencyStyle: "custom", customDependenciesText: "3 depends on 1"`,
    ``,
    `7. ALWAYS: wantsImmediateGenerate=true`,
    ``,
    `EXAMPLE:`,
    `User: "Create a 5-step analysis where step 3 depends on step 1. Name the steps: Roberto, Marco, Luca, Andrea, Paolo. Each step prints a random Italian name. Use Flash model for all except the last which uses Pro."`,
    `Output: {"goal": "5-step analysis", "stepCount": 5, "stepNames": ["Roberto", "Marco", "Luca", "Andrea", "Paolo"], "stepTasks": ["print a random Italian name", "print a random Italian name", "print a random Italian name", "print a random Italian name", "print a random Italian name"], "stepModels": ["gemini-3.1-pro-preview", "gemini-3.1-pro-preview", "gemini-3.1-pro-preview", "gemini-3.1-pro-preview", "gemini-3.1-pro-preview"], "dependencyStyle": "custom", "customDependenciesText": "3 depends on 1", "agentNameHint": "Italian Name Analysis", "wantsImmediateGenerate": true}`,
    ``,
    `USER MESSAGE (extract ONLY the FIRST request, stop at any "•" character):`,
    message,
  ].join('\n');
}

export async function POST(request: Request) {
  const session = await getApiSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { message } = PlanRequestSchema.parse(body);

    const raw = (await geminiChat([{ role: 'user', text: buildPlanPrompt(message) }], DEFAULT_MODEL)) || '';
    const jsonText = extractJsonObject(raw);
    const parsed = JSON.parse(jsonText) as unknown;
    const plan = PlanResponseSchema.parse(parsed);

    const normalizedPlan = {
      ...plan,
      defaultModel: plan.defaultModel ? normalizeModel(plan.defaultModel) : undefined,
    };

    return NextResponse.json({ plan: normalizedPlan });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

