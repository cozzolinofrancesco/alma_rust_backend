'use client';

import { Activity } from 'lucide-react';
import { Fragment } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { parseStepRunDiagnostics, type StepRunDiagnostics } from '../lib/stepExecution';

export default function StepRunStatus({ diagnostics: savedDiagnostics }: { diagnostics?: StepRunDiagnostics }) {
  const { t, locale } = useLanguage();
  const diagnostics = parseStepRunDiagnostics(savedDiagnostics);
  if (!diagnostics) return null;
  const state = diagnostics.status === 'cancelled' ? 'cancelled'
    : diagnostics.inferenceAttempted === false ? 'notSent'
      : diagnostics.source === 'client' ? 'unconfirmed'
        : diagnostics.status === 'failed' ? 'failed'
          : diagnostics.upstreamResponded ? 'responseReceived' : 'unconfirmed';
  const unknown = t('stepRun.unknown');
  const fields = [
    ['selectedModel', diagnostics.selectedModel],
    ['sentModel', diagnostics.sentModel ?? unknown],
    ['reportedModel', diagnostics.reportedModel ?? unknown],
    ['provider', diagnostics.provider ?? unknown],
    ['region', diagnostics.region.toUpperCase()],
    ['stage', t(`stepRun.stages.${diagnostics.stage}`)],
    ['source', t(`stepRun.${diagnostics.source}`)],
    ['duration', `${diagnostics.durationMs} ms`],
    ['runId', diagnostics.runId ?? unknown],
    ['upstreamRequestId', diagnostics.upstreamRequestId ?? unknown],
    ...(diagnostics.upstreamStatus ? [['upstreamStatus', String(diagnostics.upstreamStatus)]] : []),
    ...(diagnostics.errorCode ? [['errorCode', diagnostics.errorCode]] : []),
    ...(diagnostics.endpoint ? [['endpoint', diagnostics.endpoint]] : []),
    ...(diagnostics.protocol ? [['protocol', diagnostics.protocol]] : []),
    ...(diagnostics.routingProvider ? [['routingProvider', diagnostics.routingProvider]] : []),
    ...(diagnostics.inputTokens !== undefined ? [['inputTokens', String(diagnostics.inputTokens)]] : []),
    ...(diagnostics.outputTokens !== undefined ? [['outputTokens', String(diagnostics.outputTokens)]] : []),
    ...(diagnostics.uploadedFileCount !== undefined ? [['uploadedFiles', String(diagnostics.uploadedFileCount)]] : []),
    ...(diagnostics.fileCleanupFailed ? [['cleanup', t('stepRun.cleanupFailed')]] : []),
    ...(diagnostics.retrieval ? [
      ['retrievalModel', diagnostics.retrieval.model ?? t('stepRun.storedChunks')],
      ['retrievalDuration', `${diagnostics.retrieval.durationMs} ms`],
      ['sourceCount', String(diagnostics.retrieval.sourceCount)],
    ] : []),
  ];
  return (
    <details className="min-w-0 py-2 text-xs text-gray-700" data-run-state={state} data-run-id={diagnostics.runId}>
      <summary className="cursor-pointer break-words font-medium">
        <Activity size={14} className="mr-1 inline-block align-text-bottom" />
        {t('stepRun.title')}: {t(`stepRun.${state}`)}
        <time dateTime={diagnostics.startedAt} className="ml-2 inline-block font-normal text-gray-500">
          {new Date(diagnostics.startedAt).toLocaleString(locale)}
        </time>
      </summary>
      <dl className="mt-2 grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        {fields.map(([key, value]) => <Fragment key={key}>
          <dt className="text-gray-500">{t(`stepRun.${key}`)}</dt>
          <dd className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{value}</dd>
        </Fragment>)}
      </dl>
    </details>
  );
}