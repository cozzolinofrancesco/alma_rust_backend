import React from 'react';
import { FaSpinner } from 'react-icons/fa';
import type { QcRow, QcStatus, QcPhase } from '../../lib/agentStepQc';
import { NO_CLAIMS, type UseStepQc } from '../hooks/useStepQc';
import type { TranslateFn as Translate } from '../../contexts/LanguageContext';

interface StepQcPanelProps {
  qc: UseStepQc;
  corpusLinked: boolean;
  onVerify: () => void;
  t: Translate;
}

const K = 'agentnodesPage.stepEditor.qc';

const statusLabel = (t: Translate, status: QcStatus): string => {
  switch (status) {
    case 'MATCHING':           return t(`${K}.statusMatching`);
    case 'PARTIALLY_MATCHING': return t(`${K}.statusPartial`);
    case 'NOT_MATCHING':       return t(`${K}.statusContradicted`);
    case 'SOURCE_NOT_FOUND':   return t(`${K}.statusNoEvidence`);
    default:                   return t(`${K}.statusVerifying`);
  }
};

const statusChipClass = (status: QcStatus): string => {
  switch (status) {
    case 'MATCHING':           return 'bg-green-100 text-green-800 border-green-200';
    case 'PARTIALLY_MATCHING': return 'bg-blue-100 text-blue-800 border-blue-200';
    case 'NOT_MATCHING':       return 'bg-red-100 text-red-800 border-red-200';
    case 'SOURCE_NOT_FOUND':   return 'bg-orange-100 text-orange-700 border-orange-200';
    default:                   return 'bg-indigo-50 text-indigo-600 border-indigo-100';
  }
};

const GATES: ReadonlyArray<{ id: string; labelKey: string }> = [
  { id: 'extract',  labelKey: `${K}.gateExtract` },
  { id: 'select',   labelKey: `${K}.gateSelect` },
  { id: 'retrieve', labelKey: `${K}.gateRetrieve` },
  { id: 'validate', labelKey: `${K}.gateValidate` },
  { id: 'done',     labelKey: `${K}.gateDone` },
];

function PhaseIndicator({ phase, t }: { phase: QcPhase; t: Translate }) {
  const currentGate = phase === 'extracting' ? 'extract' : 'retrieve';
  const currentIdx = GATES.findIndex((g) => g.id === currentGate);
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm space-y-3 mt-1">
      <div className="flex items-center gap-2">
        <FaSpinner className="fa-spin text-indigo-500" style={{ fontSize: 14 }} />
        <span className="text-sm font-semibold text-gray-800">
          {phase === 'extracting' ? t(`${K}.extractingTitle`) : t(`${K}.verifyingTitle`)}
        </span>
        <span className="ml-auto text-xs font-medium px-2.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700">
          {t(`${K}.runningBadge`)}
        </span>
      </div>

      <div className="flex items-center gap-0">
        {GATES.map((gate, i) => {
          const isDone = i < currentIdx;
          const isCurrent = gate.id === currentGate;
          return (
            <div key={gate.id} className="flex items-center flex-1 min-w-0">
              <div className={`flex flex-col items-center gap-1 flex-1 min-w-0 ${isDone ? 'text-green-600' : isCurrent ? 'text-indigo-600' : 'text-gray-300'}`}>
                <span className={`relative flex h-7 w-7 items-center justify-center rounded-full border-2 shrink-0 transition-colors ${isDone ? 'border-green-500 bg-green-50' : isCurrent ? 'border-indigo-500 bg-indigo-50 ring-2 ring-indigo-200' : 'border-gray-200 bg-white'}`}>
                  {isDone ? (
                    <svg className="h-3.5 w-3.5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : isCurrent ? (
                    <span className="h-2 w-2 rounded-full bg-indigo-500 animate-pulse" />
                  ) : (
                    <span className="text-[10px] font-medium text-gray-400">{i + 1}</span>
                  )}
                </span>
                <span className="text-[10px] font-medium truncate w-full text-center max-w-[3.5rem]">
                  {t(gate.labelKey)}
                </span>
              </div>
              {i < GATES.length - 1 && (
                <div className={`w-3 h-0.5 shrink-0 rounded ${i < currentIdx ? 'bg-green-400' : 'bg-gray-200'}`} aria-hidden />
              )}
            </div>
          );
        })}
      </div>

      <div className="rounded-lg bg-indigo-50 border border-indigo-100 px-3 py-2 text-xs text-indigo-800 leading-relaxed">
        {phase === 'extracting' ? t(`${K}.descExtracting`) : t(`${K}.descVerifying`)}
      </div>

      <div className="w-full rounded-full bg-gray-100 h-1.5 overflow-hidden">
        <div className="h-1.5 rounded-full bg-indigo-400 animate-pulse" style={{ width: phase === 'extracting' ? '35%' : '70%', transition: 'width 0.8s ease' }} />
      </div>
    </div>
  );
}

