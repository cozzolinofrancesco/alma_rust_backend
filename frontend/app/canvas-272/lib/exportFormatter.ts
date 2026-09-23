
import type { Canvas272Agent } from './types';
import { formatAgentDisplayName, formatAgentToolbarTitle } from './agentDisplayName';
import { getLayerOutputText, appendLayerImagesMarkdown } from './layerOutput';
import { buildDiagramModel, extractActiveSortedLayers } from './sections';
import { migrateSectionNamesToTags } from './migrateSectionTags';

export interface StructuredDocStep {
  number: string;
  name: string;
  output: string;
}

export interface StructuredDocSection {
  heading: string | null;
  steps: StructuredDocStep[];
  tag?: string | null;
}

export interface StructuredDoc {
  title: string;
  agentName: string;
  exportedAt: string;
  sections: StructuredDocSection[];
}

export function stripSectionMarkerFromExportLabel(raw: string): string {
  const original = raw.trim();
  let s = original;
  if (!s) return s;
  s = s.replace(/^\[\s*SECTION\s*\d+\s*\]\s*/i, '');
  const leadingId = /^\d{5,}\s*[\u002D\u2013\u2014\u2015]\s*/u;
  while (leadingId.test(s)) {
    s = s.replace(leadingId, '');
  }
  s = s.trim();
  return s || original;
}

function shortenTechnicalLayerName(name: string): string {
  const t = name.trim();
  if (!t) return t;
  if (t.includes('_clinical_Report-agent-') || /^Report-agent-/i.test(t)) {
    return formatAgentToolbarTitle(t, null);
  }
  const hyphens = (t.match(/-/g) ?? []).length;
  const underscores = (t.match(/_/g) ?? []).length;
  if (t.length > 64 && hyphens >= 6 && underscores >= 2 && !t.includes(' ')) {
    return formatAgentToolbarTitle(t, null);
  }
  return t;
}

function sanitizeExportStepName(raw: string, doc: StructuredDoc): string {
  let s = stripSectionMarkerFromExportLabel(raw);
  s = shortenTechnicalLayerName(s);
  const an = doc.agentName.trim();
  if (an && (s === an || s === formatAgentDisplayName(an))) {
    return formatAgentToolbarTitle(an, null);
  }
  return s;
}

export function normalizeExportDisplayTitle(raw: string, doc: StructuredDoc): string {
  return sanitizeExportStepName(raw, doc);
}

function mergeConsecutiveStepsWithSameDisplayName(steps: StructuredDocStep[]): StructuredDocStep[] {
  const out: StructuredDocStep[] = [];
  for (const st of steps) {
    if (out.length === 0) {
      out.push({ ...st });
      continue;
    }
    const prev = out[out.length - 1];
    if (prev.name === st.name) {
      const a = prev.output.trim();
      const b = st.output.trim();
      prev.output = a ? (b ? `${a}\n\n${b}` : a) : b;
    } else {
      out.push({ ...st });
    }
  }
  return out;
}

function isTechnicalEmptyPlaceholderStep(name: string, output: string, doc: StructuredDoc): boolean {
  if (output.trim()) return false;
  const s = name.trim();
  if (!s) return false;
  if (s.includes('_clinical_Report-agent-')) return true;
  if (/^Report-agent-/i.test(s)) return true;
  const an = doc.agentName.trim();
  if (an && (s === an || s === formatAgentDisplayName(an))) return true;
  if (s.length > 64) {
    const hyphens = (s.match(/-/g) ?? []).length;
    const underscores = (s.match(/_/g) ?? []).length;
    if (hyphens >= 6 && underscores >= 2 && !s.includes(' ')) return true;
  }
  return false;
}

export function prepareStructuredDocForExport(doc: StructuredDoc): StructuredDoc {
  const sections: StructuredDocSection[] = doc.sections.map((section) => {
    const headingSanitized = section.heading
      ? normalizeExportDisplayTitle(section.heading, doc)
      : null;

    let steps = [...section.steps];
    steps = steps.filter((st) => !isTechnicalEmptyPlaceholderStep(st.name, st.output, doc));

    if (headingSanitized && steps.length > 0) {
      const firstDisplay = normalizeExportDisplayTitle(steps[0].name, doc);
      if (firstDisplay === headingSanitized) {
        const droppedOut = steps[0].output.trim();
        steps = steps.slice(1);
        if (droppedOut && steps.length > 0) {
          const next = steps[0];
          const nextOut = next.output.trim();
          next.output = nextOut ? `${droppedOut}\n\n${nextOut}` : droppedOut;
        }
      }
    }

    steps = steps.map((st) => ({
      ...st,
      name: normalizeExportDisplayTitle(st.name, doc),
    }));

    steps = mergeConsecutiveStepsWithSameDisplayName(steps);

    return {
      heading: headingSanitized,
      steps,
      tag: section.tag ?? null,
    };
  });

  return { ...doc, sections };
}

