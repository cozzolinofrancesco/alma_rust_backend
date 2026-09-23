
import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { getCorpusById } from '@/app/lib/rag/registry';
import { queryFileSearchStore } from '@/app/lib/rag/fileSearchStore';
import { createRefreshableAuth } from '@/app/lib/rag/auth';
import { GEMINI_MODELS } from '@/app/lib/modelConfig';
import { fetchWithTimeout } from '@/app/lib/fetchWithTimeout';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

export interface DataPoint {
  parameter: string;
  value: string;
  unit?: string;
  source?: string;
  page?: number;
}

export interface ExtractionResult {
  pdfName: string;
  dataPoints: DataPoint[];
  raw?: string;
}

export interface ParameterDiff {
  parameter: string;
  valuesByPdf: Record<string, string>;
  pdfs: string[];
}

export interface ComparisonRow {
  parameter: string;
  corpusValue: string;
  corpusSourcePdf: string;
  generatedValue: string;
  match: boolean;
}

const EXTRACTION_SYSTEM = `You are a precise scientific data extractor. Your task is to extract ALL key data points, numeric values, and measurable parameters from the specified document.
Rules:
- Extract variable/parameter names and their values exactly as printed.
- Preserve units, decimal precision, scientific notation, and inequalities (<, ≤, >, ≥).
- Include sample sizes (n), p-values, confidence intervals, means, SDs, etc.
- Output valid JSON only, no markdown or extra text.`;

function buildExtractionPrompt(pdfName: string): string {
  return `Extract ALL data points and measurable parameters from the document/file named "${pdfName}" (or any chunk of it, e.g. "${pdfName}_pages_1-300").

Return a JSON object with this exact structure:
{
  "dataPoints": [
    { "parameter": "variable name", "value": "value exactly as printed", "unit": "unit if any", "source": "brief source/context" }
  ]
}

Extract every numeric value, statistic, measurement, and parameter you find. Preserve precision.`;
}

function getBasePdfNames(files: Array<{ name: string; status: string }>): string[] {
  const baseNames = new Set<string>();
  for (const f of files) {
    if (f.status !== 'indexed') continue;
    const base = f.name.replace(/_pages_\d+-\d+$/, '');
    baseNames.add(base);
  }
  return Array.from(baseNames);
}

