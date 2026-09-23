
import type { Canvas272Layer } from '../../canvas-272/lib/types';

export const SECTION_1_LAYER_TAG = 'Section 1';
export const SECTION_3_LAYER_TAG = 'Section 3';

const SECTION_1_LAYER_ID_PATTERN = /^sec1-layer-\d+$/;
const SECTION_3_LAYER_ID_PATTERN = /^sec3-layer-\d+$/;
const SECTION_1_NAME_PREFIX_PATTERN = /^\[SECTION 1\]/i;
const SECTION_3_NAME_PREFIX_PATTERN = /^\[SECTION 3\]/i;

const CORPUS_ID_PATTERN = /^(filesearch-|fileSearchStores\/)/;

function readStr(layer: Canvas272Layer, key: string): string {
  const v = (layer as unknown as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : '';
}

function readRagKnowledge(
  layer: Canvas272Layer,
): Array<{ id?: string; filename?: string; name?: string }> {
  const v = (layer as unknown as Record<string, unknown>).ragKnowledge;
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is { id?: string; filename?: string; name?: string } =>
    typeof x === 'object' && x !== null,
  );
}

export function isSection1ReportLayer(layer: Canvas272Layer): boolean {
  const tag = readStr(layer, 'tag');
  if (tag === SECTION_1_LAYER_TAG) return true;
  const name = readStr(layer, 'name').trim();
  if (name && SECTION_1_NAME_PREFIX_PATTERN.test(name)) return true;
  const id = readStr(layer, 'id').trim();
  if (id && SECTION_1_LAYER_ID_PATTERN.test(id)) return true;
  return false;
}

export function isSection3ReportLayer(layer: Canvas272Layer): boolean {
  const tag = readStr(layer, 'tag');
  if (tag === SECTION_3_LAYER_TAG) return true;
  const name = readStr(layer, 'name').trim();
  if (name && SECTION_3_NAME_PREFIX_PATTERN.test(name)) return true;
  const id = readStr(layer, 'id').trim();
  if (id && SECTION_3_LAYER_ID_PATTERN.test(id)) return true;
  return false;
}

export function isSynthesisReportLayer(layer: Canvas272Layer): boolean {
  return isSection1ReportLayer(layer) || isSection3ReportLayer(layer);
}

export function stripSynthesisClinicalCorpusBinding(layer: Canvas272Layer): {
  layer: Canvas272Layer;
  changed: boolean;
} {
  if (!isSynthesisReportLayer(layer)) {
    return { layer, changed: false };
  }

  const explicitCorpusId = readStr(layer, 'corpusId');
  const rag = readRagKnowledge(layer);

  let filtered = rag.filter((e) => {
    const id = typeof e?.id === 'string' ? e.id : '';
    if (!id) return true;
    if (CORPUS_ID_PATTERN.test(id)) return false;
    if (explicitCorpusId && id === explicitCorpusId) return false;
    return true;
  });

  if (rag.length === 1 && filtered.length === 1) {
    const onlyId = typeof rag[0]?.id === 'string' ? rag[0].id : '';
    if (onlyId) {
      filtered = [];
    }
  }

  const ragKnowledgeSameLength = filtered.length === rag.length;
  const ragKnowledgeSameIds =
    ragKnowledgeSameLength &&
    filtered.every(
      (e, i) => (typeof e?.id === 'string' ? e.id : '') === (typeof rag[i]?.id === 'string' ? rag[i].id : ''),
    );
  const needsRagUpdate = !ragKnowledgeSameIds;

  const rawDoc = (layer as unknown as Record<string, unknown>).documentSelections;
  const docArr: string[] = Array.isArray(rawDoc)
    ? rawDoc.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];

  const needsCorpusIdStrip = Boolean(explicitCorpusId);
  const needsDocClear = docArr.length > 0 && (needsCorpusIdStrip || needsRagUpdate);

  if (!needsCorpusIdStrip && !needsRagUpdate && !needsDocClear) {
    return { layer, changed: false };
  }

  const next: Canvas272Layer = { ...layer };
  if (needsCorpusIdStrip) {
    delete (next as unknown as Record<string, unknown>).corpusId;
  }
  if (needsRagUpdate) {
    (next as unknown as Record<string, unknown>).ragKnowledge = filtered;
  }
  if (needsDocClear) {
    (next as unknown as Record<string, unknown>).documentSelections = [];
  }

  return { layer: next, changed: true };
}

export const stripSection3ClinicalCorpusBinding = stripSynthesisClinicalCorpusBinding;

export function sanitizeReportCreationLayers<T extends Canvas272Layer>(layers: T[]): T[] {
  return layers.map((l) => {
    const { layer, changed } = stripSynthesisClinicalCorpusBinding(l);
    return (changed ? layer : l) as T;
  });
}
