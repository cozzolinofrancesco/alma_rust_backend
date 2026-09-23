import { DEFAULT_MODEL, getModelInfo, DEFAULT_API_TIMEOUT_MS, VOICE_FAST_MODEL, VOICE_FAST_THINKING_BUDGET, DEFAULT_TTS_MODEL } from './modelConfig';
import { parseGroundingMetadata, type DebugAnswerSupport, type DebugSourceChunk } from './answerDebug';
import { Agent } from 'undici';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

const RETRYABLE_STATUS_CODES = new Set([500, 502, 503, 504]);

const GEMINI_FETCH_DISPATCHER = new Agent({
  connectTimeout: 30_000,
  headersTimeout: DEFAULT_API_TIMEOUT_MS,
  bodyTimeout: DEFAULT_API_TIMEOUT_MS,
});

export const DEFAULT_GENERATION_CONFIG = {
  temperature: 0.1,
  topP: 0.95,
  topK: 20,
  candidateCount: 1,
  presencePenalty: 0.0,
  frequencyPenalty: 0.0,
  thinkingConfig: { includeThoughts: true },
} as const;

type GenerationConfig = Omit<typeof DEFAULT_GENERATION_CONFIG, 'thinkingConfig' | 'temperature'> & {
  maxOutputTokens?: number;
  responseMimeType?: 'application/json';
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  thinkingConfig?: { includeThoughts?: boolean; thinkingBudget?: number; thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high' };
};

export interface GeminiRequestOptions {
  signal?: AbortSignal;
  validateInputBudget?: boolean;
  strictResponse?: boolean;
  redactLogs?: boolean;
  singleAttempt?: boolean;
  includeMetadata?: boolean;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  text?: string;
  imageUri?: string;
  inlineData?: { mimeType: string; data: string };
  inlineDataList?: { mimeType: string; data: string }[];
  fileData?: { mimeType: string; fileUri: string };
  fileDataList?: { mimeType: string; fileUri: string }[];
}

export interface GeminiTools {
  file_search?: {
    file_search_store_names: string[];
  };
  google_search?: Record<string, never> | object;
  function_declarations?: unknown[];
}

// Source chunks/files used to ground an answer. Alias to the shared debug type so
// the same shape flows from here to the answer-debug UI.
export type GroundingChunk = DebugSourceChunk;

export interface GeminiChatResult {
  text: string | null;
  grounding: DebugSourceChunk[];
  reasoning: string | null;
  supports: DebugAnswerSupport[];
  metadata?: {
    sentModel: string;
    reportedModel?: string;
    finishReason?: string;
    inputTokens?: number;
    outputTokens?: number;
    generationConfig: Record<string, unknown>;
  };
}

interface FormattedPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType: string; fileUri: string };
}

interface FormattedMessage {
  role: string;
  parts: FormattedPart[];
}

interface GeminiGenerateResponse {
  modelVersion?: string;
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;
      }>;
    };
    finishReason?: string;
    groundingMetadata?: unknown;
  }>;
  usageMetadata?: {
    cachedContentTokenCount?: number;
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}


interface GeminiRequestBody {
  contents: FormattedMessage[];
  generationConfig: GenerationConfig;
  systemInstruction?: FormattedMessage;
  tools?: GeminiTools[];
  cachedContent?: string;
}

