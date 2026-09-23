
import type { CorpusFile } from '@/app/lib/rag/types';

export interface RefGateResult {
  matchedFile: CorpusFile | null;
  metadataFilter: string | undefined;
  matchedRef: string | null;
}

export function parseClaimRefs(claimRef: string | null | undefined): string[] {
  if (!claimRef) return [];
  return claimRef
    .replace(/[[\]()]/g, '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function resolveReferenceFile(
  claimRef: string | null | undefined,
  indexedFiles: CorpusFile[]
): RefGateResult {
  const noGate: RefGateResult = { matchedFile: null, metadataFilter: undefined, matchedRef: null };
  const refs = parseClaimRefs(claimRef);
  if (refs.length === 0) return noGate;

  for (const ref of refs) {
    const pattern = new RegExp(`(?<![\\d])${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\d])`, 'i');
    const matched = indexedFiles.filter((f) => pattern.test(f.name));
    if (matched.length === 1) {
      return {
        matchedFile:    matched[0],
        metadataFilter: `pdf_name = "${matched[0].name}"`,
        matchedRef:     ref,
      };
    }
  }
  return noGate;
}
