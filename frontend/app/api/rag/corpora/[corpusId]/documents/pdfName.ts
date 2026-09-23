// Pure PDF-name resolution for corpus documents. Kept free of any `next/server`
// imports so it can be unit-tested without the Next runtime.

// How the display `pdfName` was resolved, most→least trustworthy. `unresolved`
// means we could not recover the original filename from any stored metadata.
export type PdfNameSource = 'metadata' | 'chunk_name' | 'file_id' | 'unresolved';

// Recover the original filename from a chunk name like `<base>_p12-45.pdf`.
// Only re-appends `.pdf` when a page-range suffix was actually stripped; a
// non-suffixed chunk name (e.g. a small file stored whole) is returned verbatim.
export function stripChunkSuffix(chunkName: string): string {
  const stripped = chunkName.replace(/_p\d+-\d+\.pdf$/i, '');
  return stripped === chunkName ? chunkName : `${stripped}.pdf`;
}

// Resolution order: stored pdf_name → chunk_name (suffix stripped) → file_id→registry
// → last-resort display/resource name. Never returns an empty pdfName (an empty name
// renders downstream as "PDF not found" and can throw).
export function resolveCorpusDocName(input: {
  pdfNameMeta?: string;
  chunkNameMeta?: string;
  fileId?: string | null;
  registryName?: string;
  displayName?: string;
  resourceName: string;
}): { pdfName: string; pdfNameSource: PdfNameSource } {
  const { pdfNameMeta, chunkNameMeta, fileId, registryName, displayName, resourceName } = input;
  if (pdfNameMeta) return { pdfName: pdfNameMeta, pdfNameSource: 'metadata' };
  if (chunkNameMeta) return { pdfName: stripChunkSuffix(chunkNameMeta), pdfNameSource: 'chunk_name' };
  if (fileId && registryName) return { pdfName: registryName, pdfNameSource: 'file_id' };
  const fromDisplay = displayName?.trim();
  const fromResourceName = resourceName?.split('/').pop()?.trim();
  const pdfName = (fromDisplay ? stripChunkSuffix(fromDisplay) : '') || fromResourceName || resourceName;
  return { pdfName, pdfNameSource: 'unresolved' };
}
