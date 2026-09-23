
export function priorSec3LayerIds(idx: number): string[] {
  return Array.from({ length: idx }, (_, i) => `sec3-layer-${i + 1}`);
}

export function buildSec3ReferencedSteps(
  studyIds: string[],
  metaIds: string[],
  sec3IndexZeroBased: number
): string[] {
  return [...studyIds, ...metaIds, ...priorSec3LayerIds(sec3IndexZeroBased)];
}

export function normalizeSec1StepName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^\[section\s*1\]\s*/i, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

function isHbTable(n: string): boolean {
  return n === 'hb_table' || n.endsWith('_hb_table') || (n.includes('hb') && n.includes('table'));
}

export function isSec1HbTableStep(stepName: string): boolean {
  return isHbTable(normalizeSec1StepName(stepName));
}

export function sec1SelectionRequiresBiomaterialCorpus(
  sec1Steps: Array<{ name: string; selected?: boolean }>
): boolean {
  return sec1Steps.some((s) => s.selected !== false && isSec1HbTableStep(s.name));
}

function isClinStudiesTable(n: string): boolean {
  return (
    n.includes('clinstudies') ||
    n.includes('clin_studies') ||
    n === 'clin_studies_table'
  );
}

function isSec1Overviews(n: string): boolean {
  return n === 'sec1_overviews' || (n.includes('overviews') && !n.includes('key'));
}

function isSec1KeyFindings(n: string): boolean {
  return n.includes('key_findings') || n.includes('keyfindings');
}

export interface Sec1StepNameInput {
  name: string;
}

export function buildSec1ReferencedSteps(
  stepName: string,
  sec1StepsInOrder: Sec1StepNameInput[],
  studyIds: string[],
  metaIds: string[],
  sec3Ids: string[]
): string[] {
  const n = normalizeSec1StepName(stepName);

  if (isHbTable(n)) {
    return [...metaIds];
  }

  if (isClinStudiesTable(n)) {
    return [...studyIds];
  }

  if (isSec1KeyFindings(n)) {
    const overviewsIdx = sec1StepsInOrder.findIndex((s) => isSec1Overviews(normalizeSec1StepName(s.name)));
    if (overviewsIdx < 0) return [];
    return [`sec1-layer-${overviewsIdx + 1}`];
  }

  if (isSec1Overviews(n)) {
    return [...studyIds, ...sec3Ids];
  }

  return [...studyIds, ...sec3Ids];
}
