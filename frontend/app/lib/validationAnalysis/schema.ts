import { z } from 'zod';
import { stepExecuteSchema } from '../agentExecution/schema';

const identifier = z.string().min(1).max(256);
const score = z.number().min(0).max(1);
export const sequenceSchema = z.object({
  title: z.string().optional(),
  participants: z.array(z.object({ id: identifier, name: z.string(), type: z.enum(['claim', 'evidence']), pageReference: z.string().optional() })),
  notes: z.array(z.object({
    id: identifier, participant: identifier, text: z.string(), type: z.enum(['claim', 'evidence']), confidence: score,
    pageReference: z.string().optional(),
    qualityMarkers: z.object({ detected: z.array(z.string()), inferred: z.array(z.string()), confidenceInterval: z.tuple([score, score]) }).optional(),
  })),
  arrows: z.array(z.object({ id: identifier, from: identifier, to: identifier, label: z.string(), type: z.enum(['supports', 'contradicts', 'weak']), strength: score, explanation: z.string().optional() })),
  summary: z.object({ totalClaims: z.number(), totalEvidence: z.number(), strongLinks: z.number(), weakLinks: z.number() }),
});

export const networkSchema = z.object({
  title: z.string().optional(),
  nodes: z.array(z.object({
    id: identifier, label: z.string(), type: z.enum(['evidence', 'reference']), size: z.number(), color: z.string(),
    pageReference: z.string().optional(), credibilityScore: score.optional(), extractedTitle: z.string().optional(),
    extractedAuthors: z.array(z.string()).optional(), extractedYear: z.string().optional(), extractedDOI: z.string().optional(), extractedJournal: z.string().optional(),
  })).max(100),
  links: z.array(z.object({ id: identifier, source: identifier, target: identifier, strength: score, type: z.enum(['cites', 'supports', 'contradicts']), label: z.string().optional() })),
  summary: z.object({ totalEvidence: z.number(), totalReferences: z.number(), totalConnections: z.number(), avgCredibility: score, strongestCluster: z.string() }),
});

export const comparisonSchema = z.object({
  agreements: z.array(z.object({ topic: z.string(), detail: z.string() })),
  contradictions: z.array(z.object({ topic: z.string(), a_says: z.string(), b_says: z.string() })),
  unique_to_a: z.array(z.string()), unique_to_b: z.array(z.string()), summary: z.string(),
});

export const analysisRequestSchema = z.object({
  mode: z.enum(['claims', 'references', 'compare']),
  sources: stepExecuteSchema.shape.sources,
  corpusIds: z.array(identifier).max(20).default([]),
  projectId: identifier.optional(), model: z.string().min(1).max(256).optional(),
  temperature: z.number().min(0).max(2).optional(),
  step1: sequenceSchema.optional(), enrichReferences: z.boolean().default(true),
}).strict().superRefine((input, context) => {
  if (Boolean(input.sources.length) === Boolean(input.corpusIds.length)) context.addIssue({ code: 'custom', message: 'Supply sources or corpusIds, not both or neither.' });
  if (new Set(input.corpusIds).size !== input.corpusIds.length) context.addIssue({ code: 'custom', message: 'Corpus selections must be distinct.' });
  if (input.mode === 'compare' && input.corpusIds.length !== 2) context.addIssue({ code: 'custom', message: 'Comparison requires exactly two distinct corpora.' });
  if (input.mode === 'references' && !input.step1) context.addIssue({ code: 'custom', message: 'Reference analysis requires the claims/evidence result as step1.' });
});

export function parseAnalysisJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}