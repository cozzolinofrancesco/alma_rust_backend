import { z } from 'zod';
import { MAX_FILE_SIZE_BYTES } from './fileValidation';

export const driveFileIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/);
export const agentCorpusRefSchema = z.object({
  corpusId: z.string().min(1).max(256),
  displayName: z.string().max(512).optional(),
  projectId: driveFileIdSchema.optional(),
});
export type AgentCorpusRef = z.infer<typeof agentCorpusRefSchema>;

export interface AgentInputMetadata {
  fileIds?: string[];
  corpusRefs?: AgentCorpusRef[];
}

export const agentFileSchema = z.object({
  id: driveFileIdSchema,
  sourceId: driveFileIdSchema,
  name: z.string().min(1).max(512),
  mimeType: z.string().min(1).max(256),
  size: z.number().int().nonnegative().max(MAX_FILE_SIZE_BYTES),
  source: z.enum(['upload', 'drive']),
  revision: z.string().max(256).optional(),
  createdAt: z.string().datetime(),
});
export type AgentFile = z.infer<typeof agentFileSchema>;

export const agentInputMetadataSchema = z.object({
  fileIds: z.array(driveFileIdSchema).max(50).optional(),
  corpusRefs: z.array(agentCorpusRefSchema).max(20).optional(),
});

export const agentTextExtensions = new Set([
  'txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml',
  'xml', 'html', 'htm', 'tex', 'log', 'srt', 'vtt',
]);
const pdfExports = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.drawing',
]);

export function isAgentFileSupported(mimeType: string, name: string): boolean {
  if (pdfExports.has(mimeType)) return true;
  const extension = name.toLowerCase().split('.').pop() ?? '';
  if (extension === 'pdf') return !mimeType || ['application/pdf', 'application/octet-stream'].includes(mimeType);
  return agentTextExtensions.has(extension) && (!mimeType || mimeType.startsWith('text/') ||
    ['application/json', 'application/xml', 'application/yaml', 'application/x-yaml', 'application/octet-stream'].includes(mimeType));
}

export function normalizeAgentInputMetadata(value: unknown): AgentInputMetadata {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const result: AgentInputMetadata = {};
  if (Array.isArray(raw.fileIds)) {
    result.fileIds = Array.from(new Set(raw.fileIds.filter((id): id is string => driveFileIdSchema.safeParse(id).success)));
  }
  if (Array.isArray(raw.corpusRefs)) {
    const refs = new Map<string, AgentCorpusRef>();
    for (const value of raw.corpusRefs) {
      const parsed = agentCorpusRefSchema.safeParse(value);
      if (parsed.success && !refs.has(parsed.data.corpusId)) refs.set(parsed.data.corpusId, parsed.data);
    }
    result.corpusRefs = Array.from(refs.values());
  }
  return result;
}