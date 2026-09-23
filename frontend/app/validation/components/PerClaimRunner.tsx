'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import nextDynamic from 'next/dynamic';
import Dropzone from '@/app/components/Dropzone';
import DatabaseSourcePicker from '@/app/components/sources/DatabaseSourcePicker';
import { computeSummary } from '@/app/claim-validation/lib/resultProcessingService';
import type { Claim, SessionStatus, ValidationResult } from '@/app/claim-validation/types';
import type { PerClaimMode } from '@/app/validation/lib/referenceAdapter';

const ResultsTable = nextDynamic(() => import('@/app/claim-validation/components/ResultsTable'), { ssr: false });

// Default extraction prompt for the unified modes (the standalone Claim Validation
// tool uses QC templates; here we extract generic atomic factual claims).
const DEFAULT_EXTRACTION_PROMPT =
  'Extract the atomic, verifiable factual claims from the document. For each claim return claim_text, claim_type (one of NUMERICAL, STATISTICAL, SAFETY, EFFICACY, GENERAL), source_page, source_snippet, and extraction_confidence (0-1). Focus on specific, checkable statements rather than background or opinion.';

const PDF_ACCEPT = { 'application/pdf': ['.pdf'] };
const POLL_MS = 3000;

interface UploadedDoc { fileUri: string; filename: string; mimeType: string; documentId: string; }

interface Props { mode: PerClaimMode; }

async function uploadPdf(file: File): Promise<UploadedDoc> {
  const fd = new FormData();
  fd.append('pdf', file);
  const res = await fetch('/api/claim-validation/upload', { method: 'POST', body: fd, credentials: 'include' });
  const data = (await res.json()) as { fileUri?: string; filename?: string; mimeType?: string; document_id?: string; error?: string };
  if (!res.ok || !data.fileUri) throw new Error(data.error ?? 'Upload failed');
  return { fileUri: data.fileUri, filename: data.filename!, mimeType: data.mimeType ?? 'application/pdf', documentId: data.document_id! };
}

export default function PerClaimRunner({ mode }: Props) {
  const [subject, setSubject] = useState<UploadedDoc | null>(null);
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [reference, setReference] = useState<UploadedDoc | null>(null);
  const [dbConnectionId, setDbConnectionId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [results, setResults] = useState<ValidationResult[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const needsReference = mode === 'doc-doc';
  const needsDb = mode === 'doc-db';

  const handleSubject = useCallback(async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setError(null); setBusy('Uploading document…'); setSubject(null); setClaims(null);
    try {
      const doc = await uploadPdf(file);
      setSubject(doc);
      setBusy('Extracting claims…');
      const res = await fetch('/api/claim-validation/extract-claims', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ fileUri: doc.fileUri, mimeType: doc.mimeType, document_id: doc.documentId, extractionPrompt: DEFAULT_EXTRACTION_PROMPT }),
      });
      const data = (await res.json()) as { claims?: Claim[]; error?: string };
      if (!res.ok || !data.claims) throw new Error(data.error ?? 'Extraction failed');
      setClaims(data.claims);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  }, []);

  const handleReference = useCallback(async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setError(null); setBusy('Uploading reference…');
    try { setReference(await uploadPdf(file)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(null); }
  }, []);

  const canRun = Boolean(
    claims && claims.length > 0 && !busy && !sessionId &&
    (!needsReference || reference) && (!needsDb || dbConnectionId)
  );

  async function run() {
    if (!claims) return;
    setError(null); setBusy('Starting…');
    try {
      const res = await fetch(`/api/validation/${mode}/validate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          claims,
          documentFilename: subject?.filename,
          ...(reference ? { referenceFileUri: reference.fileUri, referenceMimeType: reference.mimeType, referenceFilename: reference.filename } : {}),
          ...(dbConnectionId ? { dbConnectionId } : {}),
        }),
      });
      const data = (await res.json()) as { sessionId?: string; error?: string };
      if (!res.ok || !data.sessionId) throw new Error(data.error ?? 'Could not start validation');
      setSessionId(data.sessionId);
      setStatus('running');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    if (!sessionId) return;
    const tick = async () => {
      try {
        const res = await fetch(`/api/claim-validation/jobs/${sessionId}`, { credentials: 'include' });
        if (!res.ok) return;
        const snap = (await res.json()) as { status: SessionStatus; results: ValidationResult[] };
        setResults(snap.results);
        setStatus(snap.status);
        if (['completed', 'failed', 'partial'].includes(snap.status) && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch { /* keep polling */ }
    };
    void tick();
    pollRef.current = setInterval(tick, POLL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [sessionId]);

  function reset() {
    if (pollRef.current) clearInterval(pollRef.current);
    setSubject(null); setClaims(null); setReference(null); setDbConnectionId(null);
    setSessionId(null); setStatus(null); setResults([]); setError(null);
  }

  const isTerminal = status != null && ['completed', 'failed', 'partial'].includes(status);

  return (
    <div className="space-y-5">
      {!sessionId && (
        <>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Subject document (PDF)</label>
            {subject ? (
              <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm">
                <span className="font-medium text-green-700">{subject.filename}</span>
                {claims && <span className="text-gray-500">· {claims.length} claims extracted</span>}
              </div>
            ) : (
              <Dropzone accept={PDF_ACCEPT} maxFiles={1} hint="Drop a PDF to extract claims" onDrop={handleSubject} />
            )}
          </div>

          {needsReference && claims && (
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">Reference document (PDF)</label>
              {reference ? (
                <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm font-medium text-green-700">{reference.filename}</div>
              ) : (
                <Dropzone accept={PDF_ACCEPT} maxFiles={1} hint="Drop the reference PDF to check claims against" onDrop={handleReference} />
              )}
            </div>
          )}

          {needsDb && claims && (
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">Database (read-only)</label>
              <DatabaseSourcePicker onTableSelected={({ connectionId }) => setDbConnectionId(connectionId)} />
              {dbConnectionId && <p className="text-xs text-green-700 mt-1">Connection selected. Only NUMERICAL / STATISTICAL claims are reconciled.</p>}
            </div>
          )}

          {mode === 'doc-public' && claims && (
            <p className="text-xs text-gray-400">Each claim is checked against OpenAlex, CrossRef and PubMed (titles + abstracts — not full text).</p>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="button"
            onClick={run}
            disabled={!canRun}
            className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ?? 'Run validation'}
          </button>
        </>
      )}

      {sessionId && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <span className="font-medium">Status:</span>
              <span className={`px-2 py-0.5 rounded-full text-xs ${isTerminal ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>{status}</span>
              {!isTerminal && <span className="text-xs text-gray-400">{results.length} done…</span>}
            </div>
            <button type="button" onClick={reset} className="text-sm text-gray-500 hover:text-indigo-600">Start over</button>
          </div>
          {results.length > 0 && (
            <ResultsTable results={results} summary={computeSummary(results)} claims={claims ?? []} hasFailures={results.some((r) => r.run_status === 'failed')} />
          )}
        </div>
      )}
    </div>
  );
}
