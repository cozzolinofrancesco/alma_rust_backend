
export interface Sect1MetaStepRow {
  id: string;
  typeName: string;
  instruction: string;
  keywords: string[];
  userInput?: string;
}

function parseKeywords(raw: string): string[] {
  const t = (raw || '').trim();
  if (!t) return [];
  return t.includes('\n')
    ? t.split('\n').map((s) => s.trim()).filter(Boolean)
    : t.split(',').map((s) => s.trim()).filter(Boolean);
}

export function parseSect1MetaRows(rows: string[][]): Sect1MetaStepRow[] {
  return rows
    .map((row, idx) => {
      const typeName = (row[0] || '').trim();
      const instruction = (row[1] || '').trim();
      const keywordsRaw = (row[2] || '').trim();
      if (!typeName || !instruction) return null;
      return {
        id: `meta-template-${idx + 1}`,
        typeName,
        instruction,
        keywords: parseKeywords(keywordsRaw),
      };
    })
    .filter((s): s is Sect1MetaStepRow => s !== null);
}

export function fileNameToKeywordTokens(fileName: string): string[] {
  const base = fileName.replace(/\.[^.]+$/i, '');
  const parts = base.split(/[\s_\-/]+/).filter(Boolean);
  const out = new Set<string>();
  [fileName, base, ...parts].forEach((s) => {
    const t = s.toLowerCase().trim();
    if (t) out.add(t);
  });
  return [...out];
}

export function matchMetaFileToStep(
  fileName: string,
  steps: Sect1MetaStepRow[]
): Sect1MetaStepRow | null {
  if (steps.length === 0) return null;

  const normalizedKeywords = fileNameToKeywordTokens(fileName);
  let best: { step: Sect1MetaStepRow; score: number } | null = null;

  for (const step of steps) {
    const templateKeywords = step.keywords.map((k) => k.toLowerCase().trim());
    let matchCount = 0;
    for (const summaryKw of normalizedKeywords) {
      for (const templateKw of templateKeywords) {
        if (
          templateKw &&
          (summaryKw.includes(templateKw) || templateKw.includes(summaryKw))
        ) {
          matchCount++;
          break;
        }
      }
    }
    const typeSlug = step.typeName.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (typeSlug && fileName.toLowerCase().includes(typeSlug)) {
      matchCount += 5;
    }
    if (matchCount > 0 && (!best || matchCount > best.score)) {
      best = { step, score: matchCount };
    }
  }

  return best?.step ?? null;
}

export function formatMetaInstruction(
  instruction: string,
  fileName: string,
  typeName: string
): string {
  return instruction
    .replace(/\{pdf_name\}/g, fileName)
    .replace(/\{type\}/g, typeName);
}

const META_RANGE = 'sect1MetaSteps!A2:C';

const INSTRUCTIONS_COLUMN_RANGE = "'INSTRUCTIONS'!B1:B500";

function normalizeSheetId(sheetId: string): string {
  return sheetId.trim().match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1] || sheetId.trim();
}

export async function fetchInstructionsTabFromSheet(
  accessToken: string,
  sheetId: string
): Promise<string> {
  const normalized = normalizeSheetId(sheetId);
  if (!normalized) return '';

  const range = encodeURIComponent(INSTRUCTIONS_COLUMN_RANGE);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${normalized}/values/${range}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.warn('INSTRUCTIONS tab fetch failed', response.status, body.slice(0, 200));
    return '';
  }

  const data = (await response.json()) as { values?: string[][] };
  const rows: string[][] = data.values || [];
  const parts: string[] = [];
  for (const row of rows) {
    const cell = (row[0] || '').trim();
    if (cell) parts.push(cell);
  }
  return parts.join('\n\n').trim();
}

export function mergeSharedBiomaterialInstruction(
  instructionsTabText: string,
  steps: Sect1MetaStepRow[]
): string {
  const fromTab = instructionsTabText.trim();
  if (fromTab) return fromTab;
  const first = steps.find((s) => s.instruction.trim());
  return first?.instruction.trim() ?? '';
}

export async function resolveSharedBiomaterialInstruction(
  accessToken: string,
  sheetId: string
): Promise<string> {
  const [fromTab, steps] = await Promise.all([
    fetchInstructionsTabFromSheet(accessToken, sheetId),
    fetchSect1MetaStepsFromSheet(accessToken, sheetId),
  ]);
  return mergeSharedBiomaterialInstruction(fromTab, steps);
}

export async function fetchSect1MetaStepsFromSheet(
  accessToken: string,
  sheetId: string
): Promise<Sect1MetaStepRow[]> {
  const normalized = normalizeSheetId(sheetId);
  if (!normalized) return [];

  const range = encodeURIComponent(META_RANGE);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${normalized}/values/${range}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error('sect1MetaSteps fetch failed', response.status, body.slice(0, 400));
    return [];
  }

  const data = await response.json();
  const rows: string[][] = data.values || [];
  return parseSect1MetaRows(rows);
}
