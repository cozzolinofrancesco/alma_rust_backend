// Prompt for comparing two knowledge bases (corpus-corpus mode). Run via the RAG
// query endpoint grounded on BOTH corpora; asks for agreements, contradictions,
// and coverage gaps as structured JSON the comparison table renders.
export const CORPUS_COMPARISON_PROMPT = `You are comparing two bodies of indexed documents (Corpus A and Corpus B) that have been provided to you via grounded retrieval.

Identify how they relate. Return ONLY a JSON object of this exact shape:
{
  "agreements": [{ "topic": string, "detail": string }],
  "contradictions": [{ "topic": string, "a_says": string, "b_says": string }],
  "unique_to_a": [string],
  "unique_to_b": [string],
  "summary": string
}

Rules:
- "agreements": claims/findings both corpora support.
- "contradictions": topics where the two corpora disagree; quote each side briefly.
- "unique_to_a" / "unique_to_b": notable themes covered by only one corpus.
- Be specific and grounded in the retrieved content. Keep each entry concise.
- Output strictly the JSON object, no markdown fences, no commentary.`;

export interface CorpusComparison {
  agreements: Array<{ topic: string; detail: string }>;
  contradictions: Array<{ topic: string; a_says: string; b_says: string }>;
  unique_to_a: string[];
  unique_to_b: string[];
  summary: string;
}

// Tolerant parser: the model may wrap JSON in prose or fences.
export function parseCorpusComparison(raw: string): CorpusComparison {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  const slice = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
  const parsed = JSON.parse(slice) as Partial<CorpusComparison>;
  return {
    agreements: parsed.agreements ?? [],
    contradictions: parsed.contradictions ?? [],
    unique_to_a: parsed.unique_to_a ?? [],
    unique_to_b: parsed.unique_to_b ?? [],
    summary: parsed.summary ?? '',
  };
}
