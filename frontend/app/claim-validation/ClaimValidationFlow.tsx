'use client';

import nextDynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLanguage } from '@/app/contexts/LanguageContext';
import type {
  Claim,
  Document,
  QcType,
  SessionStatus,
  SplitConfig,
  ValidationResult,
  WorkflowState,
  WizardStep,
} from './types';
import type { JobStatusResponse, ExtractClaimsResponse } from './types';
import { useCorpora } from '@/app/lib/hooks/useCorpora';
import UploadSection      from './components/UploadSection';
import ClaimsReviewTable  from './components/ClaimsReviewTable';
import JobsPanel          from './components/JobsPanel';
import { useIntegrityChain } from '@/app/contexts/IntegrityChainContext';
import { useProjectState } from '@/app/components/CompatibilityHooks';
import type { RunRecord } from './lib/runPersistence';
import { HIDDEN_QC_RULE_LABEL } from './lib/constants';
import { computeSummary } from './lib/resultProcessingService';

const ResultsTable = nextDynamic(() => import('./components/ResultsTable'), { ssr: false });
const ClaimsResultGraph = nextDynamic(() => import('./components/ClaimsResultGraph'), { ssr: false });

function mergeResultsByClaimId(
  base: ValidationResult[],
  incoming: ValidationResult[]
): ValidationResult[] {
  const map = new Map(base.map((r) => [r.claim_id, r]));
  incoming.forEach((r) => map.set(r.claim_id, r));
  return Array.from(map.values());
}

const POLL_INTERVAL_MS = 3000;
const DRAFT_STORAGE_KEY = 'claim-validation-draft';
const CANVAS_QC_KEY = 'canvas-qc-input';

const INITIAL_STATE: WorkflowState = {
  step:             'setup',
  document:         null,
  selectedQcType:   null,
  extractionPrompt: '',
  validationPrompt: '',
  selectedCorpusId: '',
  claims:           [],
  sessionId:        null,
  sessionStatus:    null,
  results:          [],
  completedCount:   0,
  failedCount:      0,
  totalCount:       0,
  corpus_scope_sha: null,
};