export function buildStructuredDoc(
  agent: Canvas272Agent,
  sidecarOutputs: Record<string, string>
): StructuredDoc {
  const model = buildDiagramModel(agent.layers);
  const migratedLayers = migrateSectionNamesToTags(agent.layers);
  const tagByLayerId = new Map<string, string>();
  for (const l of extractActiveSortedLayers(migratedLayers)) {
    const t = typeof l.tag === 'string' ? l.tag.trim() : '';
    if (t) tagByLayerId.set(l.id, t);
  }

  const sections: StructuredDocSection[] = [];

  let prelude: StructuredDocStep[] = [];
  let stepNumber = 1;

  const resolveOutput = (layerId: string, fallback: string | undefined): string => {
    const edited = sidecarOutputs[layerId];
    if (typeof edited === 'string' && edited.trim()) return edited;
    return fallback && fallback.trim() ? fallback : '';
  };

  for (const item of model.mainLane) {
    if (item.kind === 'step') {
      prelude.push({
        number: String(stepNumber),
        name: item.layer.name,
        output: appendLayerImagesMarkdown(resolveOutput(item.layer.id, getLayerOutputText(item.layer)), item.layer),
      });
      stepNumber += 1;
      continue;
    }

    if (prelude.length > 0) {
      sections.push({ heading: null, steps: prelude });
      prelude = [];
    }

    const steps: StructuredDocStep[] = [];
    steps.push({
      number: String(stepNumber),
      name: item.section.headerLayer.name,
      output: appendLayerImagesMarkdown(
        resolveOutput(item.section.headerLayer.id, getLayerOutputText(item.section.headerLayer)),
        item.section.headerLayer,
      ),
    });
    stepNumber += 1;

    item.section.children.forEach((child, i) => {
      steps.push({
        number: `${steps[0].number}.${i + 1}`,
        name: child.name,
        output: appendLayerImagesMarkdown(resolveOutput(child.id, getLayerOutputText(child)), child),
      });
      stepNumber += 1;
    });
    const headerLayer = item.section.headerLayer;
    const sectionTag = tagByLayerId.get(headerLayer.id) ?? null;
    sections.push({ heading: item.section.label, steps, tag: sectionTag });
  }

  if (prelude.length > 0) {
    sections.push({ heading: null, steps: prelude });
  }

  const displayName = formatAgentDisplayName(agent.name);
  return {
    title: displayName,
    agentName: displayName,
    exportedAt: new Date().toISOString(),
    sections,
  };
}

const STEP_LEADER_SENTINEL = '\u200c';

function unescapeStepLeaderInner(inner: string): string {
  return inner.replace(/\\([\\*])/g, '$1');
}

// Kept for backward-compatible parsing of previously-exported / edited markdown
// that may still contain step-leader lines. New exports no longer emit them.
export function parseExportedStepLeaderLine(line: string): string | null {
  const t = line.trim();
  const z = STEP_LEADER_SENTINEL;
  const zEsc = z.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wrapped = new RegExp(`^\\*\\*${zEsc}([\\s\\S]*?)${zEsc}\\*\\*\\s*$`);
  const wm = wrapped.exec(t);
  if (wm) {
    const name = unescapeStepLeaderInner(wm[1]).trim();
    return name || 'Untitled step';
  }
  const legacy = /^##\s+(.+?)\s*$/.exec(t);
  if (legacy) return legacy[1].trim();
  return null;
}

const KNOWN_EMPTY_LLM_PLACEHOLDER_LINE_RE =
  /^\*{0,2}\s*no\s+source\s+text\s+identified\.?!*\s*\*{0,2}$/i;

export function isKnownEmptyLlmPlaceholderLine(line: string): boolean {
  return KNOWN_EMPTY_LLM_PLACEHOLDER_LINE_RE.test(line.trim());
}

export function isKnownNoOutputPlaceholderLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^\(\s*no\s+output\s*\)$/i.test(t)) return true;
  if (/^_\s*\(\s*no\s+output\s*\)\s*_\s*$/i.test(t)) return true;
  if (/^\*\s*\(\s*no\s+output\s*\)\s*\*$/i.test(t)) return true;
  return false;
}

export interface SanitizeMarkdownForDocumentPreviewOptions {
  preserveCanonicalNoOutputEmphasisLines?: boolean;
}

function isPreviewNoiseLineToStrip(line: string, opts?: SanitizeMarkdownForDocumentPreviewOptions): boolean {
  const t = line.trim();
  if (isKnownEmptyLlmPlaceholderLine(t)) return true;
  if (opts?.preserveCanonicalNoOutputEmphasisLines && /^_\s*\(\s*no\s+output\s*\)\s*_\s*$/i.test(t)) {
    return false;
  }
  if (isKnownNoOutputPlaceholderLine(t)) return true;
  if (/^Input text Test\.?$/i.test(t)) return true;
  return false;
}

export function isKnownEmptyLlmPlaceholderOnlyBody(output: string): boolean {
  const lines = output
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return false;
  return lines.every((l) => isKnownEmptyLlmPlaceholderLine(l));
}

export function sanitizeMarkdownForDocumentPreview(
  markdown: string,
  opts?: SanitizeMarkdownForDocumentPreviewOptions,
): string {
  const trimmed = markdown.trim();
  if (!trimmed) return '';

  let inFence = false;
  const outLines: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const trimmedStart = line.trimStart();
    if (/^(```|~~~)/.test(trimmedStart)) {
      inFence = !inFence;
      outLines.push(line);
      continue;
    }
    if (inFence) {
      outLines.push(line);
      continue;
    }
    if (isPreviewNoiseLineToStrip(line, opts)) {
      continue;
    }
    outLines.push(line);
  }

  let result = outLines.join('\n').trim();
  result = result.replace(/\n{3,}/g, '\n\n');
  return result;
}

// Emit the document as the step outputs only — no injected section headings and
// no step-name leaders. Bodies keep their own (natural) heading levels. Empty /
// placeholder-only steps are dropped so nothing orphaned is left behind. This is
// the single source used by both the preview and every export format.
export function structuredDocToMarkdown(doc: StructuredDoc): string {
  const prepared = prepareStructuredDocForExport(doc);
  const lines: string[] = [];
  for (const section of prepared.sections) {
    for (const step of section.steps) {
      const trimmedOut = step.output.trim();
      if (!trimmedOut || isKnownEmptyLlmPlaceholderOnlyBody(step.output)) {
        continue;
      }
      lines.push(trimmedOut);
      lines.push('');
    }
  }
  return sanitizeMarkdownForDocumentPreview(lines.join('\n'));
}
