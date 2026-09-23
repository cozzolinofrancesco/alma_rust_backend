import importedModels from './models.json';

export interface ModelOption {
    value: string;
    label: string;
    description: string;
    capabilities: string[];
    maxInputTokens?: number;
    maxOutputTokens?: number;
}

export const AVAILABLE_MODELS: ModelOption[] = importedModels;

// Approximate public release dates (YYYY-MM-DD) per model id. Google's API does
// not expose a release date, so this map is the source of truth for ordering the
// selector newest-first and flagging the most recent model(s). Dates are
// approximate; add an entry when a new model ships. Ids with no entry sort last.
export const MODEL_RELEASE_DATES: Record<string, string> = {
    'gemini-3-flash-preview': '2025-12-17',
    'gemini-3.1-pro-preview': '2026-02-19',
    'gemini-3.1-pro-preview-customtools': '2026-02-19',
    'gemini-3.1-flash-tts-preview': '2026-04-15',
    'gemini-3.1-flash-lite-preview': '2026-05-01',
    'gemini-3.1-flash-lite': '2026-05-07',
    'gemini-3.5-flash': '2026-05-19',
    'gemini-3-pro-image-preview': '2026-05-28',
    'gemini-3-pro-image': '2026-05-28',
    'gemini-3.1-flash-image-preview': '2026-05-28',
    'gemini-3.1-flash-image': '2026-05-28',
    'gemini-3.6-flash': '2026-07-15',
};

// Prefixed to the label of the newest model in each family. Native <select>
// options only render text, so a unicode symbol is used rather than an icon.
export const NEWEST_MODEL_MARKER = '✨ ';

type ModelFamily = 'tts' | 'image-pro' | 'image-flash' | 'pro' | 'flash' | 'other';

// Classify a model id into a family. Order matters: the more specific ids
// (tts, *-image) must be tested before the generic pro/flash substrings, since
// e.g. "gemini-3-pro-image" contains "pro" and "gemini-3.1-flash-tts-preview"
// contains "flash".
const familyOf = (modelId: string): ModelFamily => {
    if (modelId.includes('tts')) return 'tts';
    if (modelId.includes('pro-image')) return 'image-pro';
    if (modelId.includes('flash-image')) return 'image-flash';
    if (modelId.includes('pro')) return 'pro';
    if (modelId.includes('flash')) return 'flash';
    return 'other';
};

/**
 * Return the models sorted newest-first by MODEL_RELEASE_DATES, with the
 * NEWEST_MODEL_MARKER prepended to the newest model in each family (pro, flash,
 * Nano Banana Pro, Nano Banana 2, TTS). On a date tie a GA id is preferred over
 * a `-preview` one; duplicate ids are marked only once. Pure — never mutates the
 * input or its entries, so it is safe to call on the raw list on every render.
 */
export const sortModelsByRelease = (models: ModelOption[]): ModelOption[] => {
    const dateOf = (model: ModelOption): string => MODEL_RELEASE_DATES[model.value] ?? '';
    const verOf = (model: ModelOption): number => {
        const match = /gemini-(\d+(?:\.\d+)?)/.exec(model.value);
        return match ? Number.parseFloat(match[1]) : 0;
    };

    const sorted = [...models].sort((a, b) => {
        const vA = verOf(a);
        const vB = verOf(b);
        if (vA !== vB) return vB - vA;
        const dA = dateOf(a);
        const dB = dateOf(b);
        if (dA && dB && dA !== dB) return dB.localeCompare(dA);
        if (dA && !dB) return -1;
        if (!dA && dB) return 1;
        const isGaA = !a.value.includes('preview');
        const isGaB = !b.value.includes('preview');
        if (isGaA && !isGaB) return -1;
        if (!isGaA && isGaB) return 1;
        return a.value.localeCompare(b.value);
    });

    const newestByFamily = new Map<ModelFamily, { id: string; date: string; isGa: boolean }>();
    for (const model of sorted) {
        const date = dateOf(model);
        if (!date) continue;
        const family = familyOf(model.value);
        const isGa = !model.value.includes('preview');
        const current = newestByFamily.get(family);
        if (!current || date > current.date || (date === current.date && isGa && !current.isGa)) {
            newestByFamily.set(family, { id: model.value, date, isGa });
        }
    }
    const newestIds = new Set(Array.from(newestByFamily.values(), entry => entry.id));

    const marked = new Set<string>();
    return sorted.map(model => {
        if (newestIds.has(model.value) && !marked.has(model.value)) {
            marked.add(model.value);
            return { ...model, label: `${NEWEST_MODEL_MARKER}${model.label}` };
        }
        return model;
    });
};

export const GEMINI_MODELS = {
    pro: 'gemini-3.1-pro-preview',
    flash: 'gemini-3.6-flash'
} as const;

export const DEFAULT_MODEL = 'gemini-3.6-flash';

// Low-latency model for the live voice chat tier: a lite model with thinking
// disabled (thinkingBudget 0). If a preview lite model rejects a 0 budget, bump
// VOICE_FAST_THINKING_BUDGET to a small positive value (e.g. 128).
export const VOICE_FAST_MODEL = 'gemini-3.1-flash-lite';
export const VOICE_FAST_THINKING_BUDGET = 0;

// Model for the background "doing stuff" tier (heavy voice tasks: intent,
// actions, grounded replies). Kept separate from DEFAULT_MODEL so the rest of
// the app is unaffected.
export const VOICE_HEAVY_MODEL = 'gemini-3.5-flash';

