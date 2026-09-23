// Browser-side preflight classifier: runs the SAME scan-detection scoring as the server
// (classifyFromDoc in pdfClassifierCore.ts) so we can warn the user the instant they pick
// a scanned/image-only PDF — before any upload — instead of only failing mid-import-job.
//
// pdfjs-dist is loaded lazily (dynamic import from the caller) so ~1.5MB of parser stays
// out of the page's initial bundle. The browser build needs a worker; we point
// GlobalWorkerOptions.workerSrc at the worker emitted as a webpack asset (offline, no CDN).
// `canvas` is already stubbed to `false` on the client build (next.config.mjs), which pdfjs
// tolerates for text/operator extraction (we never rasterise here).
//
// Fail-open: on any parse error we return `unknown` so a quirky-but-valid PDF is never
// wrongly blocked — matching the server's semantics (only a confident scan signal blocks).

import { classifyFromDoc, type PdfClassification, type PdfjsDoc, type PdfjsOps } from './pdfClassifierCore';

interface PdfjsWorkerOptions { workerSrc: string }
interface PdfjsBrowserModule {
  GlobalWorkerOptions: PdfjsWorkerOptions;
  getDocument(src: {
    data: Uint8Array;
    isEvalSupported?: boolean;
    disableFontFace?: boolean;
    useWorkerFetch?: boolean;
  }): { promise: Promise<PdfjsDoc> };
  OPS: PdfjsOps;
}

let pdfjsPromise: Promise<PdfjsBrowserModule> | null = null;

async function loadPdfjs(): Promise<PdfjsBrowserModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const mod = (await import('pdfjs-dist/legacy/build/pdf.js')) as unknown as
        | PdfjsBrowserModule
        | { default: PdfjsBrowserModule };
      const pdfjs = 'getDocument' in mod ? mod : (mod as { default: PdfjsBrowserModule }).default;
      // Emitted as a static asset by webpack; resolves to a same-origin URL at runtime.
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/legacy/build/pdf.worker.min.js',
        import.meta.url,
      ).toString();
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

export async function classifyPdfFile(file: File): Promise<PdfClassification> {
  const empty: Omit<PdfClassification, 'kind' | 'reason'> = {
    pagesSampled: 0, charsPerPage: 0, textReadableRatio: 0, imageOpRatio: 0, pagesWithFullImage: 0, pageImageCoverages: [],
  };
  try {
    const pdfjs = await loadPdfjs();
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({
      data,
      isEvalSupported: false,
      disableFontFace: true,
      useWorkerFetch: false,
    }).promise;
    const verdict = await classifyFromDoc(doc, pdfjs.OPS);
    console.log(`🔎 [preflight] ${file.name} → ${verdict.kind} (${verdict.reason}; chars/pg=${Math.round(verdict.charsPerPage)}, readable=${verdict.textReadableRatio.toFixed(2)}, imgOps=${verdict.imageOpRatio.toFixed(2)}, coveredPages=${verdict.pagesWithFullImage}/${verdict.pagesSampled}, coverage=[${verdict.pageImageCoverages.join(', ')}])`);
    return verdict;
  } catch (err) {
    console.error(`🔎 [preflight] classify FAILED for ${file.name} — allowing (fail-open):`, err);
    return { kind: 'unknown', reason: `classify error: ${err instanceof Error ? err.message : String(err)}`, ...empty };
  }
}
