// Server-side preflight classifier: decide whether a PDF is born-digital (real text
// layer) or a scan (images of text, no text layer). The scan-detection scoring lives in
// pdfClassifierCore.ts and is shared with the browser loader (pdfClassifier.client.ts)
// so the client warning and this ingestion guard never drift.
//
// pdfjs-dist (legacy build) is imported lazily — it is heavy and native-adjacent, and
// this module is pulled in transitively by every RAG route. The whole function is
// wrapped so it NEVER throws into ingestion: on any error it returns `unknown`
// (fail-open — we only block on a confident scan signal, never on doubt).

import { classifyFromDoc, type PdfClassification, type PdfjsDoc, type PdfjsOps } from './pdfClassifierCore';

export type { PdfKind, PdfClassification } from './pdfClassifierCore';

// Minimal shape of the pdfjs module entry points we use. Declared locally so we don't
// depend on the (version-mismatched) @types/pdfjs-dist and so strict mode stays happy.
interface PdfjsModule {
  getDocument(src: {
    data: Uint8Array;
    isEvalSupported?: boolean;
    disableFontFace?: boolean;
    useWorkerFetch?: boolean;
  }): { promise: Promise<PdfjsDoc> };
  OPS: PdfjsOps;
}

async function loadPdfjs(): Promise<PdfjsModule> {
  const mod = (await import('pdfjs-dist/legacy/build/pdf.js')) as unknown as
    | PdfjsModule
    | { default: PdfjsModule };
  return 'getDocument' in mod ? mod : (mod as { default: PdfjsModule }).default;
}

export async function classifyPdf(buffer: Buffer): Promise<PdfClassification> {
  const empty: Omit<PdfClassification, 'kind' | 'reason'> = {
    pagesSampled: 0, charsPerPage: 0, textReadableRatio: 0, imageOpRatio: 0, pagesWithFullImage: 0, pageImageCoverages: [],
  };
  try {
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      disableFontFace: true,
      useWorkerFetch: false,
    }).promise;
    return await classifyFromDoc(doc, pdfjs.OPS);
  } catch (err) {
    return { kind: 'unknown', reason: `classify error: ${err instanceof Error ? err.message : String(err)}`, ...empty };
  }
}

// Extract the full text layer of a PDF, page by page, for the ingestion auto-rescue path
// (when Gemini indexed a PDF as unreadable binary, we re-import this text as text/plain).
// Returns '' on any error or when there is no extractable text — the caller decides.
export async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      disableFontFace: true,
      useWorkerFetch: false,
    }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map((it) => it.str ?? '').join(' ').replace(/[ \t]+/g, ' ').trim();
      if (pageText) pages.push(pageText);
    }
    return pages.join('\n\n').trim();
  } catch {
    return '';
  }
}

// Judge whether pdfjs-extracted text is actually usable prose or glyph soup. This
// SUPPLEMENTS looksLikeUnreadableChunkText (which catches PDF structural tokens and
// control chars): PDFs with custom font encodings and no ToUnicode CMap (e.g. Veeva
// Vault exports) yield ASCII-range glyph codes that slip past that detector while being
// semantically meaningless. Here we require a healthy share of letters/whitespace.
//
// CJK is exempt: an alpha-ratio gate would wrongly reject valid Japanese/Korean/Chinese
// text, so any CJK codepoint short-circuits to "not garbled" (mirrors the CJK-safety
// stance of looksLikeUnreadableChunkText).
export function looksLikeGarbledPdfText(text: string): boolean {
  if (!text) return true;
  // CJK unified ideographs / Hiragana / Katakana / Hangul — exempt from the ASCII gate.
  if (/[぀-ヿ㐀-鿿가-힯]/.test(text)) return false;
  let alphaSpace = 0;
  let replacement = 0;
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c === 0xfffd) replacement++;
    if (
      (c >= 65 && c <= 90) || // A-Z
      (c >= 97 && c <= 122) || // a-z
      c === 32 || c === 9 || c === 10 || c === 13 // space, tab, LF, CR
    ) {
      alphaSpace++;
    }
  }
  if (replacement / text.length > 0.1) return true;
  return alphaSpace / text.length < 0.6;
}
