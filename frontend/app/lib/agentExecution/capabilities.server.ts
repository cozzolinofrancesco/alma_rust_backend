import { AVAILABLE_MODELS, DEFAULT_MODEL, DEFAULT_IMAGE_MODEL, IMAGE_GENERATION_MODELS } from '../modelConfig';
import { MAX_REQUEST_BYTES, REQUEST_TIMEOUT_MS } from './http.server';

export const POST_OPERATIONS = [
  'steps/execute', '272/compile', '272/prepare-source', 'runs/plan', 'runs/advance',
  'documents/assemble', 'exports/json', 'exports/markdown', 'exports/docx',
] as const;

export function portableCapabilities() {
  return {
    schemaVersions: [1], basePath: '/api/v1/agentnodes',
    operations: ['GET capabilities', ...POST_OPERATIONS.map(operation => `POST ${operation}`)],
    authentication: { compute: 'x-api-key', googleSources: 'Optional Google OAuth Authorization: Bearer token', browserSessionRequired: false },
    execution: { mode: 'caller-driven', stepsPerAdvance: 1, storage: 'caller-owned', backgroundJobs: false, exactlyOnce: false },
    limits: { requestBytes: MAX_REQUEST_BYTES, combinedFileBytes: 30 * 1024 * 1024, filesPerStep: 5, pdfPagesPerStep: 1000,
      stepsPerAgent: 500, requestTimeoutMs: REQUEST_TIMEOUT_MS },
    sources: ['text', 'upload', 'authorized-corpus'], templates: ['json', 'yaml', 'authorized-google-sheet'],
    exports: ['json', 'markdown', 'docx'],
    defaults: { textModel: DEFAULT_MODEL, imageModel: DEFAULT_IMAGE_MODEL },
    models: AVAILABLE_MODELS.filter(model => model.maxInputTokens).map(model => ({ id: model.value, maxInputTokens: model.maxInputTokens, maxOutputTokens: model.maxOutputTokens })),
    imageModels: Object.keys(IMAGE_GENERATION_MODELS),
    providers: { geminiConfigured: Boolean(process.env.GEMINI_API_KEY), galileoFlagEnabled: process.env.GALILEO_ENABLED === 'true',
      liveAvailabilityVerified: false, galileoValidation: 'Catalog, configuration and input compatibility are checked per request.' },
  };
}