export default function ClaimValidationFlow() {
  const { t } = useLanguage();
  const steps = useMemo(
    () =>
      [
        { id: 'setup' as const, label: t('claimValidation.stepSetup') },
        { id: 'review' as const, label: t('claimValidation.stepReview') },
        { id: 'results' as const, label: t('claimValidation.stepResults') },
      ] satisfies { id: WizardStep; label: string }[],
    [t]
  );
  const [state,          setState]          = useState<WorkflowState>(INITIAL_STATE);
  const [extracting,     setExtracting]     = useState(false);
  const [extractingFromCanvas, setExtractingFromCanvas] = useState(false);
  const [extractError,   setExtractError]   = useState<string | null>(null);
  const [validating,     setValidating]     = useState(false);
  const [validateError,  setValidateError]  = useState<string | null>(null);
  const [showJobsPanel,  setShowJobsPanel]  = useState(false);
  const [resultsView,    setResultsView]    = useState<'table' | 'graph'>('graph');
  const [runName,        setRunName]        = useState<string>('');

  const { projectFolder } = useProjectState();
  const selectedProjectId = projectFolder?.projectId ?? '';
  const pollTimerRef                        = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartTimeRef                    = useRef<number | null>(null);
  const resultsCacheRef = useRef<Map<string, ValidationResult>>(new Map());
  const cachedCountForRunRef = useRef(0);

  const { corpora, loading: corporaLoading } = useCorpora();

  useEffect(() => {
    if (corporaLoading) return;
    const params = new URLSearchParams(window.location.search);
    const requestedCorpusId = params.get('corpusId');
    if (!requestedCorpusId) return;
    if (!corpora.some((c) => c.id === requestedCorpusId)) return;
    setState((s) => (s.selectedCorpusId ? s : { ...s, selectedCorpusId: requestedCorpusId }));
  }, [corpora, corporaLoading]);

  const { appendRecord, clearChain } = useIntegrityChain();
  const integrityAppendedRef = useRef(false);

  useEffect(() => {
    state.results
      .filter((r) => r.run_status === 'completed')
      .forEach((r) => resultsCacheRef.current.set(r.claim_id, r));
  }, [state.results]);

  useEffect(() => {
    resultsCacheRef.current.clear();
    cachedCountForRunRef.current = 0;
    try {
      const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Record<string, unknown>;
        if (Array.isArray(saved.completedResults) && saved.completedResults.length > 0) {
          saved.completedResults = [];
          sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(saved));
        }
      }
    } catch {  }
  }, [state.selectedCorpusId]);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<WorkflowState> & {
        completedResults?: ValidationResult[];
      };
      if (Array.isArray(saved.claims) && saved.claims.length > 0) {
        setState((s) => ({
          ...s,
          claims:           saved.claims!,
          document:         saved.document ?? s.document,
          extractionPrompt: saved.extractionPrompt ?? s.extractionPrompt,
          validationPrompt: saved.validationPrompt ?? s.validationPrompt,
          selectedCorpusId: saved.selectedCorpusId ?? s.selectedCorpusId,
          results: Array.isArray(saved.completedResults) ? saved.completedResults : s.results,
          step:             'review',
        }));
      }
    } catch {  }

  }, []);

  useEffect(() => {
    const raw = sessionStorage.getItem(CANVAS_QC_KEY);
    if (!raw) return;
    sessionStorage.removeItem(CANVAS_QC_KEY);

    let parsed: { text: string; stepName?: string };
    try {
      parsed = JSON.parse(raw) as { text: string; stepName?: string };
    } catch {
      return;
    }

    if (!parsed.text?.trim()) return;

    void (async () => {
      setExtracting(true);
      setExtractingFromCanvas(true);
      setExtractError(null);

      try {
        const qcRes = await fetch('/api/claim-validation/qc-types');
        const qcData = await qcRes.json() as { qcTypes?: QcType[] };
        const visible = (qcData.qcTypes ?? []).filter(
          (qc) => qc.label !== HIDDEN_QC_RULE_LABEL
        );
        const defaultQcType = visible[0];
        if (!defaultQcType) {
          setExtractError(t('claimValidation.errNoQcTypesCanvas'));
          return;
        }

        const docId = `canvas_${Date.now()}`;
        const canvasDoc: Document = {
          document_id:      docId,
          filename:         parsed.stepName ?? t('claimValidation.canvasOutputFilename'),
          gemini_file_uri:  '',
          mime_type:        'text/plain',
          upload_timestamp: new Date().toISOString(),
          status:           'ready',
        };

        const res = await fetch('/api/claim-validation/extract-claims', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rawText:          parsed.text,
            document_id:      docId,
            extractionPrompt: defaultQcType.extraction_prompt_template,
          }),
        });

        const data = await res.json() as {
          claims?: Claim[];
          error?: string;
          extraction_integrity_record?: ExtractClaimsResponse['extraction_integrity_record'];
        };

        if (!res.ok) throw new Error(data.error ?? t('claimValidation.errCanvasExtractFailed'));

        setState((s) => ({
          ...s,
          document:                    canvasDoc,
          extractionPrompt:            defaultQcType.extraction_prompt_template,
          validationPrompt:            defaultQcType.validation_prompt_template,
          claims:                      data.claims ?? [],
          extraction_integrity_record: data.extraction_integrity_record,
          step:                        'review',
        }));
      } catch (e: unknown) {
        setExtractError(e instanceof Error ? e.message : t('claimValidation.errCanvasExtractFailed'));
      } finally {
        setExtracting(false);
        setExtractingFromCanvas(false);
      }
    })();

  }, []);

  useEffect(() => {
    if (state.claims.length === 0) return;
    try {
      sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({
        claims:           state.claims,
        document:         state.document,
        extractionPrompt: state.extractionPrompt,
        validationPrompt: state.validationPrompt,
        selectedCorpusId: state.selectedCorpusId,
        completedResults: state.results.filter((r) => r.run_status === 'completed'),
      }));
    } catch {  }
  }, [state.claims, state.document, state.extractionPrompt, state.validationPrompt, state.selectedCorpusId, state.results]);

  const setStep = (step: WizardStep) => setState((s) => ({ ...s, step }));

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const MAX_POLL_DURATION_MS = 20 * 60 * 1000;

  const startPolling = useCallback((sessionId: string) => {
    stopPolling();
    pollStartTimeRef.current = Date.now();

    const poll = async () => {
      if (
        pollStartTimeRef.current !== null &&
        Date.now() - pollStartTimeRef.current > MAX_POLL_DURATION_MS
      ) {
        stopPolling();
        setState((s) => ({ ...s, sessionStatus: 'failed' }));
        return;
      }

      try {
        const res  = await fetch(`/api/claim-validation/jobs/${sessionId}`);
        if (!res.ok) {
          if (res.status === 404) {
            stopPolling();
            setState((s) => ({ ...s, sessionStatus: 'failed' }));
          }
          return;
        }

        const data = await res.json() as JobStatusResponse;

        const cached = cachedCountForRunRef.current;
        setState((s) => ({
          ...s,
          sessionStatus:    data.status,
          results:          mergeResultsByClaimId(s.results, data.results),
          completedCount:   data.completed_count + cached,
          failedCount:      data.failed_count,
          totalCount:       data.total + cached,
          corpus_scope_sha: data.corpus_scope_sha ?? s.corpus_scope_sha,
          sessionError:     data.error_message ?? s.sessionError,
        }));

        const terminal: SessionStatus[] = ['completed', 'failed', 'partial'];
        if (terminal.includes(data.status)) {
          stopPolling();
        }
      } catch {
      }
    };

    pollTimerRef.current = setInterval(poll, POLL_INTERVAL_MS);
    poll();
  }, [stopPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const handleSetupReady = useCallback(async (params: {
    document:         Document;
    selectedCorpusId: string;
    extractionPrompt: string;
    validationPrompt: string;
    splitConfig?:     SplitConfig;
  }) => {
    if (!selectedProjectId) {
      setExtractError(t('claimValidation.errSelectProjectExtract'));
      return;
    }
    resultsCacheRef.current.clear();
    cachedCountForRunRef.current = 0;
    setExtractError(null);
    setExtracting(true);

    setState((s) => ({
      ...s,
      document:         params.document,
      extractionPrompt: params.extractionPrompt,
      validationPrompt: params.validationPrompt,
    }));

    try {
      const res  = await fetch('/api/claim-validation/extract-claims', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileUri:          params.document.gemini_file_uri,
          mimeType:         params.document.mime_type,
          document_id:      params.document.document_id,
          qcTypeId:         '',
          extractionPrompt: params.extractionPrompt,
          splitConfig:      params.splitConfig?.enabled ? params.splitConfig : undefined,
        }),
      });

      const data = await res.json() as { claims?: Claim[]; error?: string; warning?: string; extraction_integrity_record?: import('./types').ExtractClaimsResponse['extraction_integrity_record'] };

      if (!res.ok) throw new Error(data.error ?? t('claimValidation.errExtractionFailed'));

      setState((s) => ({
        ...s,
        claims:           data.claims ?? [],
        validationPrompt: params.validationPrompt,
        selectedCorpusId: params.selectedCorpusId,
        extraction_integrity_record: data.extraction_integrity_record,
        document: { ...params.document },
      }));

      setStep('review');
    } catch (e: unknown) {
      setExtractError(e instanceof Error ? e.message : t('claimValidation.errExtractionFailed'));
    } finally {
      setExtracting(false);
    }
  }, [t, selectedProjectId]);

  const handleRunValidation = useCallback(async (selectedClaims: Claim[]) => {
    if (!selectedProjectId) {
      setValidateError(t('claimValidation.errSelectProjectValidate'));
      return;
    }

    const cache = resultsCacheRef.current;

    const cachedResults = selectedClaims
      .filter((c) => c.review_status !== 'edited' && cache.has(c.claim_id))
      .map((c) => cache.get(c.claim_id)!);

    const claimsToRun = selectedClaims.filter(
      (c) => c.review_status === 'edited' || !cache.has(c.claim_id)
    );

    cachedCountForRunRef.current = cachedResults.length;

    if (claimsToRun.length === 0) {
      setState((s) => ({
        ...s,
        sessionStatus:  'completed',
        results:        cachedResults,
        totalCount:     cachedResults.length,
        completedCount: cachedResults.length,
        failedCount:    0,
        step:           'results',
      }));
      return;
    }

    setValidateError(null);
    setValidating(true);

    try {
      const res  = await fetch('/api/claim-validation/validate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claims:                   claimsToRun,
          corpusId:                 state.selectedCorpusId,
          validationPromptTemplate: state.validationPrompt,
          documentFilename:         runName.trim() || state.document?.filename,
          ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
        }),
      });

      const data = await res.json() as { sessionId?: string; error?: string };

      if (!res.ok) throw new Error(data.error ?? t('claimValidation.errValidationStartFailed'));

      const sessionId = data.sessionId!;
      setState((s) => ({
        ...s,
        sessionId,
        sessionStatus:  'pending',
        totalCount:     selectedClaims.length,
        results:        cachedResults,
        completedCount: cachedResults.length,
        failedCount:    0,
        step:           'results',
      }));

      startPolling(sessionId);
    } catch (e: unknown) {
      setValidateError(e instanceof Error ? e.message : t('claimValidation.errValidationStartFailed'));
    } finally {
      setValidating(false);
    }
  }, [state.selectedCorpusId, state.validationPrompt, state.document?.filename, startPolling, selectedProjectId, runName, t]);

  const handleLoadPastRun = useCallback(async (sessionId: string) => {
    try {
      const url = selectedProjectId
        ? `/api/claim-validation/runs/${encodeURIComponent(sessionId)}?projectId=${encodeURIComponent(selectedProjectId)}`
        : `/api/claim-validation/runs/${encodeURIComponent(sessionId)}`;
      const res  = await fetch(url);
      const data = await res.json() as RunRecord & { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to load run');

      stopPolling();
      clearChain();
      integrityAppendedRef.current = false;
      pollStartTimeRef.current = null;
      resultsCacheRef.current.clear();
      cachedCountForRunRef.current = 0;
      data.results
        .filter((r) => r.run_status === 'completed')
        .forEach((r) => resultsCacheRef.current.set(r.claim_id, r));

      const syntheticDoc: Document = {
        document_id:      data.session_id,
        filename:         data.document_filename ?? t('claimValidation.unknownDocument'),
        gemini_file_uri:  '',
        mime_type:        'application/pdf',
        upload_timestamp: data.saved_at,
        status:           'ready',
      };

      setState({
        ...INITIAL_STATE,
        document:         syntheticDoc,
        selectedCorpusId: data.corpus_id,
        claims:           data.claims,
        results:          data.results,
        sessionId:        data.session_id,
        sessionStatus:    data.status as import('./types').SessionStatus,
        totalCount:       data.total,
        completedCount:   data.completed_count,
        failedCount:      data.failed_count,
        corpus_scope_sha: data.corpus_scope_sha ?? null,
        step:             'results',
      });
    } catch (e: unknown) {
      console.error('[ClaimValidation] Failed to load past run:', e);
    }
  }, [stopPolling, clearChain, selectedProjectId, t]);

  const handleReset = () => {
    stopPolling();
    setState(INITIAL_STATE);
    setExtractError(null);
    setValidateError(null);
    setRunName('');
    clearChain();
    integrityAppendedRef.current = false;
    pollStartTimeRef.current = null;
    resultsCacheRef.current.clear();
    cachedCountForRunRef.current = 0;
    try { sessionStorage.removeItem(DRAFT_STORAGE_KEY); } catch {  }
  };

  const isTerminal  = ['completed', 'failed', 'partial'].includes(state.sessionStatus ?? '');
  const cachedClaimIds = new Set(resultsCacheRef.current.keys());

  useEffect(() => {
    if (!isTerminal || integrityAppendedRef.current) return;
    const records = state.results
      .filter((r) => r.integrity_record)
      .map((r) => r.integrity_record!);
    if (records.length === 0) return;
    records.forEach((rec) => appendRecord(rec));
    integrityAppendedRef.current = true;
  }, [isTerminal, state.results, appendRecord]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-white">
      <div className="max-w-6xl mx-auto px-4 py-8">

        {}
        <div className="mb-4">
          <label htmlFor="run-name-input" className="block text-xs font-semibold text-gray-500 mb-1 uppercase tracking-wide">
            {t('claimValidation.archiveLabel')}{' '}
            <span className="font-normal normal-case text-gray-400">{t('claimValidation.archiveHintOptional')}</span>
          </label>
          <input
            id="run-name-input"
            type="text"
            value={runName}
            onChange={(e) => setRunName(e.target.value)}
            placeholder={t('claimValidation.runNamePlaceholder')}
            maxLength={120}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>

        {}
        <div className="mb-8">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h1 className="text-3xl font-bold text-[#11074A]">{t('claimValidation.heroTitle')}</h1>
              <p className="text-gray-500 mt-1 text-sm">
                {t('claimValidation.heroSubtitle')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {}
              <button
                onClick={() => setShowJobsPanel(true)}
                className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-sm text-indigo-700 hover:bg-indigo-100 flex items-center gap-2 font-medium transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                </svg>
                {t('claimValidation.jobs')}
                {state.sessionStatus === 'running' || state.sessionStatus === 'pending' ? (
                  <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                ) : null}
              </button>

              {state.step !== 'setup' && (
                <button
                  onClick={handleReset}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  {t('claimValidation.startOver')}
                </button>
              )}
            </div>
          </div>
        </div>

        {}
        <nav className="flex items-center gap-1 mb-8 overflow-x-auto pb-1" aria-label={t('claimValidation.wizardStepsAria')}>
          {steps.map((s, i) => {
            const active = s.id === state.step;
            const passed = steps.findIndex((x) => x.id === state.step) > i;
            const canGoTo =
              s.id === 'setup' ||
              (s.id === 'review' && state.claims.length > 0) ||
              (s.id === 'results' &&
                (state.sessionId != null || state.results.length > 0));
            const baseClasses = `px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
              active ? 'bg-indigo-600 text-white' : passed ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'
            }`;
            return (
              <div key={s.id} className="flex items-center gap-1 shrink-0">
                {canGoTo ? (
                  <button
                    type="button"
                    onClick={() => setStep(s.id)}
                    className={`${baseClasses} cursor-pointer hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-offset-1 ${!active && passed ? 'hover:bg-green-200' : ''} ${!active && !passed ? 'hover:bg-gray-200' : ''}`}
                    aria-current={active ? 'step' : undefined}
                    aria-label={t('claimValidation.goToStep', { label: s.label })}
                  >
                    {s.label}
                  </button>
                ) : (
                  <span className={baseClasses}>{s.label}</span>
                )}
                {i < steps.length - 1 && (
                  <svg className="w-4 h-4 text-gray-300 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                )}
              </div>
            );
          })}
        </nav>

        {}
        {}
        {}
        {state.step === 'setup' && (
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
            {!selectedProjectId && (
              <div className="mb-5 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800 flex items-start gap-2.5">
                <svg className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
                <span>
                  <strong className="font-semibold">{t('claimValidation.bannerNoProjectSetupStrong')}</strong>{' '}
                  {t('claimValidation.bannerNoProjectSetupRest')}
                </span>
              </div>
            )}
            {extractError && (
              <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                {extractError}
              </div>
            )}
            <UploadSection
              onReady={handleSetupReady}
              disabled={extracting || !selectedProjectId}
            />
            {extracting && (
              <div className="mt-4 flex items-center gap-2 text-indigo-600 text-sm">
                <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                {extractingFromCanvas ? t('claimValidation.extractingFromCanvas') : t('claimValidation.extractingFromPdf')}
              </div>
            )}
          </div>
        )}

        {}
        {}
        {}
        {state.step === 'review' && (
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <h2 className="text-lg font-semibold text-gray-800">{t('claimValidation.reviewSectionTitle')}</h2>
                {state.document && (
                  <p className="text-xs text-gray-400 mt-0.5">{state.document.filename}</p>
                )}
              </div>
              <button
                onClick={() => setStep('setup')}
                className="text-sm text-gray-500 hover:text-indigo-600 flex items-center gap-1"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                {t('claimValidation.back')}
              </button>
            </div>

            {}
            <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1.5 text-sm text-gray-600 shrink-0">
                <svg className="w-4 h-4 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V7M9 3h6M9 3a1 1 0 00-1 1v1h8V4a1 1 0 00-1-1H9z" />
                </svg>
                <span className="font-medium">{t('claimValidation.corpusPrefix')}</span>
              </div>
              {corporaLoading ? (
                <span className="text-xs text-gray-400">{t('claimValidation.loadingShort')}</span>
              ) : corpora.length === 0 ? (
                <span className="text-xs text-red-500">{t('claimValidation.noCorporaShort')}</span>
              ) : (
                <select
                  value={state.selectedCorpusId}
                  onChange={(e) => setState((s) => ({ ...s, selectedCorpusId: e.target.value }))}
                  className="flex-1 min-w-[180px] rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-800 shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                >
                  {!state.selectedCorpusId && (
                    <option value="">{t('claimValidation.selectCorpusOption')}</option>
                  )}
                  {corpora.map((c) => (
                    <option key={c.id} value={c.id}>{c.displayName}</option>
                  ))}
                </select>
              )}
              <p className="text-xs text-gray-400 w-full sm:w-auto">
                {t('claimValidation.corpusChangeHint')}
              </p>
            </div>

            {!selectedProjectId && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800 flex items-start gap-2.5">
                <svg className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
                <span>
                  <strong className="font-semibold">{t('claimValidation.bannerNoProjectReviewStrong')}</strong>{' '}
                  {t('claimValidation.bannerNoProjectReviewRest')}
                </span>
              </div>
            )}

            {validateError && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                {validateError}
              </div>
            )}

            <ClaimsReviewTable
              claims={state.claims}
              onChange={(updated) => setState((s) => ({ ...s, claims: updated }))}
              onRunValidation={handleRunValidation}
              running={validating}
              disabled={!selectedProjectId}
              cachedClaimIds={cachedClaimIds}
            />
          </div>
        )}

        {}
        {}
        {}
        {state.step === 'results' && (
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 space-y-6">
            <div>
              <h2 className="text-lg font-semibold text-gray-800 mb-2">{t('claimValidation.resultsHeading')}</h2>
              <p className="text-gray-600 text-sm leading-relaxed">
                {t('claimValidation.resultsIntro')}{' '}
                {t('claimValidation.resultsMiddle')}{' '}
                <button
                  type="button"
                  onClick={() => setShowJobsPanel(true)}
                  className="font-medium text-indigo-600 hover:text-indigo-800 underline underline-offset-2"
                >
                  {t('claimValidation.jobs')}
                </button>{' '}
                {t('claimValidation.resultsAfterJobs')}
              </p>
            </div>

            {(state.sessionStatus === 'pending' || state.sessionStatus === 'running') && (
              <div
                className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-900"
                role="status"
              >
                {t('claimValidation.validationRunningBanner')}
              </div>
            )}

            {state.sessionError && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                {state.sessionError}
              </div>
            )}

            {state.results.length > 0 && (
              <div>
                <div className="flex items-center gap-1 mb-3">
                  <button
                    type="button"
                    onClick={() => setResultsView('graph')}
                    className={`px-3 py-1.5 rounded text-sm font-medium ${resultsView === 'graph' ? 'bg-indigo-100 text-indigo-700' : 'text-gray-600 hover:bg-gray-100'}`}
                  >
                    {t('claimValidation.viewGraph')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setResultsView('table')}
                    className={`px-3 py-1.5 rounded text-sm font-medium ${resultsView === 'table' ? 'bg-indigo-100 text-indigo-700' : 'text-gray-600 hover:bg-gray-100'}`}
                  >
                    {t('claimValidation.viewTable')}
                  </button>
                </div>
                {resultsView === 'graph' ? (
                  <div style={{ height: 560 }} className="rounded-lg border border-gray-200 bg-slate-50">
                    <ClaimsResultGraph results={state.results} />
                  </div>
                ) : (
                  <ResultsTable
                    results={state.results}
                    summary={computeSummary(state.results)}
                    claims={state.claims}
                    hasFailures={state.results.some((r) => r.run_status === 'failed')}
                  />
                )}
              </div>
            )}

            <button
              type="button"
              onClick={() => setStep('review')}
              className="text-sm text-gray-500 hover:text-indigo-600 flex items-center gap-1"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              {t('claimValidation.backToClaimReview')}
            </button>
          </div>
        )}
      </div>

      {}
      <JobsPanel
        isOpen={showJobsPanel}
        onClose={() => setShowJobsPanel(false)}
        currentSessionId={state.sessionId}
        currentSessionStatus={state.sessionStatus}
        onLoadRun={handleLoadPastRun}
        projectId={selectedProjectId || null}
      />
    </div>
  );
}
