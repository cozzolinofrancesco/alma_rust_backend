// Shared preflight scoring for PDF scan-detection, decoupled from how pdfjs is loaded.
// Two thin loaders build a pdfjs document and call classifyFromDoc: pdfClassifier.ts
// (server, Node legacy build, Buffer) and pdfClassifier.client.ts (browser build, File).
// Keeping the thresholds + verdict in one place means the client warning and the
// server ingestion guard can never drift apart.
//
// Why: Gemini File Search only indexes a text layer and does NO OCR, so a scan imports
// "successfully" but is unreadable (or low-quality) at query time. We detect scans and
// block them so the user provides a proper, born-digital / high-quality-OCR document.
//
// Three signals, any one of which marks a scan:
//   A. mojibake      — a text layer that decodes to mostly non-printable garbage.
//   B. image-only    — little/no text AND the pages are drawn from images.
//   C. searchable scan — MOST pages are backed by a full-page raster image (the scan),
//        even when an OCR text layer sits on top. Distinguished from a born-digital
//        report-with-figures by measuring each image against the page size (via the
//        current transformation matrix), so a logo/letterhead or a single figure does
//        NOT trip it — only a full-page image on the majority of sampled pages.

export type PdfKind = 'digital' | 'scanned' | 'unknown';

export interface PdfClassification {
  kind: PdfKind;
  pagesSampled: number;
  charsPerPage: number;
  textReadableRatio: number;    // printable-ASCII / total chars (0..1)
  imageOpRatio: number;         // image draws / (image draws + text shows)
  pagesWithFullImage: number;   // pages whose images cover most of the page (the "scan")
  pageImageCoverages: number[]; // per sampled page: total image area / page area (0..1), for diagnostics
  reason: string;
}

// Minimal shape of the pdfjs bits we use. Declared locally so we don't depend on the
// (version-mismatched) @types/pdfjs-dist and so strict mode stays happy without `any`.
export interface PdfjsTextItem { str?: string }
export interface PdfjsViewport { width: number; height: number }
export interface PdfjsOperatorList { fnArray: number[]; argsArray: unknown[] }
export interface PdfjsPage {
  getTextContent(): Promise<{ items: PdfjsTextItem[] }>;
  getOperatorList(): Promise<PdfjsOperatorList>;
  getViewport(params: { scale: number }): PdfjsViewport;
}
export interface PdfjsDoc { numPages: number; getPage(n: number): Promise<PdfjsPage> }
export interface PdfjsOps {
  showText: number;
  showSpacedText: number;
  save: number;
  restore: number;
  transform: number;
  paintFormXObjectBegin?: number;
  paintFormXObjectEnd?: number;
  paintImageXObject?: number;
  paintInlineImageXObject?: number;
  paintJpegXObject?: number;
  paintImageMaskXObject?: number;
}

const SAMPLE_PAGES = 5;
const MIN_CHARS_PER_PAGE = 50;      // below this = suspiciously little text
const DIGITAL_CHARS_PER_PAGE = 100; // clearly born-digital
const MIN_READABLE_RATIO = 0.6;     // printable-ASCII share for "usable" text
const PAGE_COVER_SCAN = 0.65;       // total image area ≥ 65% of the page = an image-covered page
const SCAN_PAGE_FRACTION = 0.6;     // ≥60% of sampled pages image-covered = a scan

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

// pdfjs convention: concatenating transform m onto the current matrix a (a then m).
function multiply(a: Matrix, m: Matrix): Matrix {
  return [
    a[0] * m[0] + a[2] * m[1],
    a[1] * m[0] + a[3] * m[1],
    a[0] * m[2] + a[2] * m[3],
    a[1] * m[2] + a[3] * m[3],
    a[0] * m[4] + a[2] * m[5] + a[4],
    a[1] * m[4] + a[3] * m[5] + a[5],
  ];
}

function isMatrixArgs(args: unknown): args is Matrix {
  return Array.isArray(args) && args.length === 6 && args.every((n) => typeof n === 'number');
}

