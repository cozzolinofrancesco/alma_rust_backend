
import type { StructuredDoc } from '../../canvas-272/lib/exportFormatter';

export const EXPORT_WIZARD_STORAGE_VERSION = 1 as const;

export type WizardStepPersisted = 'structure' | 'document';

export interface ExportWizardPersisted {
  v: typeof EXPORT_WIZARD_STORAGE_VERSION;
  docFingerprint: string;
  step: WizardStepPersisted;
  sectionOrder: number[];
  hiddenSectionIndices: number[];
  docVersion: string;
  activeSection: number | null;
  lastAnalysedSection: number | null;
  reviewPct: number;
  isFullscreen: boolean;
  editedMarkdown: string;
  stepOrders?: Record<number, string[]>;
}

export function exportWizardStorageKey(persistId: string): string {
  return `agentnodes:exportWizard:v${EXPORT_WIZARD_STORAGE_VERSION}:${persistId}`;
}

export function fingerprintStructuredDoc(doc: StructuredDoc): string {
  return JSON.stringify(
    doc.sections.map((s) => ({
      heading: s.heading,
      tag: s.tag ?? null,
      steps: s.steps.map((t) => ({ number: t.number, name: t.name })),
    })),
  );
}

export function validateSectionOrder(order: unknown, sectionCount: number): number[] | null {
  if (!Array.isArray(order) || order.length !== sectionCount) return null;
  const seen = new Set<number>();
  for (const x of order) {
    if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x >= sectionCount) return null;
    if (seen.has(x)) return null;
    seen.add(x);
  }
  if (seen.size !== sectionCount) return null;
  return order as number[];
}

/**
 * Tolerant validator for a persisted per-section step ordering.
 * Keeps only valid section indices and, within each, only step numbers that
 * still exist in that section (order preserved). Returns `{}` on bad input.
 */
export function validateStepOrders(
  raw: unknown,
  doc: StructuredDoc,
): Record<number, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<number, string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const sectionIdx = Number(key);
    if (!Number.isInteger(sectionIdx) || sectionIdx < 0 || sectionIdx >= doc.sections.length) {
      continue;
    }
    if (!Array.isArray(value)) continue;
    const valid = new Set(doc.sections[sectionIdx].steps.map((s) => s.number));
    const seen = new Set<string>();
    const order: string[] = [];
    for (const n of value) {
      if (typeof n === 'string' && valid.has(n) && !seen.has(n)) {
        seen.add(n);
        order.push(n);
      }
    }
    if (order.length > 0) result[sectionIdx] = order;
  }
  return result;
}

export function readExportWizardDraft(persistId: string): ExportWizardPersisted | null {
  if (typeof window === 'undefined' || !persistId) return null;
  try {
    const raw = window.localStorage.getItem(exportWizardStorageKey(persistId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ExportWizardPersisted>;
    if (parsed.v !== EXPORT_WIZARD_STORAGE_VERSION || typeof parsed.docFingerprint !== 'string') {
      return null;
    }
    return parsed as ExportWizardPersisted;
  } catch {
    return null;
  }
}

export function writeExportWizardDraft(persistId: string, draft: ExportWizardPersisted): void {
  if (typeof window === 'undefined' || !persistId) return;
  try {
    window.localStorage.setItem(exportWizardStorageKey(persistId), JSON.stringify(draft));
  } catch {
  }
}
