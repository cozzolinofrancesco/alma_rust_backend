import { NextRequest, NextResponse } from 'next/server';
import { AVAILABLE_MODELS, DEFAULT_MODEL, GEMINI_MODELS, getModelInfo, isValidModel, type ModelValue } from '../../lib/modelConfig';
import { fetchWithTimeout } from '../../lib/fetchWithTimeout';
import { authorizeServiceRequest } from '../../lib/serviceApiAuth';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

const DEFAULT_MAX_INPUT_TOKENS = 1_048_576;
const DEFAULT_MAX_OUTPUT_TOKENS = 65_536;

const BASE_GENERATION_CONFIG = {
    temperature: 0.1,
    topP: 0.95,
    topK: 20,
    candidateCount: 1,
};

interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

interface ChatRequest {
    messages: ChatMessage[];
    model?: string;
    api_key?: string;
    cachedContent?: string;
}

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

function truncateMessages(messages: ChatMessage[], maxInputTokens: number): ChatMessage[] {
    let totalTokens = 0;
    const truncatedMessages: ChatMessage[] = [];

    for (let i = messages.length - 1; i >= 0; i--) {
        const messageTokens = estimateTokens(messages[i].content);
        if (totalTokens + messageTokens <= maxInputTokens) {
            totalTokens += messageTokens;
            truncatedMessages.unshift(messages[i]);
        } else {
            if (truncatedMessages.length === 0) {
                const remainingTokens = Math.max(0, maxInputTokens - totalTokens);
                const truncatedContent = messages[i].content.substring(0, remainingTokens * 4);
                truncatedMessages.unshift({
                    ...messages[i],
                    content: truncatedContent + ' [TRUNCATED]'
                });
            }
            break;
        }
    }

    return truncatedMessages;
}

function normalizeModelParam(modelParam: string | null | undefined): string | null {
    const raw = (modelParam || '').trim();
    if (!raw) return null;
    const lower = raw.toLowerCase();
    if (lower === 'default') return DEFAULT_MODEL;
    if (lower === 'pro') return GEMINI_MODELS.pro;
    if (lower === 'flash') return GEMINI_MODELS.flash;
    return raw;
}

function getGeminiModel(modelParam: string | null | undefined): ModelValue {
    const normalized = normalizeModelParam(modelParam);
    if (normalized && isValidModel(normalized)) {
        const modelInfo = getModelInfo(normalized);
        console.log(`🤖 AI API: Using specified model: ${modelInfo?.label} (${normalized})`);
        return normalized as ModelValue;
    }

    const defaultModelInfo = getModelInfo(DEFAULT_MODEL);
    console.log(`🤖 AI API: Using default model: ${defaultModelInfo?.label} (${DEFAULT_MODEL})`);
    return DEFAULT_MODEL as ModelValue;
}

interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{ text: string }>;
    };
  }>;
  usageMetadata?: {
    cachedContentTokenCount?: number;
    promptTokenCount?: number;
    totalTokenCount?: number;
  };
}

async function callLanguageModel(messages: ChatMessage[], model?: string, cachedContent?: string): Promise<GeminiResponse> {
    if (!GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY not configured');
    }

    const selectedModel = getGeminiModel(model);
    const modelInfo = getModelInfo(selectedModel);

    const generationConfig = {
        ...BASE_GENERATION_CONFIG,
        maxOutputTokens: modelInfo?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    };

    const contents = messages.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : msg.role,
        parts: [{ text: msg.content }]
    }));

    const requestBody = {
        contents,
        generationConfig,
        ...(cachedContent ? { cachedContent } : {}),
    };

    console.log(`🤖 AI API: Calling Gemini ${selectedModel} with ${messages.length} messages${cachedContent ? ` (cache ${cachedContent})` : ''}`);

    try {
        const response = await fetchWithTimeout(
            `${GEMINI_BASE_URL}/v1beta/models/${selectedModel}:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
            }
        );

        if (!response.ok) {
            const errorData = await response.text();
            console.error(`❌ AI API: Gemini API error ${response.status}:`, errorData);
            throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
        }

        const json = (await response.json()) as GeminiResponse;
        const cachedTokens = json.usageMetadata?.cachedContentTokenCount;
        if (typeof cachedTokens === 'number') {
            console.log(`🤖 AI API: cache hit — ${cachedTokens} cached tokens of ${json.usageMetadata?.promptTokenCount ?? '?'} prompt tokens`);
        }
        return json;

    } catch (error) {
        console.error('❌ AI API: Error calling Gemini:', error);
        throw error;
    }
}

export async function POST(request: NextRequest) {
    console.log('🤖 AI API: Incoming request');

    try {
        if (!GEMINI_API_KEY) {
            console.error('❌ AI API: GEMINI_API_KEY not configured');
            return NextResponse.json(
                { error: 'Server configuration error: Gemini API key not configured' },
                { status: 500 }
            );
        }

        const body: ChatRequest = await request.json();

        const selectedModel = getGeminiModel(body.model);
        const selectedModelInfo = getModelInfo(selectedModel);
        const maxInputTokens = selectedModelInfo?.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;

        const auth = authorizeServiceRequest(request, body.api_key);
        if (!auth.ok) {
            return NextResponse.json({ error: auth.error }, { status: auth.status });
        }

        if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
            return NextResponse.json(
                { error: 'Messages array is required and cannot be empty' },
                { status: 400 }
            );
        }

        for (const message of body.messages) {
            if (!message.role || !message.content) {
                return NextResponse.json(
                    { error: 'Each message must have role and content' },
                    { status: 400 }
                );
            }
            if (!['system', 'user', 'assistant'].includes(message.role)) {
                return NextResponse.json(
                    { error: 'Message role must be system, user, or assistant' },
                    { status: 400 }
                );
            }
        }

        const processedMessages = truncateMessages(body.messages, maxInputTokens);

        const inputTokens = processedMessages.reduce((sum, msg) => sum + estimateTokens(msg.content), 0);
        console.log(`🤖 AI API: Processing ${processedMessages.length} messages (~${inputTokens} tokens)`);

        const geminiResponse = await callLanguageModel(processedMessages, selectedModel, body.cachedContent);

        return NextResponse.json(geminiResponse);

    } catch (error) {
        console.error('❌ AI API Error:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Internal server error' },
            { status: 500 }
        );
    }
}

export async function GET() {
    const defaultInfo = getModelInfo(DEFAULT_MODEL);
    return NextResponse.json({
        message: 'AI Model Connection API is running',
        default_model: DEFAULT_MODEL,
        supported_models: AVAILABLE_MODELS.map(m => ({
            value: m.value,
            label: m.label,
            max_input_tokens: m.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
            max_output_tokens: m.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        })),
        max_input_tokens: defaultInfo?.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
        max_output_tokens: defaultInfo?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        temperature: 0.0,
        mode: 'deterministic',
        supported_methods: ['POST'],
        endpoints: {
            ai: 'POST /api/ai'
        }
    });
} 