// Walk a page's operator list, tracking the CTM, and sum the page area covered by raster
// images. Returns total-image-area / page-area (0..1, capped). A scanned page reads ~1.0
// whether it's ONE full-page image or MANY tiled strips (some scanners split the page image
// into bands); a born-digital page with a logo or a couple of figures reads well below the
// threshold. Text sits on top and doesn't reduce this, so a searchable scan still reads ~1.0.
function pageImageCoverage(
  ops: PdfjsOps,
  fnArray: number[],
  argsArray: unknown[],
  pageWidth: number,
  pageHeight: number,
): number {
  const pageArea = pageWidth * pageHeight;
  if (pageArea <= 0) return 0;
  const imageOpCodes = new Set<number>(
    [
      ops.paintImageXObject,
      ops.paintInlineImageXObject,
      ops.paintJpegXObject,
      ops.paintImageMaskXObject,
    ].filter((v): v is number => typeof v === 'number'),
  );

  let ctm: Matrix = IDENTITY;
  const stack: Matrix[] = [];
  let covered = 0;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    if (fn === ops.save) {
      stack.push(ctm);
    } else if (fn === ops.restore) {
      ctm = stack.pop() ?? IDENTITY;
    } else if (fn === ops.transform && isMatrixArgs(argsArray[i])) {
      ctm = multiply(ctm, argsArray[i] as Matrix);
    } else if (fn === ops.paintFormXObjectBegin) {
      // Form XObjects push their own matrix (args: [matrix, bbox]); mirror pdfjs and
      // treat begin/end like save/restore so an image drawn inside the form is measured
      // in the correct (scaled) coordinate space.
      stack.push(ctm);
      const formMatrix = Array.isArray(argsArray[i]) ? (argsArray[i] as unknown[])[0] : undefined;
      if (isMatrixArgs(formMatrix)) ctm = multiply(ctm, formMatrix);
    } else if (fn === ops.paintFormXObjectEnd) {
      ctm = stack.pop() ?? IDENTITY;
    } else if (imageOpCodes.has(fn)) {
      // A pdfjs image is drawn in the unit square; the CTM scales it to page units.
      const drawnWidth = Math.hypot(ctm[0], ctm[1]);
      const drawnHeight = Math.hypot(ctm[2], ctm[3]);
      // Clamp a single image's area to the page so an oversized draw can't inflate the sum.
      covered += Math.min(drawnWidth * drawnHeight, pageArea);
    }
  }
  return Math.min(covered / pageArea, 1);
}

// Sample up to SAMPLE_PAGES pages, compute text/image metrics, and return a verdict.
// Callers wrap this so it NEVER throws into their flow: on any error they return
// `unknown` (fail-open — we only block on a confident scan signal, never on doubt).
export async function classifyFromDoc(doc: PdfjsDoc, ops: PdfjsOps): Promise<PdfClassification> {
  const empty: Omit<PdfClassification, 'kind' | 'reason'> = {
    pagesSampled: 0, charsPerPage: 0, textReadableRatio: 0, imageOpRatio: 0, pagesWithFullImage: 0, pageImageCoverages: [],
  };

  const n = Math.min(SAMPLE_PAGES, doc.numPages);
  if (n === 0) return { kind: 'unknown', reason: 'no pages', ...empty };

  const textOpCodes = new Set<number>([ops.showText, ops.showSpacedText]);
  const imageOpCodes = new Set<number>(
    [
      ops.paintImageXObject,
      ops.paintInlineImageXObject,
      ops.paintJpegXObject,
      ops.paintImageMaskXObject,
    ].filter((v): v is number => typeof v === 'number'),
  );

  let chars = 0;
  let printable = 0;
  let textOps = 0;
  let imageOps = 0;
  let pagesWithFullImage = 0;
  const pageImageCoverages: number[] = [];

  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((it) => it.str ?? '').join('');
    chars += text.length;
    for (const ch of text) {
      const c = ch.charCodeAt(0);
      if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) printable++;
    }
    const opList = await page.getOperatorList();
    for (const fn of opList.fnArray) {
      if (textOpCodes.has(fn)) textOps++;
      else if (imageOpCodes.has(fn)) imageOps++;
    }
    const { width, height } = page.getViewport({ scale: 1 });
    const coverage = pageImageCoverage(ops, opList.fnArray, opList.argsArray, width, height);
    pageImageCoverages.push(Math.round(coverage * 100) / 100);
    if (coverage >= PAGE_COVER_SCAN) pagesWithFullImage++;
  }

  const charsPerPage = chars / n;
  const textReadableRatio = chars > 0 ? printable / chars : 0;
  const imageOpRatio = textOps + imageOps > 0 ? imageOps / (textOps + imageOps) : 0;
  const metrics = { pagesSampled: n, charsPerPage, textReadableRatio, imageOpRatio, pagesWithFullImage, pageImageCoverages };

  // Signal A — a text layer that decodes to mostly garbage.
  const unreadable = chars > 0 && textReadableRatio < MIN_READABLE_RATIO;
  // Signal B — little/no text AND the pages are drawn from images.
  const imageOnly = charsPerPage < MIN_CHARS_PER_PAGE && imageOps > 0 && textOps === 0;
  // Signal C — most pages are backed by a full-page image (a scan, with or without OCR).
  const fullPageScan = pagesWithFullImage / n >= SCAN_PAGE_FRACTION;

  if (unreadable || imageOnly || fullPageScan) {
    const reason = unreadable
      ? 'text present but unreadable (mojibake)'
      : fullPageScan
        ? `scanned document — ${pagesWithFullImage}/${n} pages are full-page images${chars > 0 ? ' (with an OCR text layer)' : ''}`
        : 'no text layer; image-only pages';
    return { kind: 'scanned', reason, ...metrics };
  }

  // Confident digital: plenty of readable text and NOT a full-page-image scan.
  if (charsPerPage >= DIGITAL_CHARS_PER_PAGE && textReadableRatio >= MIN_READABLE_RATIO) {
    return { kind: 'digital', reason: 'readable text layer', ...metrics };
  }

  // Everything else (sparse text, no images, etc.) → let it through.
  return { kind: 'unknown', reason: 'ambiguous — allowing', ...metrics };
}
