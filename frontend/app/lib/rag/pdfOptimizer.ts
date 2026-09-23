import { execFile } from 'child_process';
import { writeFile, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// pdf-lib's copyPages re-embeds resources shared across pages (fonts, AcroForm,
// image XObjects) into every extracted sub-PDF, so a single page can balloon to
// several MB — far over the :importFile byte cap — and the splitter degenerates to
// one rasterised chunk per page. Ghostscript's pdfwrite deduplicates those shared
// resources instead, extracting the same pages at their true size (e.g. a 54-page /
// 8 MB report → ~0.58 MB), preserving the text layer. Image downsampling is disabled
// so the shrink is pure dedup, not a quality loss.

const GS_TIMEOUT_MS = 120_000;

let counter = 0;

// Extract [firstPage, lastPage] (1-based, inclusive) from a PDF buffer via Ghostscript,
// returning the deduplicated PDF bytes — or null on any failure (gs missing, non-zero
// exit, empty/invalid output). Never throws: the caller falls back to pdf-lib extraction.
export async function gsExtractRange(
  buffer: Buffer,
  firstPage: number,
  lastPage: number,
  log?: (line: string) => void,
): Promise<Buffer | null> {
  const id = `${process.pid}-${Date.now()}-${counter++}`;
  const inPath = join(tmpdir(), `ragsplit-in-${id}.pdf`);
  const outPath = join(tmpdir(), `ragsplit-out-${id}.pdf`);

  try {
    await writeFile(inPath, buffer);

    await execFileAsync(
      'gs',
      [
        '-sDEVICE=pdfwrite',
        '-dNOPAUSE',
        '-dBATCH',
        '-dQUIET',
        '-dSAFER',
        '-dCompatibilityLevel=1.6',
        '-dDetectDuplicateImages=true',
        '-dCompressFonts=true',
        '-dDownsampleColorImages=false',
        '-dDownsampleGrayImages=false',
        '-dDownsampleMonoImages=false',
        `-dFirstPage=${firstPage}`,
        `-dLastPage=${lastPage}`,
        `-sOutputFile=${outPath}`,
        inPath,
      ],
      { timeout: GS_TIMEOUT_MS },
    );

    const out = await readFile(outPath);
    if (out.length < 5 || out.subarray(0, 5).toString('latin1') !== '%PDF-') {
      log?.(`[gs] pages ${firstPage}-${lastPage}: output missing or not a PDF; falling back`);
      return null;
    }
    return out;
  } catch (err) {
    log?.(`[gs] pages ${firstPage}-${lastPage} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    await unlink(inPath).catch(() => { /* ignore */ });
    await unlink(outPath).catch(() => { /* ignore */ });
  }
}
