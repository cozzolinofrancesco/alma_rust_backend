import fetch from 'node-fetch'
import { GoogleGenerativeAI } from "@google/generative-ai";
import { DEFAULT_API_TIMEOUT_MS } from './modelConfig';

const GEMINI_API_KEY    = process.env.GEMINI_API_KEY;
const GEMINI_ENDPOINT   = process.env.GEMINI_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta/models/embedding-001:embedContent';

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

const _embeddingModel = genAI ? genAI.getGenerativeModel({ model: "embedding-001" }) : null;

export async function getEmbedding(text: string): Promise<number[]> {
  const payload = { instances: [{ content: text }] }
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_API_TIMEOUT_MS)
  let response: Awaited<ReturnType<typeof fetch>>
  try {
    response = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GEMINI_API_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal as RequestInit['signal'],
    })
  } finally {
    clearTimeout(timeoutId)
  }
  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status}`)
  }
  const json = await response.json() as { predictions: number[][] }
  return json.predictions[0]
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must be same length')
  }
  let dot = 0
  let normA = 0
  let normB = 0
  for (const [ai, bi] of a.map((v, i) => [v, b[i]] as const)) {
    dot   += ai * bi
    normA += ai * ai
    normB += bi * bi
  }
  return (normA > 0 && normB > 0) ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0
}