async function geminiChatCore(
  messages: ChatMessage[],
  model = DEFAULT_MODEL,
  systemInstruction?: ChatMessage,
  tools?: GeminiTools[],
  cachedContent?: string,
  genConfigOverride?: Partial<GenerationConfig>,
  options?: GeminiRequestOptions,
): Promise<GeminiChatResult> {
  options?.signal?.throwIfAborted();
  if (!GEMINI_API_KEY || !GEMINI_BASE_URL) {
    throw new Error('GEMINI_API_KEY and GEMINI_BASE_URL must be set');
  }

  const formatMessage = (msg: ChatMessage): FormattedMessage => {
    const parts: FormattedPart[] = [];

    if (msg.text) {
      parts.push({ text: msg.text });
    }

    if (msg.imageUri) {
      const match = msg.imageUri.match(/^data:(image\/\w+);base64,(.*)$/);
      if (match) {
        const mimeType = match[1];
        const data = match[2];
        parts.push({ inlineData: { mimeType, data } });
      }
    }

    if (msg.inlineData) {
      parts.push({ inlineData: msg.inlineData });
    }

    if (msg.inlineDataList) {
      for (const inlineData of msg.inlineDataList) {
        parts.push({ inlineData });
      }
    }

    if (msg.fileData) {
      parts.push({ fileData: msg.fileData });
    }

    if (msg.fileDataList) {
      for (const fileData of msg.fileDataList) {
        parts.push({ fileData });
      }
    }

    if (parts.length === 0) {
      parts.push({ text: '' });
    }

    return { role: msg.role, parts };
  };

  const formattedContents = messages.map(formatMessage);
  const modelInfo = getModelInfo(model);
  const payload: GeminiRequestBody = {
    contents: formattedContents,
    generationConfig: {
      ...DEFAULT_GENERATION_CONFIG,
      ...(modelInfo?.maxOutputTokens ? { maxOutputTokens: modelInfo.maxOutputTokens } : {}),
      // Override last so callers (e.g. the fast voice path) can disable thinking
      // without mutating the shared DEFAULT_GENERATION_CONFIG.
      ...(genConfigOverride ?? {}),
    },
  };

  // When referencing an explicit context cache, the cached fields (here the
  // system instruction) must NOT be resent — Gemini rejects a request that both
  // references a cache and repeats its contents. The cache carries the system
  // instruction, so we omit it from the live request.
  if (cachedContent) {
    payload.cachedContent = cachedContent;
  } else if (systemInstruction) {
    payload.systemInstruction = formatMessage({
      ...systemInstruction,
      role: 'system',
    });
  }

  if (tools) {
    payload.tools = tools;
  }

  const endpoint = `${GEMINI_BASE_URL}/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  if (options?.validateInputBudget) {
    if (!modelInfo?.maxInputTokens) throw new Error('The selected model has no known input limit. Choose a model with a supported context budget.');
    const countResponse = await fetch(`${GEMINI_BASE_URL}/v1beta/models/${encodeURIComponent(model)}:countTokens?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: options.signal,
      body: JSON.stringify({ generateContentRequest: { model: `models/${model}`, ...payload } }),
    });
    if (!countResponse.ok) {
      await countResponse.body?.cancel();
      throw new Error('Could not verify the combined input size. No generation was started.');
    }
    const count = await countResponse.json() as { totalTokens?: unknown };
    if (typeof count.totalTokens !== 'number' || !Number.isFinite(count.totalTokens) || count.totalTokens < 0) throw new Error('Invalid input size response. No generation was started.');
    if (count.totalTokens > modelInfo.maxInputTokens) throw new Error('Combined files and context exceed the selected model input limit. Remove a file or use RAG explicitly.');
  }

  const maxRetries = options?.singleAttempt ? 1 : 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      options?.signal?.throwIfAborted();
      const response = await fetch(endpoint, {
        method: 'POST',
        dispatcher: GEMINI_FETCH_DISPATCHER,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: options?.signal,
      } as RequestInit & { dispatcher: Agent });

      if (response.ok) {
        const json = (await response.json()) as GeminiGenerateResponse;
        const cachedTokens = json.usageMetadata?.cachedContentTokenCount;
        if (typeof cachedTokens === 'number' && cachedTokens > 0) {
          console.log(
            `🟢 [Gemini API] Prompt cache hit — ${cachedTokens} cached tokens of ${json.usageMetadata?.promptTokenCount ?? '?'} prompt tokens`,
          );
        }
        const parts = json.candidates?.[0]?.content?.parts;
        const finishReason = json.candidates?.[0]?.finishReason;
        if (options?.strictResponse && finishReason && finishReason !== 'STOP') {
          throw new Error(finishReason === 'MAX_TOKENS' ? 'The model response was truncated. Increase the output limit and retry.' : 'The model could not complete this request.');
        }
        const { sources: grounding, supports } = parseGroundingMetadata(json.candidates?.[0]?.groundingMetadata);
        const joinParts = (keep: (thought: boolean) => boolean): string | null =>
          parts
            ?.filter((p) => keep(p.thought === true))
            .map((p) => p.text)
            .filter((t): t is string => typeof t === 'string' && t.length > 0)
            .join('') ?? null;
        const text = joinParts((thought) => !thought);
        const reasoningText = joinParts((thought) => thought);
        const reasoning = reasoningText && reasoningText.trim().length > 0 ? reasoningText : null;

        if (text === null || text.trim().length === 0) {
          const candidateCount = json.candidates?.length ?? 0;
          const partCount = parts?.length ?? 0;
          const firstPartKeys = parts?.[0] ? Object.keys(parts[0]) : [];
          console.warn('⚠️ [Gemini API] Empty response text received', {
            candidateCount,
            partCount,
            firstPartKeys,
            finishReason,
            hasGroundingMetadata: !!json.candidates?.[0]?.groundingMetadata,
          });

          if (!options?.redactLogs) try {
            const preview = JSON.stringify(json).slice(0, 4000);
            console.warn('⚠️ [Gemini API] Response preview (truncated):', preview);
          } catch {
          }

          if (finishReason === 'RECITATION') {
            throw new Error(
              'RECITATION_BLOCKED: Gemini refused to respond due to recitation/copyright safeguards. Ask for a summary in your own words, or ask a specific question instead of requesting verbatim passages.'
            );
          }
        }

        return {
          text, grounding, reasoning, supports,
          ...(options?.includeMetadata ? { metadata: {
            sentModel: model,
            reportedModel: json.modelVersion,
            finishReason,
            inputTokens: json.usageMetadata?.promptTokenCount,
            outputTokens: json.usageMetadata?.candidatesTokenCount,
            generationConfig: { ...payload.generationConfig },
          } } : {}),
        };
      }

      const upstreamText = await response.text();
      const errText = options?.redactLogs ? `Request failed (HTTP ${response.status}).` : upstreamText;
      
      if (errText.includes('input token count exceeds the maximum number of tokens allowed')) {
        const tokenMatch = errText.match(/(\d+)/);
        const maxTokens = tokenMatch ? tokenMatch[0] : 'allowed limit';
        throw new Error(`Document Too Large: Your input contains too much text and exceeds the maximum processing limit of ${maxTokens} tokens. Please try splitting your document into smaller sections or reducing the amount of content.`);
      }
      
      if (errText.includes('document contains') && errText.includes('pages which exceeds the supported page limit')) {
        const pageMatch = errText.match(/document contains (\d+) pages.*page limit of (\d+)/);
        const currentPages = pageMatch ? pageMatch[1] : 'many';
        const maxPages = pageMatch ? pageMatch[2] : '1000';
        throw new Error(`Document Too Large: This document contains ${currentPages} pages, which exceeds the maximum limit of ${maxPages} pages. The system should have automatically processed this using RAG. If you're seeing this error, please try uploading the file again or contact support.`);
      }
      
      if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`⚠️ [Gemini API] ${response.status} error on attempt ${attempt + 1}/${maxRetries}, retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        lastError = new Error(`Gemini API ${response.status}: ${errText}`);
        continue;
      }

      throw new Error(`Gemini API ${response.status}: ${errText}`);
      
    } catch (error) {
      options?.signal?.throwIfAborted();
      const msg = error instanceof Error ? error.message : String(error);

      const isNetworkError = error instanceof Error && (
        msg === 'fetch failed' ||
        msg.includes('UND_ERR') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('socket hang up')
      );

      const isHttpRetryable = error instanceof Error &&
        [...RETRYABLE_STATUS_CODES].some(code => msg.includes(`Gemini API ${code}`));

      if (!isNetworkError && !isHttpRetryable) {
        throw error;
      }

      lastError = error as Error;

      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`⚠️ [Gemini API] ${isNetworkError ? 'Network' : 'HTTP'} error on attempt ${attempt + 1}/${maxRetries}, retrying in ${delay}ms… (${msg})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error('All Gemini API retry attempts failed');
}

