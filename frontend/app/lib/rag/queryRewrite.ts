// Optional query-rewrite step: turn a step's instruction/context + question into
// ONE compact retrieval query for Gemini File Search. Server-only (callGeminiJson
// reads GEMINI_API_KEY). Fails safe to the original question so a rewrite error
// never breaks a query. Used by both the RAG optimizer A/B and the live agent step
// path (gated by a per-step "Optimize query" toggle → /api/rag/query).
import { callGeminiJson } from '@/app/validation/lib/geminiRaw';

const REWRITE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { QUERY: { type: 'string' } },
  required: ['QUERY'],
};

interface RewriteOut {
  QUERY: string;
}

export async function rewriteRetrievalQuery(args: {
  question: string;
  systemInstruction?: string;
  model: string;
  signal?: AbortSignal;
}): Promise<string> {
  const question = args.question.trim();
  if (!question) return args.question;

  const system =
    'You optimize queries for a document retrieval (File Search) system. Given the task ' +
    'instructions/context and the question, output ONE concise search query that captures the ' +
    'core information need. Keep specific identifiers verbatim (study IDs, drug names, codes, ' +
    'numbers, units). Drop role/formatting/style instructions and boilerplate. No preamble. ' +
    'Return JSON with a single field QUERY.';
  const contextBlock = args.systemInstruction?.trim()
    ? `TASK INSTRUCTIONS / CONTEXT:\n${args.systemInstruction.trim().slice(0, 8000)}\n\n`
    : '';
  const prompt = `${contextBlock}QUESTION:\n${question}\n\nReturn the optimized retrieval query.`;

  try {
    const out = await callGeminiJson<RewriteOut>({
      system,
      parts: [{ text: prompt }],
      model: args.model,
      schema: REWRITE_SCHEMA,
      ...(args.signal ? { signal: args.signal, maxOutputTokens: 1024 } : {}),
    });
    const rewritten = (out.QUERY ?? '').trim();
    return rewritten.length > 0 ? rewritten : question;
  } catch {
    args.signal?.throwIfAborted();
    return question;
  }
}
