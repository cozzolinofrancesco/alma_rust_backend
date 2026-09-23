
import { readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { uploadToGeminiFilesApi } from '@/app/lib/gemini/uploadToFilesApi';
import { splitPdfIfNecessary } from '@/app/lib/rag/pdfSplitter';
import { extractClaims } from './claimExtractionService';
import type { ClaimExtractionOutput } from './claimExtractionService';
import type { Claim } from '../types';
import { createIntegrityRecordSync } from '@/app/lib/integrity';
import type { IntegrityRecord } from '@/app/lib/integrity';

const CONCURRENT_CHUNK_LIMIT = 3;

interface SplitExtractInput {
  fileUri: string;
  mimeType: string;
  documentId: string;
  extractionPrompt: string;
  splitConfig: {
    pagesPerChunk: number;
    overlapPages: number;
  };
}

async function runInBatches<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((item, j) => fn(item, i + j))
    );
    results.push(...batchResults);
  }
  return results;
}

function deduplicateClaims(claims: Claim[]): Claim[] {
  const seen = new Set<string>();
  return claims.filter((c) => {
    const key = `${c.source_page ?? 'null'}::${c.claim_text.trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function makeClaimId(documentId: string, globalIndex: number): string {
  return `claim_${documentId.slice(0, 8)}_${globalIndex.toString().padStart(4, '0')}`;
}

export async function splitAndExtract(
  input: SplitExtractInput
): Promise<ClaimExtractionOutput> {
  const { fileUri, mimeType, documentId, extractionPrompt, splitConfig } = input;
  const { pagesPerChunk, overlapPages } = splitConfig;

  const tmpPath = path.join(tmpdir(), `cv_split_${documentId}.pdf`);
  console.log(`[SplitExtract] Reading cached PDF: ${tmpPath}`);
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await readFile(tmpPath);
  } catch (readErr) {
    throw new Error(
      `[SplitExtract] Cannot read cached PDF for document ${documentId}. ` +
      `The file may not have been uploaded via /upload or /drive-register, ` +
      `or the server was restarted since the upload. Original error: ${readErr}`
    );
  }
  const filename = `${documentId}.pdf`;

  console.log(`[SplitExtract] Splitting: pagesPerChunk=${pagesPerChunk} overlap=${overlapPages}`);
  const chunks = await splitPdfIfNecessary(
    pdfBuffer,
    filename,
    undefined,
    pagesPerChunk,
    overlapPages
  );

  console.log(`[SplitExtract] ${chunks.length} chunk(s) produced`);

  unlink(tmpPath).catch((e) => console.warn('[SplitExtract] Could not remove temp file:', e));

  if (chunks.length === 1) {
    const chunkUri = await uploadToGeminiFilesApi(chunks[0].buffer, chunks[0].name, mimeType);
    return extractClaims({
      fileUri: chunkUri,
      mimeType,
      documentId,
      extractionPrompt,
    });
  }

  type ChunkResult = {
    claims: Claim[];
    rawCount: number;
    integrity: IntegrityRecord;
    pageStart: number;
  };

  const chunkResults = await runInBatches<typeof chunks[0], ChunkResult>(
    chunks,
    CONCURRENT_CHUNK_LIMIT,
    async (chunk, idx) => {
      console.log(`[SplitExtract] Chunk ${idx + 1}/${chunks.length}: pages ${chunk.pageStart}-${chunk.pageEnd} — uploading…`);
      const chunkUri = await uploadToGeminiFilesApi(chunk.buffer, chunk.name, mimeType);

      console.log(`[SplitExtract] Chunk ${idx + 1}/${chunks.length}: extracting claims…`);
      const chunkDocId = `${documentId}_chunk${idx}`;
      const output = await extractClaims({
        fileUri: chunkUri,
        mimeType,
        documentId: chunkDocId,
        extractionPrompt,
      });

      return {
        claims: output.claims,
        rawCount: output.rawCount,
        integrity: output.extraction_integrity_record,
        pageStart: chunk.pageStart,
      };
    }
  );

  const allClaims: Claim[] = chunkResults.flatMap(({ claims, pageStart }) =>
    claims.map((c) => ({
      ...c,
      source_page:
        c.source_page != null ? c.source_page + (pageStart - 1) : null,
    }))
  );

  const dedupedClaims = deduplicateClaims(allClaims);

  const mergedClaims: Claim[] = dedupedClaims.map((c, i) => ({
    ...c,
    claim_id: makeClaimId(documentId, i),
  }));

  const totalRawCount = chunkResults.reduce((sum, r) => sum + r.rawCount, 0);

  console.log(
    `[SplitExtract] Merged: ${allClaims.length} total → ${mergedClaims.length} after dedup (raw: ${totalRawCount})`
  );

  const compositeIntegrity = createIntegrityRecordSync({
    name: `SplitExtraction: ${documentId}`,
    previousChainHash: null,
    components: [
      { type: 'user_input',  label: 'Document File URI',  value: fileUri },
      { type: 'user_input',  label: 'Document ID',        value: documentId },
      { type: 'user_input',  label: 'Pages Per Chunk',    value: pagesPerChunk },
      { type: 'user_input',  label: 'Overlap Pages',      value: overlapPages },
      { type: 'user_input',  label: 'Chunk Count',        value: chunks.length },
      { type: 'final_prompt', label: 'Extraction Prompt', value: extractionPrompt },
      {
        type: 'output',
        label: 'Chunk Integrity Records',
        value: chunkResults.map((r) => r.integrity),
      },
      {
        type: 'output',
        label: 'Merged Claims',
        value: mergedClaims.map((c) => ({
          id:   c.claim_id,
          text: c.claim_text,
          ref:  c.claim_ref ?? null,
          page: c.source_page ?? null,
        })),
      },
      { type: 'output', label: 'Raw Claim Count',    value: totalRawCount },
      { type: 'output', label: 'Merged Claim Count', value: mergedClaims.length },
    ],
  });

  return {
    claims:                     mergedClaims,
    rawCount:                   totalRawCount,
    extraction_integrity_record: compositeIntegrity,
  };
}
