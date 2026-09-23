import { PDFDocument } from 'pdf-lib';
import { compressPdfToFit } from './pdfCompressor';
import { gsExtractRange } from './pdfOptimizer';

export interface SplitPdfResult {
  buffer: Buffer;
  name: string;
  chunkIndex: number;
  totalChunks: number;
  pageStart: number;
  pageEnd: number;
  sizeBytes: number;
  sizeMB: string;
  // Set when the chunk had to be rasterised (a single page over the byte cap that
  // could not be split further). Such a chunk is an image PDF and must be imported
  // as this mime, not as text/plain. See compressPdfToFit / enforceByteCap.
  rasterizedMime?: string;
}

export interface PageRange {
  startPage: number;
  endPage: number;
}

const MAX_PAGES_PER_CHUNK = 300;

function formatMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

async function extractPageRange(
  fileBuffer: Buffer,
  startPage: number,
  endPage: number,
  originalFileName: string
): Promise<{ buffer: Buffer; actualStartPage: number; actualEndPage: number }> {
  const pdfDoc = await PDFDocument.load(fileBuffer);
  const totalPages = pdfDoc.getPageCount();
  
  const actualStartPage = Math.max(1, Math.min(startPage, totalPages));
  const actualEndPage = Math.min(endPage, totalPages);
  
  if (actualStartPage > actualEndPage) {
    throw new Error(`Invalid page range: ${startPage}-${endPage} (PDF has ${totalPages} pages)`);
  }
  
  console.log(`📄 [PDF Range] Extracting pages ${actualStartPage}-${actualEndPage} from ${originalFileName} (${totalPages} total pages)`);
  
  if (actualStartPage === 1 && actualEndPage === totalPages) {
    return { buffer: fileBuffer, actualStartPage, actualEndPage };
  }
  
  const newPdf = await PDFDocument.create();
  const pageIndices = Array.from(
    { length: actualEndPage - actualStartPage + 1 }, 
    (_, idx) => actualStartPage - 1 + idx
  );
  const copiedPages = await newPdf.copyPages(pdfDoc, pageIndices);
  copiedPages.forEach(page => newPdf.addPage(page));
  
  const pdfBytes = await newPdf.save();
  const extractedBuffer = Buffer.from(pdfBytes);
  
  console.log(`   Extracted ${actualEndPage - actualStartPage + 1} pages (${formatMB(extractedBuffer.length)} MB)`);
  
  return { buffer: extractedBuffer, actualStartPage, actualEndPage };
}

// Gemini File Search :importFile fails (deterministic 503, message varies between
// "Failed to count tokens" and "service currently unavailable") when a chunk's
// text/plain payload is too large. Empirically a ~1.15 MB chunk fails while ~0.85 MB
// imports fine, so we keep chunks comfortably under that by recursively halving a
// chunk's page range until each piece is within the byte cap (or a single page).
async function enforceByteCap(
  chunks: SplitPdfResult[],
  fileBuffer: Buffer,
  baseName: string,
  originalFileName: string,
  maxBytesPerChunk: number,
): Promise<SplitPdfResult[]> {
  const out: SplitPdfResult[] = [];

  const pushChunk = (startPage: number, endPage: number, buffer: Buffer, rasterizedMime?: string): void => {
    out.push({
      buffer,
      name: `${baseName}_p${startPage}-${endPage}.pdf`,
      chunkIndex: 0,
      totalChunks: 0,
      pageStart: startPage,
      pageEnd: endPage,
      sizeBytes: buffer.length,
      sizeMB: formatMB(buffer.length),
      rasterizedMime,
    });
  };

  const split = async (startPage: number, endPage: number, buffer: Buffer): Promise<void> => {
    if (buffer.length <= maxBytesPerChunk) {
      pushChunk(startPage, endPage, buffer);
      return;
    }
    // pdf-lib re-embeds shared resources into every extracted range, inflating even a
    // single page far over the cap and forcing per-page rasterisation. Try Ghostscript
    // first: it deduplicates those resources, so the same range often fits the cap whole
    // (e.g. a 54-page report collapses to one chunk) with the text layer preserved. On
    // any gs failure we fall through to the existing pdf-lib halving/rasterise path.
    const gsBuffer = await gsExtractRange(fileBuffer, startPage, endPage, (line) =>
      console.log(`✂️ [PDF Splitter] ${line}`),
    );
    if (gsBuffer && gsBuffer.length <= maxBytesPerChunk) {
      console.log(`✂️ [PDF Splitter] Ghostscript compacted pages ${startPage}-${endPage} (${formatMB(buffer.length)} MB → ${formatMB(gsBuffer.length)} MB); within ${formatMB(maxBytesPerChunk)} MB cap.`);
      pushChunk(startPage, endPage, gsBuffer);
      return;
    }
    // A single page still over the byte cap can't be split further. Rather than let it
    // fail to import, rasterise it at reduced quality so it fits (lossy, last resort).
    if (endPage <= startPage) {
      const compressed = await compressPdfToFit(buffer, maxBytesPerChunk, (line) =>
        console.log(`✂️ [PDF Splitter] page ${startPage} over ${formatMB(maxBytesPerChunk)} MB cap; ${line}`),
      );
      if (compressed && compressed.length < buffer.length) {
        pushChunk(startPage, endPage, compressed, 'application/pdf');
      } else {
        pushChunk(startPage, endPage, buffer);
      }
      return;
    }
    const mid = Math.floor((startPage + endPage) / 2);
    console.log(`✂️ [PDF Splitter] Chunk pages ${startPage}-${endPage} (${formatMB(buffer.length)} MB) exceeds ${formatMB(maxBytesPerChunk)} MB cap; splitting at page ${mid}.`);
    const left = await extractPageRange(fileBuffer, startPage, mid, originalFileName);
    const right = await extractPageRange(fileBuffer, mid + 1, endPage, originalFileName);
    await split(startPage, mid, left.buffer);
    await split(mid + 1, endPage, right.buffer);
  };

  for (const c of chunks) await split(c.pageStart, c.pageEnd, c.buffer);
  return out.map((c, i) => ({ ...c, chunkIndex: i, totalChunks: out.length }));
}

