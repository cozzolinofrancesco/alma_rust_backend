import type { OAuth2Client } from 'googleapis-common';
import { getCorpusById } from './registry';
import { listStoreDocuments, documentBelongsToFile } from './fileSearchStore';
import type {
  CorpusEntry,
  CorpusVerification,
  FileVerification,
  VerificationIssue,
} from './types';

// Compare each indexed registry file against the `pdf_name` actually stored on its
// chunks in the Gemini store. A subset document filter at query time matches on
// `pdf_name`; a missing/mismatched value makes the filter silently return 0 chunks
// (the "13-minute empty loop" bug). This surfaces those files so they can be healed.
export async function verifyCorpusMetadata(entry: CorpusEntry): Promise<CorpusVerification> {
  const docs = await listStoreDocuments(entry.corpusId);

  const files: FileVerification[] = [];
  // Only files that are supposed to be searchable are worth verifying.
  const indexedFiles = entry.files.filter((f) => f.status === 'indexed');

  for (const file of indexedFiles) {
    const belonging = docs.filter((d) => documentBelongsToFile(d, file));
    const foundPdfNames = Array.from(
      new Set(belonging.map((d) => (d.pdfName ?? '').trim()).filter((n) => n.length > 0)),
    );
    const failedChunks = belonging.filter((d) => d.state === 'FAILED').length;
    const hasMissing = belonging.some((d) => !d.pdfName || d.pdfName.trim().length === 0);
    const hasMismatch = belonging.some((d) => d.pdfName != null && d.pdfName !== file.name);

    // Precedence: query-breaking issues first, then indexing failures.
    let issue: VerificationIssue;
    if (belonging.length === 0) issue = 'no_chunks';
    else if (hasMissing) issue = 'missing_pdf_name';
    else if (hasMismatch) issue = 'pdf_name_mismatch';
    else if (failedChunks > 0) issue = 'failed_chunks';
    else issue = 'ok';

    files.push({
      fileId: file.fileId,
      name: file.name,
      issue,
      foundPdfNames,
      chunkCount: belonging.length,
      failedChunks,
      healable: Boolean(file.fileId) && entry.source.type === 'drive_folder',
    });
  }

  const issueCount = files.filter((f) => f.issue !== 'ok').length;
  const okCount = files.length - issueCount;

  return {
    status: issueCount > 0 ? 'needs_repair' : 'verified',
    checkedAt: new Date().toISOString(),
    files,
    okCount,
    issueCount,
  };
}

// Load a corpus by id and verify it. Used by the verify API route.
export async function verifyCorpusById(
  corpusId: string,
  auth: OAuth2Client,
): Promise<{ entry: CorpusEntry; verification: CorpusVerification }> {
  const entry = await getCorpusById(corpusId, auth);
  if (!entry) throw new Error(`Corpus ${corpusId} not found`);
  const verification = await verifyCorpusMetadata(entry);
  return { entry, verification };
}