export async function geminiChat(
  messages: ChatMessage[],
  model = DEFAULT_MODEL,
  systemInstruction?: ChatMessage,
  tools?: GeminiTools[],
  cachedContent?: string,
  genConfigOverride?: Partial<GenerationConfig>
): Promise<string | null> {
  const { text } = await geminiChatCore(messages, model, systemInstruction, tools, cachedContent, genConfigOverride);
  return text;
}

export async function geminiChatWithGrounding(
  messages: ChatMessage[],
  model = DEFAULT_MODEL,
  systemInstruction?: ChatMessage,
  tools?: GeminiTools[],
  cachedContent?: string,
  genConfigOverride?: Partial<GenerationConfig>,
  options?: GeminiRequestOptions,
): Promise<GeminiChatResult> {
  return geminiChatCore(messages, model, systemInstruction, tools, cachedContent, genConfigOverride, options);
}

/**
 * Low-latency chat for the live voice tier: runs on a lite model with thinking
 * disabled and a slightly higher temperature for natural conversational replies.
 * Does NOT affect the shared DEFAULT_GENERATION_CONFIG used elsewhere.
 */
export async function geminiChatFast(
  messages: ChatMessage[],
  model = VOICE_FAST_MODEL,
  systemInstruction?: ChatMessage
): Promise<string | null> {
  const { text } = await geminiChatCore(messages, model, systemInstruction, undefined, undefined, {
    temperature: 0.4,
    thinkingConfig: { thinkingBudget: VOICE_FAST_THINKING_BUDGET },
  });
  return text;
}