export async function splitPdfIfNecessary(
  fileBuffer: Buffer,
  originalFileName: string,
  pageRange?: PageRange,
  maxPagesPerChunk?: number,
  overlapPages?: number,
  maxBytesPerChunk?: number
): Promise<SplitPdfResult[]> {
  try {
    const effectiveMaxPagesPerChunk = Math.max(1, maxPagesPerChunk ?? MAX_PAGES_PER_CHUNK);
    const effectiveOverlap = Math.max(0, overlapPages ?? 0);

    if (!originalFileName.toLowerCase().endsWith('.pdf')) {
      return [{
        buffer: fileBuffer,
        name: originalFileName,
        chunkIndex: 0,
        totalChunks: 1,
        pageStart: 1,
        pageEnd: 1,
        sizeBytes: fileBuffer.length,
        sizeMB: formatMB(fileBuffer.length),
      }];
    }

    let workingBuffer = fileBuffer;
    let rangeOffset = 0;
    
    if (pageRange && (pageRange.startPage > 1 || pageRange.endPage < 999999)) {
      const extracted = await extractPageRange(
        fileBuffer, 
        pageRange.startPage, 
        pageRange.endPage,
        originalFileName
      );
      workingBuffer = extracted.buffer;
      rangeOffset = extracted.actualStartPage - 1;
    }

    const pdfDoc = await PDFDocument.load(workingBuffer);
    const totalPages = pdfDoc.getPageCount();
    const baseName = originalFileName.replace(/\.pdf$/i, '');
    const originalRangeStart = rangeOffset + 1;
    const originalRangeEnd = rangeOffset + totalPages;

    if (totalPages <= effectiveMaxPagesPerChunk) {
      const single: SplitPdfResult[] = [{
        buffer: workingBuffer,
        name: `${baseName}_p${originalRangeStart}-${originalRangeEnd}.pdf`,
        chunkIndex: 0,
        totalChunks: 1,
        pageStart: originalRangeStart,
        pageEnd: originalRangeEnd,
        sizeBytes: workingBuffer.length,
        sizeMB: formatMB(workingBuffer.length),
      }];
      return maxBytesPerChunk
        ? await enforceByteCap(single, fileBuffer, baseName, originalFileName, maxBytesPerChunk)
        : single;
    }

    const stride = effectiveMaxPagesPerChunk - effectiveOverlap;
    const effectiveStride = Math.max(1, stride);
    const totalChunks = Math.ceil(totalPages / effectiveStride);
    const rangeInfo = pageRange ? ` (range: ${originalRangeStart}-${originalRangeEnd})` : '';
    console.log(`✂️ [PDF Splitter] Splitting ${originalFileName}${rangeInfo} (${totalPages} pages) into ~${totalChunks} chunks of ${effectiveMaxPagesPerChunk} (overlap ${effectiveOverlap})...`);
    
    const chunks: SplitPdfResult[] = [];
    let totalSplitSize = 0;
    let chunkIndex = 0;

    for (let i = 0; i < totalPages; i += effectiveStride) {
      const localPageStart = i + 1;
      const localPageEnd = Math.min(i + effectiveMaxPagesPerChunk, totalPages);
      
      const originalPageStart = rangeOffset + localPageStart;
      const originalPageEnd = rangeOffset + localPageEnd;
      
      const newPdf = await PDFDocument.create();
      
      const pageIndices = Array.from({ length: localPageEnd - localPageStart + 1 }, (_, idx) => i + idx);
      const copiedPages = await newPdf.copyPages(pdfDoc, pageIndices);
      
      copiedPages.forEach(page => newPdf.addPage(page));
      
      const pdfBytes = await newPdf.save();
      const chunkBuffer = Buffer.from(pdfBytes);
      const sizeBytes = chunkBuffer.length;
      const sizeMB = formatMB(sizeBytes);
      totalSplitSize += sizeBytes;
      
      try {
        const validationDoc = await PDFDocument.load(chunkBuffer);
        const validatedPages = validationDoc.getPageCount();
        if (validatedPages !== (localPageEnd - localPageStart + 1)) {
          console.warn(`⚠️ [PDF Splitter] Chunk ${chunkIndex + 1} validation: expected ${localPageEnd - localPageStart + 1} pages, got ${validatedPages}`);
        }
      } catch (validationError) {
        console.error(`❌ [PDF Splitter] Chunk ${chunkIndex + 1} FAILED VALIDATION (pages ${originalPageStart}-${originalPageEnd}):`, validationError);
      }
      
      chunks.push({
        buffer: chunkBuffer,
        name: `${baseName}_p${originalPageStart}-${originalPageEnd}.pdf`,
        chunkIndex,
        totalChunks,
        pageStart: originalPageStart,
        pageEnd: originalPageEnd,
        sizeBytes,
        sizeMB,
      });
      
      console.log(`  - Chunk ${chunkIndex + 1}/${totalChunks}: pages ${originalPageStart}-${originalPageEnd} | ${sizeMB} MB`);
      chunkIndex++;
    }

    const avgSize = totalSplitSize / chunks.length;
    const maxChunk = chunks.reduce((max, c) => c.sizeBytes > max.sizeBytes ? c : max, chunks[0]);
    const minChunk = chunks.reduce((min, c) => c.sizeBytes < min.sizeBytes ? c : min, chunks[0]);
    
    console.log(`📊 [PDF Splitter] Size summary for ${originalFileName}:`);
    console.log(`   Original: ${formatMB(fileBuffer.length)} MB | Split total: ${formatMB(totalSplitSize)} MB`);
    console.log(`   Avg chunk: ${formatMB(avgSize)} MB | Min: chunk ${minChunk.chunkIndex + 1} (${minChunk.sizeMB} MB) | Max: chunk ${maxChunk.chunkIndex + 1} (${maxChunk.sizeMB} MB)`);
    
    if (maxChunk.sizeBytes > avgSize * 2) {
      console.warn(`⚠️ [PDF Splitter] WARNING: Chunk ${maxChunk.chunkIndex + 1} (pages ${maxChunk.pageStart}-${maxChunk.pageEnd}) is unusually large (${maxChunk.sizeMB} MB vs avg ${formatMB(avgSize)} MB)`);
    }

    return maxBytesPerChunk
      ? await enforceByteCap(chunks, fileBuffer, baseName, originalFileName, maxBytesPerChunk)
      : chunks;
  } catch (error) {
    console.warn(`⚠️ [PDF Splitter] Failed to split PDF ${originalFileName}, returning original. Error:`, error);
    return [{
      buffer: fileBuffer,
      name: originalFileName,
      chunkIndex: 0,
      totalChunks: 1,
      pageStart: 1,
      pageEnd: 1,
      sizeBytes: fileBuffer.length,
      sizeMB: formatMB(fileBuffer.length),
    }];
  }
}
