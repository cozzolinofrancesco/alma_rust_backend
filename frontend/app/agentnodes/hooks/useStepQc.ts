import { useCallback, useState } from 'react';
import {
  extractClaims,
  verifyClaims,
  type QcPhase,
  type QcRow,
} from '../../lib/agentStepQc';

// Sentinel stored in `error` when extraction succeeded but found nothing to
// verify — lets the panel show a distinct "no claims" message from a real error.
export const NO_CLAIMS = '__no_claims__';

// Single-step QC state machine for the step editor popup (one layer at a time),
// wrapping the shared `agentStepQc` client. The linear editor keeps the same
// flow keyed by layer id because it shows many steps at once; here a fresh hook
// instance per popup keeps it simpler.
export function useStepQc() {
  const [phase, setPhase] = useState<QcPhase>('idle');
  const [extractedClaims, setExtractedClaims] = useState<string[]>([]);
  const [selectedClaims, setSelectedClaims] = useState<number[]>([]);
  const [rows, setRows] = useState<QcRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [running, setRunning] = useState(false);

  const reset = useCallback(() => {
    setPhase('idle');
    setExtractedClaims([]);
    setSelectedClaims([]);
    setRows([]);
    setError(null);
    setExpandedRow(null);
    setRunning(false);
  }, []);

  const runExtract = useCallback(async (text: string, corpusId: string) => {
    if (!text.trim() || !corpusId) return;
    setPhase('extracting');
    setError(null);
    setRows([]);
    setExpandedRow(null);
    try {
      const { claims, noClaims } = await extractClaims(corpusId, text);
      if (noClaims || claims.length === 0) {
        setExtractedClaims([]);
        setSelectedClaims([]);
        setError(NO_CLAIMS);
        setPhase('done');
        return;
      }
      setExtractedClaims(claims);
      setSelectedClaims(claims.map((_, i) => i));
      setPhase('selecting');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'QC extraction failed');
      setPhase('idle');
    }
  }, []);

  const verifySelected = useCallback(
    async (corpusId: string) => {
      const claimsToVerify = selectedClaims
        .map((i) => extractedClaims[i])
        .filter(Boolean);
      if (!corpusId || claimsToVerify.length === 0) return;

      setPhase('verifying');
      setRunning(true);
      setError(null);
      setExpandedRow(null);
      setRows(
        claimsToVerify.map((claim) => ({
          claim,
          status: 'PENDING',
          action: '',
          ragLocation: null,
          rationale: '',
          sourceDoc: '',
        })),
      );

      try {
        await verifyClaims(corpusId, claimsToVerify, (row) => {
          setRows((prev) => {
            const idx = prev.findIndex(
              (r) => r.claim === row.claim && r.status === 'PENDING',
            );
            if (idx === -1) return [...prev, row];
            const updated = [...prev];
            updated[idx] = row;
            return updated;
          });
        });
        setPhase('done');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'QC verification failed');
        setPhase('selecting');
      } finally {
        setRunning(false);
      }
    },
    [extractedClaims, selectedClaims],
  );

  const toggleClaim = useCallback((i: number) => {
    setSelectedClaims((prev) =>
      prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i],
    );
  }, []);

  const selectAll = useCallback(() => {
    setSelectedClaims(extractedClaims.map((_, i) => i));
  }, [extractedClaims]);

  const selectNone = useCallback(() => setSelectedClaims([]), []);

  const toggleExpandedRow = useCallback((i: number) => {
    setExpandedRow((prev) => (prev === i ? null : i));
  }, []);

  const backToSelecting = useCallback(() => setPhase('selecting'), []);

  return {
    phase,
    extractedClaims,
    selectedClaims,
    rows,
    error,
    expandedRow,
    running,
    runExtract,
    verifySelected,
    toggleClaim,
    selectAll,
    selectNone,
    toggleExpandedRow,
    backToSelecting,
    reset,
  };
}

export type UseStepQc = ReturnType<typeof useStepQc>;
