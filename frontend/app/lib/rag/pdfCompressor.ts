import { PDFDocument } from 'pdf-lib';

// `sharp` and `pdf2pic` are native modules. They are imported lazily (inside
// compressPdfToFit) rather than at module top so that merely importing this file
// — e.g. via pdfSplitter → fileSearchStore, which every RAG route pulls in —
// does not load the native binaries at module-eval time. An eager top-level
// import crashes those routes at import time in the production build (the OCR
// routes avoid this the same way: see app/api/ocr-stream/route.ts).

// A single PDF page can exceed Gemini File Search's ~0.85 MB :importFile limit on its
// own (a high-DPI colour scan, a dense figure). Page-splitting bottoms out at one page,
// so the only remaining lever is to reduce the page's *quality*: rasterise it, re-encode
// as a smaller JPEG, and wrap that back into a one-page PDF. This is lossy and only ever
// runs on a page that would otherwise fail to import at all.

// Rasterisation resolution ladder (DPI) and JPEG quality ladder, tried coarsest-fitting
// first. A scanned A4 page at 100 DPI / q50 lands well under 1 MB, so these bracket the
// realistic range while keeping the number of GraphicsMagick renders bounded (one per DPI).
const RENDER_DENSITIES = [150, 100, 72];
const JPEG_QUALITIES = [70, 50, 35];

function formatMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

async function wrapJpegInPdf(jpeg: Buffer): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const image = await pdf.embedJpg(jpeg);
  const page = pdf.addPage([image.width, image.height]);
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  return Buffer.from(await pdf.save());
}

// Compress a single-page PDF until it fits under maxBytes, returning the smaller PDF
// buffer. Best-effort: returns the smallest buffer achieved (which may still be over
// maxBytes if the page is extreme), or null if rasterisation is unavailable/fails
// entirely (e.g. missing GraphicsMagick/Ghostscript). Never throws — the caller falls
// back to the uncompressed page.
export async function compressPdfToFit(
  pageBuffer: Buffer,
  maxBytes: number,
  log?: (line: string) => void,
): Promise<Buffer | null> {
  let smallest: Buffer | null = null;

  try {
    const { fromBuffer: pdf2picFromBuffer } = await import('pdf2pic');
    const sharp = (await import('sharp')).default;

    for (const density of RENDER_DENSITIES) {
      let rendered: Buffer;
      try {
        const convert = pdf2picFromBuffer(pageBuffer, { density, format: 'png', preserveAspectRatio: true });
        const result = await convert(1, { responseType: 'buffer' });
        if (!result.buffer) continue;
        rendered = result.buffer;
      } catch (renderErr) {
        log?.(`[compress] render at ${density} DPI failed: ${renderErr instanceof Error ? renderErr.message : renderErr}`);
        continue;
      }

      for (const quality of JPEG_QUALITIES) {
        try {
          const jpeg = await sharp(rendered).jpeg({ quality }).toBuffer();
          const candidate = await wrapJpegInPdf(jpeg);
          if (!smallest || candidate.length < smallest.length) smallest = candidate;
          if (candidate.length <= maxBytes) {
            log?.(`[compress] fit at ${density} DPI q${quality}: ${formatMB(pageBuffer.length)} MB → ${formatMB(candidate.length)} MB`);
            return candidate;
          }
        } catch (encodeErr) {
          log?.(`[compress] encode at ${density} DPI q${quality} failed: ${encodeErr instanceof Error ? encodeErr.message : encodeErr}`);
        }
      }
    }

    if (smallest) {
      log?.(`[compress] could not reach ${formatMB(maxBytes)} MB cap; smallest achieved ${formatMB(smallest.length)} MB`);
    } else {
      log?.(`[compress] rasterisation produced no output; leaving page uncompressed`);
    }
    return smallest;
  } catch (err) {
    log?.(`[compress] unexpected failure: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
