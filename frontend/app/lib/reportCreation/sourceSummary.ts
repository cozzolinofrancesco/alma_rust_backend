import { z } from 'zod';
import { AgentExecutionError } from '../agentExecution/errors';

const summarySchema = z.object({
  protocol_number: z.string().max(1000),
  title: z.string().max(5000),
  summary: z.string().trim().min(1).max(100_000),
  keywords: z.array(z.string().trim().min(1).max(512)).min(1).max(30),
});

export function buildSourceSummaryPrompt(name: string, mode: 'attached' | 'corpus') {
  return [mode === 'corpus' ? 'You are summarizing a single PDF from a File Search store.' : 'You are summarizing a single attached source document.',
    'Use only content from the PDF named below.',
    'Return JSON only with keys: pdf_name, protocol_number, title, summary, keywords.',
    'protocol_number and title must be extracted from the PDF content if present; otherwise use empty string.',
    'summary must be ~100 words. keywords must be 5-8 items.', '', `PDF name: ${JSON.stringify(name)}`].join('\n');
}

export function parseSourceSummary(text: string) {
  try {
    const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(text);
    return summarySchema.parse(JSON.parse(fenced?.[1] ?? text));
  } catch {
    throw new AgentExecutionError('INVALID_SOURCE_SUMMARY', 'Source preparation did not return a complete, valid JSON summary. No successful source record was created.', 422, 'source_preparation');
  }
}