// Shared types + parser for "how was this answer crafted" debug info:
// the model's reasoning summary, which source chunks/files were used, and
// which parts of the answer each source supports (Gemini groundingSupports).

export interface DebugSourceChunk {
  index: number; // 1-based, used for [n] citation markers in the UI
  title?: string;
  fileName?: string;
  uri?: string;
  pageNumber?: number;
  text?: string; // retrieved passage snippet
}

export interface DebugAnswerSupport {
  text: string; // a segment of the answer
  chunkIndices: number[]; // DebugSourceChunk.index values that support this segment
}

export interface AnswerDebugInfo {
  reasoning?: string;
  model?: string;
  grounded?: boolean;
  sources: DebugSourceChunk[];
  supports?: DebugAnswerSupport[];
  capturedAt?: string; // ISO timestamp, stamped on the client
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

interface RetrievedContext {
  title?: unknown;
  uri?: unknown;
  text?: unknown;
  pageNumber?: unknown;
  page?: unknown;
  documentName?: unknown;
  fileName?: unknown;
}

function readChunk(entry: unknown, index: number): DebugSourceChunk | null {
  if (!entry || typeof entry !== 'object') return null;
  const { retrievedContext, web } = entry as {
    retrievedContext?: RetrievedContext;
    web?: { title?: unknown; uri?: unknown };
  };
  const ctx = retrievedContext ?? web;
  if (!ctx) return null;

  const chunk: DebugSourceChunk = {
    index: index + 1,
    title: asString(ctx.title),
    uri: asString((ctx as RetrievedContext).uri),
    text: asString((ctx as RetrievedContext).text),
    fileName: asString((ctx as RetrievedContext).documentName) ?? asString((ctx as RetrievedContext).fileName),
    pageNumber: asNumber((ctx as RetrievedContext).pageNumber) ?? asNumber((ctx as RetrievedContext).page),
  };

  return chunk.title || chunk.uri || chunk.text || chunk.fileName ? chunk : null;
}

function readSupports(raw: unknown, validIndices: ReadonlySet<number>): DebugAnswerSupport[] {
  if (!raw || typeof raw !== 'object') return [];
  const rawSupports = (raw as { groundingSupports?: unknown }).groundingSupports;
  if (!Array.isArray(rawSupports)) return [];

  return rawSupports
    .map((entry): DebugAnswerSupport | null => {
      if (!entry || typeof entry !== 'object') return null;
      const segment = (entry as { segment?: { text?: unknown } }).segment;
      const text = asString(segment?.text);
      if (!text) return null;
      const rawChunkIndices = (entry as { groundingChunkIndices?: unknown }).groundingChunkIndices;
      const chunkIndices = Array.isArray(rawChunkIndices)
        ? rawChunkIndices
            .map((i) => (typeof i === 'number' ? i + 1 : NaN)) // 0-based -> 1-based
            .filter((i) => Number.isInteger(i) && validIndices.has(i))
        : [];
      return { text, chunkIndices };
    })
    .filter((s): s is DebugAnswerSupport => s !== null);
}

/**
 * Parse Gemini's raw `groundingMetadata` into normalized sources + answer→source
 * supports. Tolerates missing `groundingSupports` (returns empty supports).
 */
export function parseGroundingMetadata(raw: unknown): {
  sources: DebugSourceChunk[];
  supports: DebugAnswerSupport[];
} {
  if (!raw || typeof raw !== 'object') return { sources: [], supports: [] };
  const rawChunks = (raw as { groundingChunks?: unknown }).groundingChunks;
  const sources = Array.isArray(rawChunks)
    ? rawChunks
        .map((entry, i) => readChunk(entry, i))
        .filter((c): c is DebugSourceChunk => c !== null)
    : [];

  const validIndices = new Set(sources.map((s) => s.index));
  const supports = readSupports(raw, validIndices);

  return { sources, supports };
}
