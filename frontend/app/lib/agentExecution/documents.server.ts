import { z } from 'zod';
import type { Canvas272Agent } from '../../canvas-272/lib/types';
import { buildStructuredDoc, structuredDocToMarkdown } from '../../canvas-272/lib/exportFormatter';
import { structuredDocToDocxBuffer } from '../../canvas-272/lib/pandocDocx';
import { normalizeAgent } from './planner.server';
import { identifierSchema, outputVersionSchema, textSchema, type OutputVersion } from './schema';
import { hashValue } from './hash.server';
import { AgentExecutionError } from './errors';

export const structuredDocSchema = z.object({
  title: z.string().max(1000),
  agentName: z.string().max(1000),
  exportedAt: z.string().datetime({ offset: true }),
  sections: z.array(z.object({
    heading: z.string().max(1000).nullable(), tag: z.string().max(1000).nullable().optional(),
    steps: z.array(z.object({ number: z.string().max(128), name: z.string().max(1000), output: textSchema }).strict()).max(500),
  }).strict()).max(500),
}).strict();

const assembleSchema = z.object({
  agent: z.unknown(), version: z.string().max(128).optional(),
  outputs: z.record(identifierSchema, outputVersionSchema).default({}),
  outputVersions: z.record(identifierSchema, z.number().int().positive()).default({}),
  edits: z.record(identifierSchema, textSchema).default({}),
  title: z.string().max(1000).optional(), allowPartial: z.boolean().default(false),
}).strict();

export function assemblePortableDocument(raw: unknown) {
  const input = assembleSchema.parse(raw);
  const agent = normalizeAgent(input.agent, input.version);
  const layerIds = new Set(agent.layers.map(layer => layer.id));
  const selected: Record<string, OutputVersion> = { ...input.outputs };
  for (const stepId of [...Object.keys(input.outputs), ...Object.keys(input.outputVersions), ...Object.keys(input.edits)]) {
    if (!layerIds.has(stepId)) throw new AgentExecutionError('INVALID_OUTPUT_SELECTION', `Unknown output step ${stepId}.`);
  }
  for (const [stepId, version] of Object.entries(input.outputVersions)) {
    if (selected[stepId]) throw new AgentExecutionError('AMBIGUOUS_OUTPUT_SELECTION', `Select an output or a history version for ${stepId}, not both.`);
    const matches = agent.layers.find(layer => layer.id === stepId)?.outputHistory?.filter(output => output.version === version) ?? [];
    if (matches.length !== 1) throw new AgentExecutionError('OUTPUT_VERSION_NOT_FOUND', `Output version ${version} for ${stepId} is missing or ambiguous.`, 409);
    selected[stepId] = matches[0];
  }
  const missing = agent.layers.filter(layer => layer.isActive !== false && !selected[layer.id]).map(layer => layer.id);
  if (missing.length && !input.allowPartial) throw new AgentExecutionError('MISSING_OUTPUT', `Select an output version for: ${missing.join(', ')}.`);
  const layers = agent.layers.map(layer => {
    const output = selected[layer.id];
    const hasEdit = Object.prototype.hasOwnProperty.call(input.edits, layer.id);
    if (hasEdit && !output) throw new AgentExecutionError('MISSING_OUTPUT', `An edit for ${layer.id} must identify its source output version.`);
    const text = hasEdit ? input.edits[layer.id] : output?.result ?? '';
    return { ...layer, result: text, output: '', assistantResponse: '', response: '', text: '', completion: '', answer: '',
      imageUrls: output?.imageUrls ?? [] };
  });
  const doc = buildStructuredDoc({ ...agent, layers } as Canvas272Agent, {});
  if (input.title !== undefined) doc.title = input.title;
  if (missing.length) {
    doc.title = `[Partial] ${doc.title}`;
    doc.sections.unshift({ heading: null, steps: [{ number: '0', name: 'Partial report', output: `Partial report. Missing step outputs: ${missing.join(', ')}.` }] });
  }
  return {
    schemaVersion: 1, doc: structuredDocSchema.parse(doc),
    provenance: { configurationHash: hashValue(agent), outputsHash: hashValue(selected), editsHash: hashValue(input.edits),
      outputVersions: Object.fromEntries(Object.entries(selected).map(([stepId, output]) => [stepId, { version: output.version, timestamp: output.timestamp }])),
      missingStepIds: missing, partial: missing.length > 0, verifiedAuditRecord: false },
  };
}

const exportSchema = z.object({ doc: structuredDocSchema, fileName: z.string().max(240).optional() }).strict();
const formats = {
  json: { type: 'application/json; charset=utf-8', extension: 'json' },
  markdown: { type: 'text/markdown; charset=utf-8', extension: 'md' },
  docx: { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: 'docx' },
} as const;

export async function exportPortableDocument(raw: unknown, format: string, signal?: AbortSignal) {
  if (!Object.prototype.hasOwnProperty.call(formats, format)) throw new AgentExecutionError('UNSUPPORTED_EXPORT', 'Supported exports are json, markdown and docx.', 400);
  const { doc, fileName } = exportSchema.parse(raw);
  const selected = formats[format as keyof typeof formats];
  const filename = `${(fileName ?? doc.title ?? 'report').replace(/\.(?:json|md|markdown|docx)$/i, '').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 180) || 'report'}.${selected.extension}`;
  let buffer: Buffer;
  let renderer = format;
  if (format === 'json') buffer = Buffer.from(JSON.stringify(doc, null, 2));
  else if (format === 'markdown') buffer = Buffer.from(structuredDocToMarkdown(doc));
  else {
    try {
      buffer = await structuredDocToDocxBuffer(doc, { safe: true, signal, onRenderer: actual => { renderer = actual; } });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'UNSAFE_DOCUMENT_RESOURCE') {
        throw new AgentExecutionError('UNSAFE_DOCUMENT_RESOURCE', 'Only embedded image data is permitted. Local files and remote images are not fetched.', 422, 'export');
      }
      throw new AgentExecutionError('EXPORT_FAILED', 'DOCX rendering did not complete. Check document resources and server renderer availability.', 502, 'export');
    }
  }
  signal?.throwIfAborted();
  if (buffer.length > 32 * 1024 * 1024) throw new AgentExecutionError('OUTPUT_TOO_LARGE', 'The exported document exceeds 32MB.', 413, 'export');
  return new Response(buffer, { headers: {
    'Content-Type': selected.type, 'Content-Disposition': `attachment; filename="${filename}"`, 'Content-Length': String(buffer.length),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Document-Renderer': renderer,
    ...(renderer === 'plain-text' ? { 'X-Export-Warning': 'Pandoc unavailable; plain-text DOCX without rendered tables, math or images.' } : {}),
  } });
}