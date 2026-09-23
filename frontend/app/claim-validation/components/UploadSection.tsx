'use client';

import { useCallback, useMemo, useState } from 'react';
import { useLanguage } from '@/app/contexts/LanguageContext';
import type { QcType, Document, SplitConfig } from '../types';
import QcTypeSelector from './QcTypeSelector';
import Dropzone from '@/app/components/Dropzone';
import DriveFilePicker from './DriveFilePicker';
import DatabaseSourcePicker from '@/app/components/sources/DatabaseSourcePicker';
import { useCorpora } from '@/app/lib/hooks/useCorpora';

type SourceTab = 'upload' | 'drive' | 'database';

const DEFAULT_SPLIT_CONFIG: SplitConfig = {
  enabled: false,
  pagesPerChunk: 50,
  overlapPages: 2,
};

interface Props {
  onReady: (params: {
    document: Document;
    selectedCorpusId: string;
    extractionPrompt: string;
    validationPrompt: string;
    splitConfig?: SplitConfig;
  }) => void;
  disabled?: boolean;
}

const PDF_ACCEPT = { 'application/pdf': ['.pdf'] };

export default function UploadSection({ onReady, disabled }: Props) {
  const { t } = useLanguage();
  const { corpora, loading: corporaLoading, error: corpusError, refetch: refetchCorpora } = useCorpora();
  const [sourceTab,        setSourceTab]      = useState<SourceTab>('upload');
  const [uploadedDoc,      setUploadedDoc]    = useState<Document | null>(null);
  const [uploading,        setUploading]      = useState(false);
  const [uploadError,      setUploadError]    = useState<string | null>(null);
  const [selectedCorpusId, setSelectedCorpus] = useState<string>('');
  const [selectedQcType,   setSelectedQcType] = useState<QcType | null>(null);
  const [extractionPrompt, setExtractionPrompt] = useState('');
  const [validationPrompt, setValidationPrompt] = useState('');
  const [extracting,       setExtracting]     = useState(false);
  const [extractError,     setExtractError]   = useState<string | null>(null);
  const [splitConfig,      setSplitConfig]    = useState<SplitConfig>(DEFAULT_SPLIT_CONFIG);
  const [advancedOpen,     setAdvancedOpen]   = useState(false);

  const handleFile = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      setUploadError(t('claimValidation.onlyPdf'));
      return;
    }
    setUploadError(null);
    setUploading(true);
    setUploadedDoc(null);

    const formData = new FormData();
    formData.append('pdf', file);

    try {
      const res  = await fetch('/api/claim-validation/upload', { method: 'POST', body: formData });
      const data = await res.json() as { fileUri?: string; filename?: string; mimeType?: string; document_id?: string; error?: string };

      if (!res.ok || !data.fileUri) {
        throw new Error(data.error ?? 'Upload failed');
      }

      const doc: Document = {
        document_id:       data.document_id!,
        filename:          data.filename!,
        gemini_file_uri:   data.fileUri!,
        mime_type:         data.mimeType ?? 'application/pdf',
        upload_timestamp:  new Date().toISOString(),
        status:            'ready',
      };
      setUploadedDoc(doc);
      await refetchCorpora();
    } catch (e: unknown) {
      setUploadError(e instanceof Error ? e.message : t('claimValidation.uploadFailed'));
    } finally {
      setUploading(false);
    }
  }, [refetchCorpora, t]);

  const handleDropFiles = useCallback((acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (file && (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) {
      handleFile(file);
    }
  }, [handleFile]);

  const handleDriveSelect = useCallback((doc: Document) => {
    setUploadedDoc(doc);
    setUploadError(null);
    refetchCorpora();
  }, [refetchCorpora]);

  const handleQcChange = (qcType: QcType) => {
    setSelectedQcType(qcType);
    setExtractionPrompt(qcType.extraction_prompt_template);
    setValidationPrompt(qcType.validation_prompt_template);
  };

  const canExtract = uploadedDoc && selectedCorpusId && extractionPrompt.trim() && validationPrompt.trim() && !extracting;

  const splitConfigError: string | null = useMemo(() => {
    if (!splitConfig.enabled) return null;
    if (splitConfig.pagesPerChunk < 1) return t('claimValidation.splitErrPagesMin');
    if (splitConfig.overlapPages < 0) return t('claimValidation.splitErrOverlapNeg');
    if (splitConfig.overlapPages >= splitConfig.pagesPerChunk) return t('claimValidation.splitErrOverlapTooBig');
    return null;
  }, [splitConfig.enabled, splitConfig.pagesPerChunk, splitConfig.overlapPages, t]);

  const handleExtract = async () => {
    if (!uploadedDoc || !canExtract || splitConfigError) return;
    setExtractError(null);
    setExtracting(true);
    try {
      onReady({
        document:         uploadedDoc,
        selectedCorpusId,
        extractionPrompt: extractionPrompt.trim(),
        validationPrompt: validationPrompt.trim(),
        splitConfig:      splitConfig.enabled ? splitConfig : undefined,
      });
    } catch (e: unknown) {
      setExtractError(e instanceof Error ? e.message : t('claimValidation.errExtractStart'));
    } finally {
      setExtracting(false);
    }
  };

  return (
    <div className="space-y-6">

      {}
      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-2">{t('claimValidation.selectDocument')}</label>

        {}
        {!uploadedDoc && (
          <div className="flex rounded-lg border border-gray-200 overflow-hidden mb-3 w-fit">
            <button
              type="button"
              onClick={() => setSourceTab('upload')}
              disabled={disabled}
              className={`px-4 py-1.5 text-sm font-medium flex items-center gap-1.5 transition-colors ${sourceTab === 'upload' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              {t('claimValidation.tabUploadPdf')}
            </button>
            <button
              type="button"
              onClick={() => setSourceTab('drive')}
              disabled={disabled}
              className={`px-4 py-1.5 text-sm font-medium flex items-center gap-1.5 transition-colors border-l border-gray-200 ${sourceTab === 'drive' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              {}
              <svg className="w-3.5 h-3.5" viewBox="0 0 87.3 78" fill="currentColor">
                <path d="M6.6 66.85l3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3L27.5 53H0c0 1.55.4 3.1 1.2 4.5z" opacity=".6"/>
                <path d="M43.65 25L29.9 1.2C28.55.4 27 0 25.45 0c-1.55 0-3.1.4-4.5 1.2L6.6 25h37.05z" opacity=".8"/>
                <path d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5H60.1l5.55 10.9z" opacity=".6"/>
                <path d="M43.65 25L57.4 1.2C56 .4 54.45 0 52.9 0H34.4c-1.55 0-3.1.4-4.5 1.2z" opacity=".8"/>
                <path d="M60.1 53H27.5L13.75 76.8c1.4.8 2.95 1.2 4.5 1.2h50.8c1.55 0 3.1-.4 4.5-1.2z" opacity=".8"/>
                <path d="M43.65 25H6.6L.8 35.2a9.38 9.38 0 000 9l6.8 11.8h52.5z" opacity=".8"/>
              </svg>
              {t('claimValidation.tabGoogleDrive')}
            </button>
            <button
              type="button"
              onClick={() => setSourceTab('database')}
              disabled={disabled}
              className={`px-4 py-1.5 text-sm font-medium flex items-center gap-1.5 transition-colors border-l border-gray-200 ${sourceTab === 'database' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <ellipse cx="12" cy="5" rx="8" ry="3" strokeWidth={2} />
                <path strokeLinecap="round" strokeWidth={2} d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
              </svg>
              {t('claimValidation.tabDatabase')}
            </button>
          </div>
        )}

        {}
        {sourceTab === 'upload' && (
          <>
            {(uploadedDoc || uploading) ? (
              <div className={`relative flex flex-col items-center justify-center border-2 border-dashed rounded-xl p-8 transition-colors border-gray-300 bg-gray-50 ${uploading || disabled ? 'opacity-60 pointer-events-none' : ''}`}>
                {uploadedDoc ? (
                  <div className="flex items-center gap-3 text-green-700">
                    <svg className="w-8 h-8 text-green-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <div>
                      <p className="font-medium">{uploadedDoc.filename}</p>
                      <p className="text-xs text-gray-500">{t('claimValidation.readyReplace')}</p>
                    </div>
                    {!disabled && (
                      <button type="button" onClick={() => setUploadedDoc(null)} className="ml-2 text-sm text-indigo-600 hover:text-indigo-800">
                        {t('claimValidation.replace')}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2 text-indigo-600">
                    <svg className="animate-spin h-8 w-8" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                    </svg>
                    <span className="text-sm">{t('claimValidation.uploadingToGemini')}</span>
                  </div>
                )}
              </div>
            ) : (
              <div className={disabled ? 'opacity-60 pointer-events-none' : ''}>
                <Dropzone
                  accept={PDF_ACCEPT}
                  maxFiles={1}
                  hint={t('claimValidation.dropzoneHint')}
                  onDrop={handleDropFiles}
                />
              </div>
            )}
            {uploadError && <p className="mt-2 text-sm text-red-600">{uploadError}</p>}
          </>
        )}

        {}
        {sourceTab === 'drive' && !uploadedDoc && (
          <DriveFilePicker onSelect={handleDriveSelect} disabled={disabled} />
        )}

        {}
        {sourceTab === 'database' && !uploadedDoc && (
          <div className="space-y-2">
            <DatabaseSourcePicker disabled={disabled} />
            <p className="text-xs text-gray-400">
              Connect a database and preview a table. Reconciling claims against database
              values is the next wiring step — for now this manages and previews the source.
            </p>
          </div>
        )}

        {}
        {sourceTab === 'drive' && uploadedDoc && (
          <div className="flex items-center gap-3 border-2 border-dashed border-gray-300 rounded-xl p-5 bg-gray-50">
            <svg className="w-8 h-8 text-green-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-green-700 truncate">{uploadedDoc.filename}</p>
              <p className="text-xs text-gray-500">{t('claimValidation.fromDriveReady')}</p>
            </div>
            {!disabled && (
              <button type="button" onClick={() => setUploadedDoc(null)} className="text-sm text-indigo-600 hover:text-indigo-800 shrink-0">
                {t('claimValidation.change')}
              </button>
            )}
          </div>
        )}
      </div>

      {}
      {uploadedDoc && (
        <div className="rounded-lg border border-gray-200 bg-gray-50">
          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            className="w-full flex items-center justify-between px-4 py-2.5 text-sm font-medium text-gray-600 hover:text-indigo-700 transition-colors"
            aria-expanded={advancedOpen}
          >
            <span className="flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
              </svg>
              {t('claimValidation.advanced')}
            </span>
            <svg
              className={`w-4 h-4 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {advancedOpen && (
            <div className="px-4 pb-4 space-y-4 border-t border-gray-200 pt-3">
              {}
              <div>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={splitConfig.enabled}
                    onChange={(e) => setSplitConfig((s) => ({ ...s, enabled: e.target.checked }))}
                    disabled={disabled}
                    className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="text-sm font-medium text-gray-700">{t('claimValidation.enableSplitting')}</span>
                </label>
                <p className="mt-1 text-xs text-gray-500 ml-6">
                  {t('claimValidation.splitHelp')}
                </p>
              </div>

              {splitConfig.enabled && (
                <div className="ml-6 space-y-3">
                  <div className="flex items-start gap-4 flex-wrap">
                    <div className="flex-1 min-w-[140px]">
                      <label className="block text-xs font-semibold text-gray-600 mb-1">
                        {t('claimValidation.pagesPerChunk')}
                      </label>
                      <input
                        type="number"
                        min={1}
                        value={splitConfig.pagesPerChunk}
                        onChange={(e) => setSplitConfig((s) => {
                          const newPpc = Math.max(1, parseInt(e.target.value, 10) || 1);
                          const suggested = Math.min(Math.max(0, Math.round(newPpc * 0.1)), newPpc - 1);
                          return {
                            ...s,
                            pagesPerChunk: newPpc,
                            overlapPages: suggested,
                          };
                        })}
                        disabled={disabled}
                        className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                      />
                      <p className="mt-0.5 text-xs text-gray-400">{t('claimValidation.min1Default50')}</p>
                    </div>
                    <div className="flex-1 min-w-[140px]">
                      <label className="block text-xs font-semibold text-gray-600 mb-1">
                        {t('claimValidation.overlapPages')}
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={splitConfig.pagesPerChunk - 1}
                        value={splitConfig.overlapPages}
                        onChange={(e) => setSplitConfig((s) => ({ ...s, overlapPages: Math.min(Math.max(0, parseInt(e.target.value, 10) || 0), s.pagesPerChunk - 1) }))}
                        disabled={disabled}
                        className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                      />
                      <p className="mt-0.5 text-xs text-gray-400">{t('claimValidation.repeatedAtBoundaries')}</p>
                    </div>
                  </div>
                  {splitConfig.enabled && !splitConfigError && (() => {
                    const { pagesPerChunk, overlapPages } = splitConfig;
                    const overheadPct = Math.round((overlapPages / pagesPerChunk) * 100);
                    const extraSecsPerChunk = overlapPages * 4;
                    const overlapRatio = overlapPages / pagesPerChunk;
                    const diminishingReturns = overlapRatio > 0.25;

                    const recommendation: string = (() => {
                      if (overlapPages === 0) return t('claimValidation.splitReco0');
                      if (overlapPages === 1) return t('claimValidation.splitReco1');
                      if (pagesPerChunk <= 5) return t('claimValidation.splitRecoShortChunks');
                      if (overlapRatio <= 0.1) return t('claimValidation.splitRecoLow');
                      if (overlapRatio <= 0.2) return t('claimValidation.splitRecoMid');
                      if (overlapRatio <= 0.3) return t('claimValidation.splitRecoHigh');
                      return t('claimValidation.splitRecoVeryHigh');
                    })();

                    return (
                      <div className={`rounded-md border px-3 py-2.5 text-xs space-y-2 ${overlapPages === 0 ? 'border-gray-200 bg-gray-50 text-gray-600' : diminishingReturns ? 'border-orange-200 bg-orange-50 text-orange-900' : 'border-blue-100 bg-blue-50 text-blue-900'}`}>
                        <p className="font-semibold">{t('claimValidation.overlapImpact')}</p>

                        <div className="grid grid-cols-3 gap-2 text-center">
                          <div className="rounded bg-white/60 py-1.5 px-1">
                            <p className="text-base font-bold">{overlapPages === 0 ? '0' : `+${overlapPages}`}</p>
                            <p className="text-[10px] leading-tight mt-0.5 opacity-75">{t('claimValidation.extraPagesBoundary')}</p>
                          </div>
                          <div className="rounded bg-white/60 py-1.5 px-1">
                            <p className="text-base font-bold">{overlapPages === 0 ? '—' : `~${overheadPct}%`}</p>
                            <p className="text-[10px] leading-tight mt-0.5 opacity-75">{t('claimValidation.moreTokensChunk')}</p>
                          </div>
                          <div className="rounded bg-white/60 py-1.5 px-1">
                            <p className="text-base font-bold">{overlapPages === 0 ? '—' : `+${extraSecsPerChunk}s`}</p>
                            <p className="text-[10px] leading-tight mt-0.5 opacity-75">{t('claimValidation.estExtraTimeChunk')}</p>
                          </div>
                        </div>

                        <p className="leading-relaxed">{recommendation}</p>

                        {overlapPages > 0 && (
                          <div className="rounded border border-yellow-200 bg-yellow-50 px-2.5 py-2 text-yellow-800 space-y-1">
                            <p className="font-semibold flex items-center gap-1">
                              <svg className="w-3.5 h-3.5 shrink-0" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true"><path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" /></svg>
                              {t('claimValidation.accuracyTradeoffTitle')}
                            </p>
                            <p>{t('claimValidation.accuracyTradeoffP1')}</p>
                            <p>{t('claimValidation.accuracyTradeoffP2')}</p>
                          </div>
                        )}

                        {diminishingReturns && (
                          <p className="font-medium">
                            {t('claimValidation.splitRecoTip', { pages: Math.round(overlapPages / 0.15) })}
                          </p>
                        )}
                      </div>
                    );
                  })()}
                  {splitConfigError && (
                    <p className="text-xs text-red-600">{splitConfigError}</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {}
      {uploadedDoc && (
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">{t('claimValidation.selectRagCorpus')}</label>
          {corpusError ? (
            <p className="text-sm text-red-600">{corpusError}</p>
          ) : corporaLoading ? (
            <p className="text-sm text-gray-500">{t('claimValidation.loadingCorpora')}</p>
          ) : corpora.length === 0 ? (
            <p className="text-sm text-gray-500">{t('claimValidation.noCorporaCreateRag')}</p>
          ) : (
            <select
              value={selectedCorpusId}
              onChange={(e) => setSelectedCorpus(e.target.value)}
              disabled={disabled}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
            >
              <option value="">{t('claimValidation.chooseCorpus')}</option>
              {corpora.map((c) => (
                <option key={c.id} value={c.id}>{c.displayName}</option>
              ))}
            </select>
          )}
        </div>
      )}

      {}
      {uploadedDoc && selectedCorpusId && (
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">{t('claimValidation.selectQcType')}</label>
          <QcTypeSelector
            selectedId={selectedQcType?.qc_type_id ?? null}
            onChange={handleQcChange}
            disabled={disabled}
          />
        </div>
      )}

      {}
      {uploadedDoc && selectedCorpusId && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">
              {t('claimValidation.extractionPrompt')}
            </label>
            <textarea
              rows={6}
              value={extractionPrompt}
              onChange={(e) => setExtractionPrompt(e.target.value)}
              disabled={disabled}
              placeholder={t('claimValidation.extractionPlaceholder')}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-y"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">
              {t('claimValidation.validationPrompt')}
              <span className="ml-1 text-xs font-normal text-gray-400">
                {t('claimValidation.validationPromptHint')}
              </span>
            </label>
            <textarea
              rows={6}
              value={validationPrompt}
              onChange={(e) => setValidationPrompt(e.target.value)}
              disabled={disabled}
              placeholder={t('claimValidation.validationPlaceholder')}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-y"
            />
          </div>
        </div>
      )}

      {extractError && <p className="text-sm text-red-600">{extractError}</p>}

      {uploadedDoc && selectedCorpusId && (
        <button
          onClick={handleExtract}
          disabled={!canExtract || disabled || !!splitConfigError}
          className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {extracting ? (
            <>
              <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              {t('claimValidation.extractingClaims')}
            </>
          ) : (
            t('claimValidation.extractClaims')
          )}
        </button>
      )}
    </div>
  );
}