// Image-generation models ("Nano Banana" family) used by /api/generate-image.
export const IMAGE_GENERATION_MODELS = {
    'gemini-3.1-flash-image-preview': 'Nano Banana 2 – fast, high-volume',
    'gemini-3-pro-image-preview': 'Nano Banana Pro – high-fidelity, complex instructions',
    'gemini-2.5-flash-image': 'Nano Banana – speed & efficiency',
} as const;

export const DEFAULT_IMAGE_MODEL: keyof typeof IMAGE_GENERATION_MODELS = 'gemini-3.1-flash-image-preview';

// True when a model id is a Nano Banana image-generation model. Steps using one
// of these route to /api/generate-image instead of the text/RAG endpoints.
export const isImageModel = (modelId: string | undefined | null): boolean =>
    typeof modelId === 'string' && modelId in IMAGE_GENERATION_MODELS;

// Append the image-generation models to a text-model option list so they are
// selectable in a step's model dropdown. Image models are excluded from
// /api/models (see EXCLUDED_MODEL_PATTERNS / getDynamicDefaultModel), so the
// dropdowns opt them in explicitly. Existing entries win (deduped by value).
export function withImageModels(models: ModelOption[]): ModelOption[] {
    const present = new Set(models.map((m) => m.value));
    const imageOptions: ModelOption[] = Object.entries(IMAGE_GENERATION_MODELS)
        .filter(([value]) => !present.has(value))
        .map(([value, description]) => ({
            value,
            label: `🍌 ${description}`,
            description,
            capabilities: ['Images'],
        }));
    return [...models, ...imageOptions];
}

// Native text-to-speech models used by geminiTextToSpeech (mono 24kHz PCM).
export const TTS_MODELS = {
    'gemini-2.5-flash-preview-tts': 'Gemini TTS – native text-to-speech',
} as const;

export const DEFAULT_TTS_MODEL: keyof typeof TTS_MODELS = 'gemini-2.5-flash-preview-tts';

export const DEFAULT_API_TIMEOUT_MS = 90 * 60 * 1_000;

// --- RAG (Gemini File Search) tuning knobs ----------------------------------
// The 300-page PDF split (DEFAULT_PAGES_PER_CHUNK in fileSearchStore.ts) only
// keeps uploads under the 100MB limit; it is NOT the retrieval chunk size. These
// values drive Gemini's retrieval chunking via chunking_config.white_space_config
// at :importFile. They are left unset on the default ingestion path (Gemini's own
// default chunker); the RAG optimizer sweeps them per index config.
export const RAG_CHUNKING_DEFAULT = {
    maxTokensPerChunk: 512,
    maxOverlapTokens: 100,
} as const;

// Embedding models selectable at File Search store creation. gemini-embedding-001
// is text-only (current default); gemini-embedding-2 is multimodal (captures
// figures/tables in PDFs). Switching the embedding model requires a NEW store —
// embeddings are not comparable across models.
export const RAG_EMBEDDING_MODELS = {
    text: 'gemini-embedding-001',
    multimodal: 'gemini-embedding-2',
} as const;

export type RagEmbeddingModel = (typeof RAG_EMBEDDING_MODELS)[keyof typeof RAG_EMBEDDING_MODELS];

export const DEFAULT_RAG_EMBEDDING_MODEL: RagEmbeddingModel = RAG_EMBEDDING_MODELS.text;

export const isValidModel = (model: string): boolean => {
    return typeof model === 'string' && model.length > 0;
};

/**
 * Dynamically resolves the highest version general chat model from an available model list,
 * falling back to DEFAULT_MODEL if no candidate is found.
 */
export const getDynamicDefaultModel = (models: ModelOption[] = AVAILABLE_MODELS): string => {
    if (!models || models.length === 0) return DEFAULT_MODEL;
    const generalChatModels = models.filter(m => {
        const val = m.value.toLowerCase();
        return !val.includes('image') && !val.includes('tts') && !val.includes('robotics') && !val.includes('customtools');
    });
    if (generalChatModels.length === 0) return models[0]?.value || DEFAULT_MODEL;
    const sorted = sortModelsByRelease(generalChatModels);
    return sorted[0]?.value || DEFAULT_MODEL;
};

/**
 * Resolve a step's model to a real model id, falling back to dynamic default model for
 * null/undefined/empty/invalid values. Both editor views must use this so a
 * step never runs against a bogus model name (e.g. the literal "DEFAULT").
 */
export const resolveStepModel = (model: unknown, models: ModelOption[] = AVAILABLE_MODELS): string =>
    typeof model === 'string' && isValidModel(model) ? model : getDynamicDefaultModel(models);

export const getModelInfo = (modelValue: string): ModelOption | undefined => {
    return AVAILABLE_MODELS.find(m => m.value === modelValue) || {
        value: modelValue,
        label: modelValue,
        description: 'Dynamically loaded model',
        capabilities: ['Audio', 'Images', 'Videos', 'Text', 'PDF'],
        maxInputTokens: 1_048_576,
        maxOutputTokens: 65_536,
    };
};

export const getDefaultModelInfo = (): ModelOption => {
    const dynamicDefault = getDynamicDefaultModel(AVAILABLE_MODELS);
    return getModelInfo(dynamicDefault) || AVAILABLE_MODELS[0];
};

export type ModelValue = string;