function ClaimSelection({ qc, t }: { qc: UseStepQc; t: Translate }) {
  const { extractedClaims, selectedClaims } = qc;
  return (
    <div className="rounded-lg border border-gray-200 overflow-hidden">
      <div className="bg-gray-50 px-3 py-2 border-b border-gray-200 flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm font-semibold text-gray-600 flex items-center gap-1.5">
          <span className="bg-indigo-50 text-indigo-600 rounded-full px-2 py-0.5 text-xs">{extractedClaims.length}</span>
          {t(`${K}.claimsIdentified`)}
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={qc.selectAll} className="text-xs px-2 py-0.5 rounded border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 cursor-pointer">{t(`${K}.selectAll`)}</button>
          <button type="button" onClick={qc.selectNone} className="text-xs px-2 py-0.5 rounded border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 cursor-pointer">{t(`${K}.selectNone`)}</button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <tbody>
            {extractedClaims.map((claim, i) => (
              <tr key={i} className="border-b border-gray-100 align-top">
                <td className="px-2.5 py-1.5 w-8">
                  <input
                    type="checkbox"
                    checked={selectedClaims.includes(i)}
                    onChange={() => qc.toggleClaim(i)}
                    className="cursor-pointer"
                  />
                </td>
                <td className="px-2.5 py-1.5 text-gray-700">{claim}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ResultsTable({ qc, t }: { qc: UseStepQc; t: Translate }) {
  const { rows, phase, expandedRow } = qc;
  const pendingCount = rows.filter((r) => r.status === 'PENDING').length;
  const verifiedCount = rows.length - pendingCount;
  const isVerifying = phase === 'verifying' && pendingCount > 0;
  const countMatching = rows.filter((r) => r.status === 'MATCHING').length;
  const countPartial = rows.filter((r) => r.status === 'PARTIALLY_MATCHING').length;
  const countContradicted = rows.filter((r) => r.status === 'NOT_MATCHING').length;
  const countNoEvidence = rows.filter((r) => r.status === 'SOURCE_NOT_FOUND').length;

  const summary: Array<{ label: string; value: number; color: string }> = [
    { label: t(`${K}.statTotal`),        value: rows.length,        color: 'bg-gray-50 text-gray-700' },
    { label: t(`${K}.statSupported`),    value: countMatching,      color: 'bg-green-50 text-green-700' },
    { label: t(`${K}.statPartial`),      value: countPartial,       color: 'bg-blue-50 text-blue-700' },
    { label: t(`${K}.statContradicted`), value: countContradicted,  color: 'bg-red-50 text-red-700' },
    { label: t(`${K}.statNoEvidence`),   value: countNoEvidence,    color: 'bg-orange-50 text-orange-700' },
    { label: t(`${K}.statPending`),      value: pendingCount,       color: 'bg-indigo-50 text-indigo-600' },
  ];

  return (
    <div className="space-y-3 mt-4">
      <div className="flex items-center gap-2 flex-wrap">
        {isVerifying && <FaSpinner className="fa-spin text-indigo-500" style={{ fontSize: 12 }} />}
        <span className={`text-sm font-semibold ${isVerifying ? 'text-indigo-500' : countMatching === verifiedCount ? 'text-green-700' : 'text-orange-600'}`}>
          {isVerifying
            ? t(`${K}.summaryVerifying`, { done: verifiedCount, total: rows.length })
            : t(`${K}.summarySupported`, { matching: countMatching, total: rows.length })}
        </span>
        {phase === 'done' && (
          <button
            type="button"
            onClick={qc.backToSelecting}
            className="ml-auto text-xs px-2 py-0.5 rounded border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 cursor-pointer"
          >
            {t(`${K}.reselect`)}
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
        {summary.map(({ label, value, color }) => (
          <div key={label} className={`rounded-xl p-2 text-center ${color} border border-gray-100`}>
            <div className="text-xl font-bold">{value}</div>
            <div className="text-xs mt-0.5 font-medium">{label}</div>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-3 py-2 w-8" />
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-8">{t(`${K}.colNum`)}</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide min-w-[10rem]">{t(`${K}.colClaim`)}</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide w-36">{t(`${K}.colStatus`)}</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide min-w-[6rem]">{t(`${K}.colReference`)}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((row: QcRow, i) => {
              const isPending = row.status === 'PENDING';
              const isExpanded = expandedRow === i;
              return (
                <React.Fragment key={i}>
                  <tr
                    className={`cursor-pointer hover:bg-gray-50 transition-colors ${isPending ? 'opacity-60' : ''}`}
                    onClick={() => !isPending && qc.toggleExpandedRow(i)}
                  >
                    <td className="px-3 py-2 text-gray-400">
                      {isPending ? (
                        <FaSpinner className="fa-spin w-3 h-3 text-indigo-400" />
                      ) : (
                        <svg className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs font-medium text-gray-400 tabular-nums">{i + 1}</td>
                    <td className="px-3 py-2 text-gray-800 max-w-xs">
                      <span className="line-clamp-2">{row.claim}</span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-medium ${isPending ? 'bg-indigo-50 text-indigo-600 border-indigo-100' : statusChipClass(row.status)}`}>
                        {isPending && <FaSpinner className="fa-spin" style={{ fontSize: 9 }} />}
                        {statusLabel(t, row.status)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500">
                      {isPending ? '—' : (row.ragLocation || row.sourceDoc || '—')}
                    </td>
                  </tr>

                  {isExpanded && !isPending && (
                    <tr>
                      <td colSpan={5} className="px-4 py-3 bg-gray-50 border-b border-gray-200">
                        <div className="space-y-3 max-w-3xl">
                          {row.rationale && (
                            <div>
                              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">{t(`${K}.explanation`)}</p>
                              <p className="text-sm text-gray-700 leading-relaxed">{row.rationale}</p>
                            </div>
                          )}
                          {(row.sourceDoc || row.ragLocation) && (
                            <div className="rounded-lg border border-gray-200 bg-white px-3 py-2">
                              {row.sourceDoc && <p className="text-xs text-indigo-600 font-medium">{row.sourceDoc}</p>}
                              {row.ragLocation && <p className="text-xs text-gray-500 mt-0.5">{t(`${K}.location`)} {row.ragLocation}</p>}
                            </div>
                          )}
                          {row.action && row.action !== 'NO_ACTION_NEEDED' && (
                            <div>
                              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">{t(`${K}.recommendedAction`)}</p>
                              <span className="text-xs bg-yellow-50 text-yellow-800 border border-yellow-200 rounded px-2 py-0.5">{row.action.replace(/_/g, ' ')}</span>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function StepQcPanel({
  qc,
  corpusLinked,
  onVerify,
  t,
}: StepQcPanelProps) {
  const { phase, error, extractedClaims, selectedClaims, rows } = qc;

  // Nothing to show until QC has been started from the answer's QC icon, unless a
  // corpus is missing (then we surface the hint).
  if (corpusLinked && phase === 'idle' && !error && rows.length === 0) return null;

  return (
    <div className="an-step-popup__qc" style={{ marginTop: 16 }}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-semibold text-gray-700">{t(`${K}.title`)}</span>
      </div>

      {!corpusLinked && (
        <div className="text-xs italic text-gray-400">{t(`${K}.needCorpus`)}</div>
      )}

      {corpusLinked && (phase === 'extracting' || phase === 'verifying') && (
        <PhaseIndicator phase={phase} t={t} />
      )}

      {error === NO_CLAIMS && phase === 'done' && (
        <div className="text-xs italic text-gray-500 flex items-center gap-2">
          {t(`${K}.noClaims`)}
        </div>
      )}

      {error && error !== NO_CLAIMS && phase !== 'verifying' && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-2 py-1.5 flex items-center justify-between gap-2">
          <span>{t(`${K}.errorPrefix`)} {error}</span>
        </div>
      )}

      {phase === 'selecting' && extractedClaims.length > 0 && (
        <div className="space-y-2">
          <ClaimSelection qc={qc} t={t} />
          <div className="flex justify-end">
            <button
              type="button"
              disabled={selectedClaims.length === 0}
              onClick={onVerify}
              className={`text-xs px-3 py-1.5 rounded-md border-none font-semibold text-white flex items-center gap-1.5 ${selectedClaims.length === 0 ? 'bg-gray-300 cursor-not-allowed' : 'bg-indigo-500 cursor-pointer hover:bg-indigo-600'}`}
            >
              {t(`${K}.verifySelected`, { count: selectedClaims.length })}
            </button>
          </div>
        </div>
      )}

      {(phase === 'verifying' || phase === 'done') && rows.length > 0 && (
        <ResultsTable qc={qc} t={t} />
      )}
    </div>
  );
}
