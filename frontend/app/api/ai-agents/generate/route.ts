import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { z } from 'zod';
import { DEFAULT_MODEL, isValidModel } from '../../../lib/modelConfig';
import { geminiChat } from '../../../lib/gemini';
import { AgentDataSchema, type AgentData } from '../../../lib/agentGenerationSchema';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const GenerateRequestSchema = z.object({
  goal: z.string().min(1),
  outputExample: z.string().optional(),

  usesDocuments: z.boolean().default(false),
  documentPaths: z.array(z.string()).default([]),
  documentTypes: z.array(z.string()).default([]),
  documentAssignments: z.record(z.array(z.number())).optional(),

  stepCount: z.number().int().min(1).max(50),
  stepNames: z.array(z.string()).optional(),
  stepTasks: z.array(z.string()).optional(),
  stepModels: z.array(z.string()).optional(),
  dependencyStyle: z.enum(['linear', 'independent', 'custom']).default('linear'),
  customDependencies: z.record(z.string(), z.array(z.number().int().min(1))).optional(),

  defaultModel: z.string().optional(),
  constraints: z.string().optional(),

  agentNameHint: z.string().optional(),
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
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return candidate.slice(firstBrace, lastBrace + 1).trim();
  }
  return candidate;
}

function buildPrompt(input: z.infer<typeof GenerateRequestSchema>): string {
  const model = normalizeModel(input.defaultModel);
  const now = new Date().toISOString();
  const nameHint = (input.agentNameHint || '').trim();
  const suggestedNameRule = nameHint
    ? `- Set agent.name exactly to "${nameHint}".`
    : `- Choose a short, descriptive agent.name (3-6 words) based on the user request.`;
  const descriptionHint = (input.constraints || input.goal || '').slice(0, 300);

  const docsBlock = input.usesDocuments
    ? [
        `DOCUMENTS: YES`,
        `Local paths (user provided):`,
        ...(input.documentPaths.length ? input.documentPaths.map((p) => `- ${p}`) : ['- (not provided yet)']),
        `File types: ${input.documentTypes.length ? input.documentTypes.join(', ') : '(unspecified)'}`,
        input.documentAssignments ? `Document assignments to steps: ${JSON.stringify(input.documentAssignments)}` : '',
        `IMPORTANT: The user will still need to upload these files manually into ALMA (Add Data). Do not claim the agent can read local paths directly.`,
      ].join('\n')
    : `DOCUMENTS: NO`;

  const depsBlock =
    input.dependencyStyle === 'custom'
      ? `DEPENDENCIES: CUSTOM\n${JSON.stringify(input.customDependencies || {}, null, 2)}`
      : input.dependencyStyle === 'independent'
        ? `DEPENDENCIES: INDEPENDENT (no referencedSteps)`
        : `DEPENDENCIES: LINEAR (each step i references step i-1)`;

  const stepDetailsBlock = [];
  if (input.stepNames && input.stepNames.length > 0) {
    stepDetailsBlock.push(`STEP NAMES (use exactly these): ${input.stepNames.join(', ')}`);
  }
  if (input.stepTasks && input.stepTasks.length > 0) {
    stepDetailsBlock.push(`STEP TASKS:`);
    input.stepTasks.forEach((task, i) => {
      stepDetailsBlock.push(`  Step ${i + 1}: ${task}`);
    });
  }
  if (input.stepModels && input.stepModels.length > 0) {
    stepDetailsBlock.push(`STEP MODELS (override default):`);
    input.stepModels.forEach((m, i) => {
      stepDetailsBlock.push(`  Step ${i + 1}: ${m}`);
    });
  }

  return [
    `You are generating an ALMA AI Agent JSON.`,
    ``,
    `HARD REQUIREMENTS (schema lock):`,
    `- Output MUST be a SINGLE JSON object and NOTHING ELSE (no markdown, no commentary).`,
    `- The JSON MUST match EXACTLY this TypeScript shape (no extra keys anywhere):`,
    ``,
    `AgentData = {`,
    `  version: string;`,
    `  name: string;`,
    `  layers: Layer[];`,
    `  metadata: { created: string; modified: string; description: string; notes?: { username: string; text: string; timestamp: string }[] };`,
    `}`,
    ``,
    `Layer = {`,
`  id: string;                    // e.g., "layer-1", "layer-2"`,
`  name: string;                  // Display name for the step (use study ID or document name if applicable)`,
`  type: "system" | "user" | "assistant" | "function" | "tool";  // Usually "user"`,
`  prompt: string;                // STYLE/PERSONA instructions - HOW to write (e.g., "You are an Expert Medical Writer...")`,
`  isActive: boolean;             // true`,
`  order: number;                 // 0, 1, 2, ...`,
`  pod: string;                   // empty string ""`,
`  systemInstruction: string;     // empty string ""`,
`  userInstruction: string;       // THE MAIN TASK - what to do (e.g., "Print a random Italian name")`,
`  assistantResponse: string;     // empty string ""`,
`  functionCall: string;          // empty string ""`,
`  toolCall: string;              // empty string ""`,
`  selectedModel: string;         // e.g., "gemini-3.1-pro-preview"`,
`  referencedSteps: string[];     // Dependencies: ["layer-1"] means depends on layer-1`,
`  collection?: number | null;    // null`,
`  userInput: string;             // OPTIONAL additional input data - usually empty string ""`,
`  result: string;                // empty string ""`,
`  imageUrls: string[];           // empty array []`,
`  urlContent: any[];             // empty array []`,
`  condition: string;             // empty string ""`,
`  isFrozen: boolean;             // false`,
`  keepMaster: boolean;           // false`,
`  outputType: "basic" | "code";  // "basic"`,
`  image: string | null;          // null`,
`  inputUrl: string;              // empty string ""`,
`  inputUrlType: "webpage" | "gdrive" | "gdoc" | "gsheet" | "database" | "";  // empty string ""`,
`  bibliography?: Array<{ name: string; path: string; type?: "file" | "url" | "reference"; description?: string }>;  // IMPORTANT: Add file references here!`,
`  selectedPersona?: string;      // optional`,
`  selectedPersonaIcon?: string;  // optional`,
    `}`,
    ``,
    `CONSTRUCTION RULES:`,
    `- Create exactly ${input.stepCount} layers.`,
    suggestedNameRule,
    `- Use ids exactly: layer-1, layer-2, ..., layer-${input.stepCount}.`,
    `- Use order 0..${input.stepCount - 1}.`,
    `- Default selectedModel="${model}" UNLESS step-specific models are provided below.`,
    `- Keep fields present even if empty. Use empty strings/arrays, false booleans, null for image.`,
    `- referencedSteps must contain layer IDs (e.g., "layer-1").`,
    `- version can be "1.0.0".`,
    `- metadata.created and metadata.modified must be "${now}".`,
    `- metadata.description should summarize the agent in 1 sentence. Start from: "${descriptionHint.replace(/\s+/g, ' ').trim()}".`,
    ``,
`FIELD USAGE (IMPORTANT - READ CAREFULLY):`,
``,
`- prompt: Style/persona instructions that define HOW the step should behave. This is like a system instruction.`,
`  Example: "You are an Expert Medical Writer (eCTD 2.7.2).\n\n**STYLE & FORMATTING GUIDELINES**\n*   **Voice & Tone:** Passive Voice for methods. Past Tense for results.\n*   **Data Handling:** Report Geometric Mean (CV%) for PK. Use 3 significant figures."`,
`  This field should contain the role, tone, formatting rules, and constraints for the AI.`,
``,
`- userInstruction: THE MAIN TASK - what the step should do. This is the PRIMARY work instruction field.`,
`  Example: "Draft a narrative for the attached study using the following structure:\n\n**2.X Study [INSERT STUDY ID]..."`,
`  Example for simple tasks: "Print a single random Italian name."`,
`  ALWAYS put the task description here. This field is displayed as "User Instruction" in the UI.`,
``,
`- userInput: OPTIONAL additional input data. Only use if the user provides specific data to process.`,
`  Leave as empty string "" unless user explicitly provides input data.`,
`  Example: If user says "analyze this text: Hello world", put "Hello world" in userInput.`,
``,
`- systemInstruction: Leave as empty string "".`,
`- name: Use provided STEP NAMES if available, otherwise use document/study identifiers as names.`,
    `- selectedModel: Use provided STEP MODELS if available, otherwise use default model.`,
``,
`- bibliography: CRITICAL! Extract ALL file paths mentioned in the user's request and add them here.`,
`  Look for paths like "G:\\My Drive\\..." or "/Users/..." or filenames like "study.pdf".`,
`  Each bibliography entry MUST have: { name: "filename.pdf", path: "full/path/to/filename.pdf", type: "file", description: "Auto-added from file attachment" }`,
`  If documentAssignments specifies documents for a step, use those. Otherwise, extract from the goal text.`,
    ``,
`CRITICAL RULES:`,
`1. prompt = style/persona instructions (HOW to write)`,
`2. userInstruction = THE MAIN TASK (WHAT to do) - ALWAYS fill this!`,
`3. userInput = optional additional data (usually empty)`,
`4. bibliography = file references extracted from paths in the request`,
`5. If a file path is mentioned (like "G:\\My Drive\\...\\filename.pdf"), extract and add to bibliography!`,
    ``,
    `USER REQUEST:`,
    input.goal,
    input.outputExample ? `\nOUTPUT EXAMPLE:\n${input.outputExample}` : '',
``,
`FILE PATH EXTRACTION:`,
`If the user's request mentions file paths (e.g., "G:\\My Drive\\...\\filename.pdf" or "Include file path '...'"):`,
`1. Extract the FULL path including the filename`,
`2. Extract just the filename for the "name" field`,
`3. Add to bibliography: { name: "filename.pdf", path: "G:\\My Drive\\...\\filename.pdf", type: "file", description: "Auto-added from file attachment" }`,
`4. Use the filename (without extension) or study ID as the layer name`,
``,
`TEMPLATE TYPES (if mentioned):`,
`- Template 4 / Type C: Dose Escalation / PK-PD → Use SAD/MAD study structure with immunogenicity sections`,
`- Template 5 / Type D: Intrinsic Factors → Use Renal/Hepatic impairment study structure with protein binding sections`,
``,
`IMPORTANT: Generate appropriate PROMPT (style guidelines) and USERINPUT (task template) based on the template type!`,
    ``,
    stepDetailsBlock.length > 0 ? stepDetailsBlock.join('\n') : '',
stepDetailsBlock.length > 0 ? `` : `TASK FOR EACH STEP:\nBased on the user's goal, determine what each step should do.\n- Put STYLE instructions in the "prompt" field\n- Put TASK TEMPLATE in the "userInput" field\n- Extract file paths and add to "bibliography"`,
    ``,
    docsBlock,
    ``,
    depsBlock,
    ``,
    input.constraints ? `CONSTRAINTS:\n${input.constraints}` : '',
    ``,
    `Now output the JSON object.`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function generateAgentOnce(input: z.infer<typeof GenerateRequestSchema>): Promise<{ raw: string; agent: AgentData }> {
  const prompt = buildPrompt(input);
  const chosenModel = DEFAULT_MODEL;
  const raw = (await geminiChat([{ role: 'user', text: prompt }], chosenModel)) || '';
  const jsonText = extractJsonObject(raw);
  const parsed = JSON.parse(jsonText) as unknown;
  const agent = AgentDataSchema.parse(parsed);
  return { raw, agent };
}

export async function POST(request: Request) {
  const session = await getApiSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const input = GenerateRequestSchema.parse(body);

    try {
      const { agent } = await generateAgentOnce(input);
      return NextResponse.json({ agent });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';

      const repairPrompt = [
        `You previously attempted to output an ALMA AgentData JSON but it failed validation.`,
        `Fix the JSON to match EXACTLY the required schema. Output ONLY the corrected JSON object (no markdown).`,
        ``,
        `Validation/parse error:`,
        message,
        ``,
        `Re-state the same user request and rules:`,
        buildPrompt(input),
      ].join('\n');

      const repairedRaw = (await geminiChat([{ role: 'user', text: repairPrompt }], DEFAULT_MODEL)) || '';
      const repairedJsonText = extractJsonObject(repairedRaw);
      const repairedParsed = JSON.parse(repairedJsonText) as unknown;
      const repairedAgent = AgentDataSchema.parse(repairedParsed);

      return NextResponse.json({ agent: repairedAgent, repaired: true });
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

