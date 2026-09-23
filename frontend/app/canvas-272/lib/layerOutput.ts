
import type { Canvas272Layer } from './types';

const CANDIDATE_KEYS: readonly string[] = [
  'result',
  'output',
  'assistantResponse',
  'response',
  'text',
  'completion',
  'answer',
];

export function getLayerOutputText(layer: Canvas272Layer): string {
  if (!layer) return '';
  for (const key of CANDIDATE_KEYS) {
    const val = (layer as Record<string, unknown>)[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val;
    }
  }
  return '';
}

/**
 * Data URLs of images generated on a step. Single source used by both editors,
 * both Run-All paths, and the output builders. Images are stored on `imageUrls`
 * (not `result`) so they never leak into downstream prompts.
 */
export function getLayerImageUrls(layer: Canvas272Layer): string[] {
  if (!layer) return [];
  const val = (layer as Record<string, unknown>).imageUrls;
  return Array.isArray(val) ? val.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Append a layer's generated images to its text output as markdown image syntax,
 * so the assembled document/exports render them. Data URLs require the relaxed
 * sanitize schema (see canvas-272/lib/sanitizeSchema.ts) in the HTML pipeline.
 */
export function appendLayerImagesMarkdown(text: string, layer: Canvas272Layer): string {
  const images = getLayerImageUrls(layer);
  if (images.length === 0) return text;
  const imageMarkdown = images.map((url) => `![generated image](${url})`);
  return [text.trim(), ...imageMarkdown].filter(Boolean).join('\n\n');
}

export function describeLayerOutputFields(layer: Canvas272Layer): Record<string, number> {
  const report: Record<string, number> = {};
  if (!layer) return report;
  for (const key of CANDIDATE_KEYS) {
    const val = (layer as Record<string, unknown>)[key];
    if (typeof val === 'string') {
      report[key] = val.length;
    }
  }
  return report;
}