function parseDataPointsFromResponse(text: string): DataPoint[] {
  const dataPoints: DataPoint[] = [];
  try {
    const jsonMatch = text.match(/\{[\s\S]*"dataPoints"[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[0] : text;
    const parsed = JSON.parse(jsonStr) as { dataPoints?: Array<{ parameter?: string; value?: string; unit?: string; source?: string }> };
    const points = parsed?.dataPoints ?? [];
    for (const p of points) {
      if (p?.parameter != null && p?.value != null) {
        dataPoints.push({
          parameter: String(p.parameter).trim(),
          value: String(p.value).trim(),
          unit: p.unit != null ? String(p.unit).trim() : undefined,
          source: p.source != null ? String(p.source).trim() : undefined,
        });
      }
    }
  } catch {
    const lines = text.split(/\n/);
    for (const line of lines) {
      const m = line.match(/([^:]+):\s*(.+)/);
      if (m) {
        const param = m[1].trim();
        const val = m[2].trim();
        if (param.length > 0 && val.length > 0 && !param.toLowerCase().includes('datapoint')) {
          dataPoints.push({ parameter: param, value: val });
        }
      }
    }
  }
  return dataPoints;
}

function findParameterDiffs(extractions: ExtractionResult[]): ParameterDiff[] {
  const byParam = new Map<string, Record<string, string>>();

  for (const ext of extractions) {
    for (const dp of ext.dataPoints) {
      const key = dp.parameter.toLowerCase().trim().replace(/\s+/g, ' ');
      const val = dp.unit ? `${dp.value} ${dp.unit}`.trim() : dp.value;
      if (!byParam.has(key)) {
        byParam.set(key, {});
      }
      const prev = byParam.get(key)!;
      if (!(ext.pdfName in prev) || prev[ext.pdfName] !== val) {
        prev[ext.pdfName] = val;
      }
    }
  }

  const diffs: ParameterDiff[] = [];
  for (const [param, valuesByPdf] of byParam) {
    const pdfs = Object.keys(valuesByPdf);
    if (pdfs.length < 2) continue;
    const values = Object.values(valuesByPdf);
    const unique = new Set(values);
    if (unique.size > 1) {
      const firstParam = extractions
        .flatMap(e => e.dataPoints)
        .find(dp => dp.parameter.toLowerCase().trim().replace(/\s+/g, ' ') === param)?.parameter ?? param;
      diffs.push({
        parameter: firstParam,
        valuesByPdf,
        pdfs,
      });
    }
  }
  return diffs;
}

async function extractFromGeneratedText(text: string): Promise<DataPoint[]> {
  if (!text.trim()) return [];
  const prompt = `Extract ALL data points, numeric values, and measurable parameters from the following generated text.

Return a JSON object with this exact structure:
{
  "dataPoints": [
    { "parameter": "variable name", "value": "value exactly as printed", "unit": "unit if any" }
  ]
}

Text:
${text.slice(0, 50000)}

Output valid JSON only.`;
  const url = `${GEMINI_BASE_URL}/v1beta/models/${GEMINI_MODELS.flash}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, topP: 0.95, topK: 20 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini extraction failed: ${res.status}`);
  const json = await res.json();
  const responseText = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return parseDataPointsFromResponse(responseText);
}

function buildComparisonTable(
  extractions: ExtractionResult[],
  generatedDataPoints: DataPoint[]
): ComparisonRow[] {
  const corpusByParam = new Map<string, { value: string; sourcePdf: string }>();
  for (const ext of extractions) {
    for (const dp of ext.dataPoints) {
      const key = dp.parameter.toLowerCase().trim().replace(/\s+/g, ' ');
      const val = dp.unit ? `${dp.value} ${dp.unit}`.trim() : dp.value;
      if (!corpusByParam.has(key)) {
        corpusByParam.set(key, { value: val, sourcePdf: ext.pdfName });
      }
    }
  }
  const generatedByParam = new Map<string, string>();
  for (const dp of generatedDataPoints) {
    const key = dp.parameter.toLowerCase().trim().replace(/\s+/g, ' ');
    const val = dp.unit ? `${dp.value} ${dp.unit}`.trim() : dp.value;
    generatedByParam.set(key, val);
  }
  const allParams = new Set([...corpusByParam.keys(), ...generatedByParam.keys()]);
  const rows: ComparisonRow[] = [];
  for (const key of allParams) {
    const firstParam = [...extractions.flatMap(e => e.dataPoints), ...generatedDataPoints]
      .find(dp => dp.parameter.toLowerCase().trim().replace(/\s+/g, ' ') === key)?.parameter ?? key;
    const corpusEntry = corpusByParam.get(key);
    const corpusVal = corpusEntry?.value ?? '—';
    const corpusSourcePdf = corpusEntry?.sourcePdf ?? '';
    const genVal = generatedByParam.get(key) ?? '—';
    const match = corpusVal === genVal;
    rows.push({
      parameter: firstParam,
      corpusValue: corpusVal,
      corpusSourcePdf,
      generatedValue: genVal,
      match,
    });
  }
  return rows.sort((a, b) => a.parameter.localeCompare(b.parameter));
}

export async function POST(request: Request) {
  const session = await getApiSession(request);

  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { corpusId, generatedText } = body as { corpusId?: string; generatedText?: string };

    if (!corpusId) {
      return NextResponse.json(
        { error: 'Missing corpusId' },
        { status: 400 }
      );
    }

    const auth = createRefreshableAuth(session.accessToken, session.refreshToken);
    const corpus = await getCorpusById(corpusId, auth);

    if (!corpus) {
      return NextResponse.json({ error: 'Corpus not found' }, { status: 404 });
    }

    const indexedFiles = corpus.files?.filter(f => f.status === 'indexed') ?? [];
    const baseNames = getBasePdfNames(indexedFiles);

    if (baseNames.length === 0) {
      return NextResponse.json({
        extractions: [],
        diffs: [],
        comparisonTable: [],
        message: 'No indexed files in corpus',
      });
    }

    const extractions: ExtractionResult[] = [];

    for (const pdfName of baseNames) {
      const userPrompt = buildExtractionPrompt(pdfName);
      const result = await queryFileSearchStore(
        corpusId,
        corpus.corpusId,
        [{ role: 'user', text: userPrompt }],
        EXTRACTION_SYSTEM
      );
      const dataPoints = parseDataPointsFromResponse(result.response);
      extractions.push({
        pdfName,
        dataPoints,
        raw: result.response,
      });
    }

    const diffs = findParameterDiffs(extractions);

    let comparisonTable: ComparisonRow[] = [];
    if (generatedText && typeof generatedText === 'string') {
      const generatedDataPoints = await extractFromGeneratedText(generatedText);
      comparisonTable = buildComparisonTable(extractions, generatedDataPoints);
    }

    return NextResponse.json({
      extractions,
      diffs,
      comparisonTable,
    });
  } catch (error) {
    console.error('QC API error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'QC extraction failed' },
      { status: 500 }
    );
  }
}
