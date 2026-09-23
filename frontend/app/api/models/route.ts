import { NextResponse } from 'next/server';

interface GeminiModel {
    name: string;
    displayName?: string;
    description?: string;
    supportedGenerationMethods?: string[];
    inputTokenLimit?: number;
    outputTokenLimit?: number;
}

// Model ID patterns that are excluded from general model selectors
const EXCLUDED_MODEL_PATTERNS = [
    /robotics/i,
    /tts/i,
    /customtools/i,
    /embedding/i,
];

function extractModelVersion(name: string): number {
    const match = /gemini-(\d+(?:\.\d+)?)/.exec(name);
    return match ? Number.parseFloat(match[1]) : 0;
}

export async function GET() {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

    if (!GEMINI_API_KEY) {
        return NextResponse.json({ error: 'GEMINI_API_KEY not configured' }, { status: 500 });
    }

    try {
        const response = await fetch(`${GEMINI_BASE_URL}/v1beta/models?key=${GEMINI_API_KEY}`);
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('Failed to fetch models from Gemini:', errorText);
            return NextResponse.json({ error: `Failed to fetch models: ${response.statusText}` }, { status: response.status });
        }

        const data = await response.json();

        // 1. Filter out unsupported methods, older major versions (< 3.0), and excluded domain patterns
        const candidateModels: GeminiModel[] = (data.models || []).filter((model: GeminiModel) => {
            if (!model.supportedGenerationMethods?.includes('generateContent') || !model.name.includes('gemini')) {
                return false;
            }

            const id = model.name.replace('models/', '');

            if (EXCLUDED_MODEL_PATTERNS.some(pattern => pattern.test(id) || pattern.test(model.displayName || ''))) {
                return false;
            }

            if (extractModelVersion(model.name) < 3.0) {
                return false;
            }

            return true;
        });

        // 2. Separate image generation models from standard text/multimodal chat models
        const imageModels = candidateModels.filter(m => m.name.includes('image'));
        const generalModels = candidateModels.filter(m => !m.name.includes('image'));

        // 3. Dynamically resolve the single latest image model and sort general models by version descending
        const sortedImageModels = [...imageModels].sort((a, b) => {
            const verA = extractModelVersion(a.name);
            const verB = extractModelVersion(b.name);
            if (verB !== verA) return verB - verA;
            return b.name.localeCompare(a.name);
        });
        const latestImageModel = sortedImageModels[0];

        const sortedGeneralModels = [...generalModels].sort((a, b) => {
            const verA = extractModelVersion(a.name);
            const verB = extractModelVersion(b.name);
            if (verB !== verA) return verB - verA;
            const isGaA = !a.name.includes('preview');
            const isGaB = !b.name.includes('preview');
            if (isGaA && !isGaB) return -1;
            if (!isGaA && isGaB) return 1;
            return a.name.localeCompare(b.name);
        });

        const finalModels = [...sortedGeneralModels];
        if (latestImageModel) {
            finalModels.push(latestImageModel);
        }

        const seenValues = new Set<string>();
        const formattedModels = [];

        for (const model of finalModels) {
            const id = model.name.replace('models/', '');
            if (seenValues.has(id)) continue;
            seenValues.add(id);

            formattedModels.push({
                value: id,
                label: model.displayName || id,
                description: model.description || '',
                capabilities: ['Text', 'Images', 'Audio', 'Videos', 'PDF'],
                maxInputTokens: model.inputTokenLimit || 1_048_576,
                maxOutputTokens: model.outputTokenLimit || 65_536,
            });
        }

        const defaultModel = sortedGeneralModels[0]
            ? sortedGeneralModels[0].name.replace('models/', '')
            : 'gemini-3.6-flash';

        return NextResponse.json({ models: formattedModels, defaultModel });
    } catch (error) {
        console.error('Error fetching models:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