export interface GeminiTtsResult {
  /** Base64-encoded raw 16-bit PCM audio (little-endian), passed through from the model. */
  audioBase64: string;
  /** Sample rate in Hz parsed from the audio mime type (Gemini TTS returns 24000). */
  sampleRate: number;
  /** Mime type reported by the model, e.g. "audio/L16;rate=24000". */
  mimeType: string;
  /** Channel count — Gemini TTS output is mono. */
  channels: number;
}

interface GeminiTtsResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: { data?: string; mimeType?: string };
      }>;
    };
  }>;
}

/**
 * Generate speech from text using Gemini's native TTS via the generateContent
 * endpoint. Returns raw PCM (mono, 24kHz) as base64 — the caller is responsible
 * for wrapping/decoding it for playback.
 */
export async function geminiTextToSpeech(
  text: string,
  voiceName = 'Kore',
  model = DEFAULT_TTS_MODEL
): Promise<GeminiTtsResult> {
  if (!GEMINI_API_KEY || !GEMINI_BASE_URL) {
    throw new Error('GEMINI_API_KEY and GEMINI_BASE_URL must be set');
  }

  const payload = {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  };

  const endpoint = `${GEMINI_BASE_URL}/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        dispatcher: GEMINI_FETCH_DISPATCHER,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      } as RequestInit & { dispatcher: Agent });

      if (response.ok) {
        const json = (await response.json()) as GeminiTtsResponse;
        const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
        const data = part?.inlineData?.data;
        const mimeType = part?.inlineData?.mimeType ?? 'audio/L16;rate=24000';
        if (!data) {
          throw new Error('Gemini TTS returned no audio data.');
        }
        const rateMatch = mimeType.match(/rate=(\d+)/);
        const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
        return { audioBase64: data, sampleRate, mimeType, channels: 1 };
      }

      const errText = await response.text();
      if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`⚠️ [Gemini TTS] ${response.status} on attempt ${attempt + 1}/${maxRetries}, retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        lastError = new Error(`Gemini TTS ${response.status}: ${errText}`);
        continue;
      }
      throw new Error(`Gemini TTS ${response.status}: ${errText}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const isNetworkError =
        error instanceof Error &&
        (msg === 'fetch failed' ||
          msg.includes('UND_ERR') ||
          msg.includes('ECONNRESET') ||
          msg.includes('ECONNREFUSED') ||
          msg.includes('socket hang up'));
      const isHttpRetryable =
        error instanceof Error &&
        [...RETRYABLE_STATUS_CODES].some((code) => msg.includes(`Gemini TTS ${code}`));

      if (!isNetworkError && !isHttpRetryable) {
        throw error;
      }
      lastError = error as Error;
      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error('All Gemini TTS retry attempts failed');
}

