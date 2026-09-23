import { NextResponse } from 'next/server';
import {
  AVAILABLE_MODELS,
  DEFAULT_MODEL,
  sortModelsByRelease,
  IMAGE_GENERATION_MODELS,
  DEFAULT_IMAGE_MODEL,
  TTS_MODELS,
  DEFAULT_TTS_MODEL,
  RAG_EMBEDDING_MODELS,
  DEFAULT_RAG_EMBEDDING_MODEL,
  VOICE_FAST_MODEL,
  VOICE_HEAVY_MODEL,
} from '@/app/lib/modelConfig';

// Consolidated catalog of every model the app supports, grouped by category.
// Sourced entirely from app/lib/modelConfig.ts (the single source of truth) — no
// external Gemini call, unlike GET /api/models which queries Google live.
export async function GET(): Promise<NextResponse> {
  const chat = sortModelsByRelease(AVAILABLE_MODELS).map((m) => ({
    ...m,
    default: m.value === DEFAULT_MODEL,
  }));

  const image = Object.entries(IMAGE_GENERATION_MODELS).map(([value, description]) => ({
    value,
    description,
    default: value === DEFAULT_IMAGE_MODEL,
  }));

  const tts = Object.entries(TTS_MODELS).map(([value, description]) => ({
    value,
    description,
    default: value === DEFAULT_TTS_MODEL,
  }));

  const embedding = Object.entries(RAG_EMBEDDING_MODELS).map(([kind, value]) => ({
    value,
    kind,
    default: value === DEFAULT_RAG_EMBEDDING_MODEL,
  }));

  const voice = [
    { value: VOICE_FAST_MODEL, role: 'fast' },
    { value: VOICE_HEAVY_MODEL, role: 'heavy' },
  ];

  return NextResponse.json({
    chat,
    image,
    tts,
    embedding,
    voice,
    defaults: {
      chat: DEFAULT_MODEL,
      image: DEFAULT_IMAGE_MODEL,
      tts: DEFAULT_TTS_MODEL,
      embedding: DEFAULT_RAG_EMBEDDING_MODEL,
    },
  });
}
