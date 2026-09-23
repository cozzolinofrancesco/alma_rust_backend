import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { z } from 'zod';
import { DEFAULT_MODEL } from '../../../lib/modelConfig';
import { geminiChat } from '../../../lib/gemini';
import { AgentDataSchema, type AgentData } from '../../../lib/agentGenerationSchema';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const RefineRequestSchema = z.object({
  currentAgent: AgentDataSchema,
  refinementRequest: z.string().min(1),
  documentPaths: z.array(z.string()).default([]),
}).strict();

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

function buildRefinePrompt(input: z.infer<typeof RefineRequestSchema>): string {
  const now = new Date().toISOString();
  const stepCount = input.currentAgent.layers.length;
  
  return [
    `You are refining an existing ALMA AI Agent JSON based on user feedback.`,
    ``,
    `HARD REQUIREMENTS (schema lock):`,
    `- Output MUST be a SINGLE JSON object and NOTHING ELSE (no markdown, no commentary).`,
    `- The JSON MUST match EXACTLY the AgentData TypeScript shape (no extra keys anywhere).`,
    `- Preserve all existing fields unless the user specifically asks to change them.`,
    `- Update metadata.modified to "${now}".`,
    `- IMPORTANT: This agent currently has ${stepCount} steps. Ensure ALL steps are included in the output with valid JSON syntax.`,
    `- Pay extra attention to commas between array elements and ensure the layers array is properly closed.`,
    `- CRITICAL: Ensure proper JSON syntax - all array elements must be separated by commas, arrays must be properly closed with ].`,
    ``,
    `AgentData schema:`,
    `{`,
    `  version: string;`,
    `  name: string;`,
    `  layers: Layer[];`,
    `  metadata: { created: string; modified: string; description: string; notes?: { username: string; text: string; timestamp: string }[] };`,
    `}`,
    ``,
    `Layer schema:`,
    `{`,
    `  id: string; // e.g. "layer-1", "layer-2"`,
    `  name: string;`,
    `  type: "system" | "user" | "assistant" | "function" | "tool";`,
    `  prompt: string;`,
    `  isActive: boolean;`,
    `  order: number;`,
    `  pod: string;`,
    `  systemInstruction: string;`,
    `  userInstruction: string;`,
    `  assistantResponse: string;`,
    `  functionCall: string;`,
    `  toolCall: string;`,
    `  selectedModel: string;`,
    `  referencedSteps: string[]; // array of layer IDs, e.g. ["layer-1"]`,
    `  collection?: number | null;`,
    `  userInput: string;`,
    `  result: string;`,
    `  imageUrls: string[];`,
    `  urlContent: any[];`,
    `  condition: string;`,
    `  isFrozen: boolean;`,
    `  keepMaster: boolean;`,
    `  outputType: "basic" | "code";`,
    `  image: string | null;`,
    `  inputUrl: string;`,
    `  inputUrlType: "webpage" | "gdrive" | "gdoc" | "gsheet" | "database" | "";`,
    `  bibliography?: Array<{ name: string; path: string; type?: "file" | "url" | "reference"; description?: string }>;`,
    `  selectedPersona?: string;`,
    `  selectedPersonaIcon?: string;`,
    `}`,
    ``,
    `CURRENT AGENT JSON:`,
    JSON.stringify(input.currentAgent, null, 2),
    ``,
    input.documentPaths.length > 0 ? `Available documents:\n${input.documentPaths.map(d => `- ${d}`).join('\n')}` : '',
    ``,
    `USER REFINEMENT REQUEST:`,
    input.refinementRequest,
    ``,
    `INSTRUCTIONS:`,
    `- Apply the user's requested changes to the agent.`,
    `- If adding steps, use sequential IDs (layer-N where N is the next number) and order fields.`,
    `- When adding multiple steps, generate them systematically to avoid JSON syntax errors.`,
    `- If removing steps, update order numbers and adjust any referencedSteps in other layers.`,
    `- If changing dependencies, update referencedSteps arrays with proper layer IDs.`,
    `- If renaming steps, update the name field.`,
    `- If changing instructions, update userInstruction (the main task field) unless specifically asked to change systemInstruction or userInput.`,
    `- Maintain all other fields exactly as they were.`,
    `- Keep all fields present (use empty strings, empty arrays, false, null as needed).`,
    ``,
    `FIELD USAGE (IMPORTANT):`,
    `- userInstruction: The main task description. This is the PRIMARY field - always update this when changing what a step does.`,
    `- prompt: Should always match userInstruction (copy the same value).`,
    `- systemInstruction: Leave unchanged unless specifically asked to modify system context.`,
    `- userInput: Leave unchanged unless specifically asked to modify user input data.`,
    ``,
    `Now output the COMPLETE refined agent JSON.`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function refineAgentOnce(input: z.infer<typeof RefineRequestSchema>): Promise<{ raw: string; agent: AgentData; explanation: string }> {
  const prompt = buildRefinePrompt(input);
  const model = DEFAULT_MODEL;
  
  const raw = (await geminiChat([{ role: 'user', text: prompt }], model)) || '';
  
  const jsonText = extractJsonObject(raw);
  
  let fixedJson = jsonText;
  
  fixedJson = fixedJson.replace(/,(\s*])/g, '$1');
  
  fixedJson = fixedJson.replace(/}\s*{/g, '},{');
  
  const parsed = JSON.parse(fixedJson) as unknown;
  const agent = AgentDataSchema.parse(parsed);
  
  const stepCountChange = agent.layers.length - input.currentAgent.layers.length;
  let explanation = 'Applied your changes! ✅';
  if (stepCountChange > 0) {
    explanation = `Added ${stepCountChange} step${stepCountChange > 1 ? 's' : ''} to the agent. ✅`;
  } else if (stepCountChange < 0) {
    explanation = `Removed ${Math.abs(stepCountChange)} step${stepCountChange < -1 ? 's' : ''} from the agent. ✅`;
  }
  
  return { raw, agent, explanation };
}

export async function POST(request: Request) {
  const session = await getApiSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const input = RefineRequestSchema.parse(body);

    try {
      const { agent, explanation } = await refineAgentOnce(input);
      return NextResponse.json({ agent, explanation });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';

      const repairPrompt = [
        `You previously attempted to output a refined ALMA AgentData JSON but it failed validation.`,
        `The JSON had a syntax error. Fix the JSON to match EXACTLY the required schema.`,
        `Output ONLY the corrected JSON object (no markdown, no commentary).`,
        ``,
        `CRITICAL: Pay attention to JSON syntax:`,
        `- All array elements must be separated by commas (except the last one)`,
        `- No trailing commas before closing brackets ]`,
        `- All arrays must be properly closed with ]`,
        `- All objects must be properly closed with }`,
        ``,
        `Validation/parse error:`,
        message,
        ``,
        `Re-state the refinement task:`,
        buildRefinePrompt(input),
      ].join('\n');

      const repairedRaw = (await geminiChat([{ role: 'user', text: repairPrompt }], DEFAULT_MODEL)) || '';
      const repairedJsonText = extractJsonObject(repairedRaw);
      
      let fixedRepaired = repairedJsonText;
      fixedRepaired = fixedRepaired.replace(/,(\s*])/g, '$1');
      fixedRepaired = fixedRepaired.replace(/}\s*{/g, '},{');
      
      const repairedParsed = JSON.parse(fixedRepaired) as unknown;
      const repairedAgent = AgentDataSchema.parse(repairedParsed);

      return NextResponse.json({ agent: repairedAgent, explanation: 'Applied your changes! ✅', repaired: true });
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

