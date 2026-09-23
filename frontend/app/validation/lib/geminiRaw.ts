import { fetchWithTimeout } from '@/app/lib/fetchWithTimeout';
import { DEFAULT_API_TIMEOUT_MS, GEMINI_MODELS } from '@/app/lib/modelConfig';

// Minimal server-side Gemini generateContent helpers used by the unified
// validation adapters/judges. Kept local (and consistent with
// claim-validation/lib/validationService.ts) so each mode controls its own
// system prompt + response schema. Secrets stay server-side (GEMINI_API_KEY).

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

export type GeminiPart =
  | { text: string }
  | { fileData: { mimeType: string; fileUri: string } };

interface CallArgs {
  signal?: AbortSignal;
  maxOutputTokens?: number;
  system?: string;
  parts: GeminiPart[];
  model?: string;
  // Plain JSON schema object (Gemini responseSchema). When set, the call returns
  // parsed JSON; otherwise it returns the raw text.
  schema?: Record<string, unknown>;
}

async function call(args: CallArgs): Promise<string> {
  const model = args.model ?? GEMINI_MODELS.flash;
  const endpoint =
    `${GEMINI_BASE_URL}/v1beta/models/${encodeURIComponent(model)}:generateContent` +
    `?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: args.parts }],
    generationConfig: {
      temperature: 0.1,
      topP: 0.95,
      topK: 20,
      ...(args.maxOutputTokens ? { maxOutputTokens: args.maxOutputTokens } : {}),
      ...(args.schema
        ? { responseMimeType: 'application/json', responseSchema: args.schema }
        : {}),
    },
  };
  if (args.system) {
    body.systemInstruction = { role: 'system', parts: [{ text: args.system }] };
  }

  const request: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = args.signal
    ? await fetch(endpoint, { ...request, signal: AbortSignal.any([args.signal, AbortSignal.timeout(DEFAULT_API_TIMEOUT_MS)]) })
    : await fetchWithTimeout(endpoint, request, DEFAULT_API_TIMEOUT_MS);

  if (!res.ok) {
    const errText = await res.text().catch(() => 'unknown');
    throw new Error(`Gemini call failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

export async function callGeminiText(args: Omit<CallArgs, 'schema'>): Promise<string> {
  return call(args);
}

export async function callGeminiJson<T>(args: CallArgs & { schema: Record<string, unknown> }): Promise<T> {
  const raw = await call(args);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Gemini returned non-JSON output: ${raw.slice(0, 200)}`);
  }
}
