'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLanguage } from '@/app/contexts/LanguageContext';
import type { SessionStatus } from '../types';

interface JobEntry {
  session_id: string;
  document_filename?: string;
  corpus_id: string;
  status: string;
  total: number;
  completed_count: number;
  failed_count: number;
  saved_at?: string;
  created_at?: string;
  is_live?: boolean;
}

interface JobsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  currentSessionId: string | null;
  currentSessionStatus: SessionStatus | null;
  onLoadRun: (sessionId: string) => void;
  projectId?: string | null;
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export default function JobsPanel({
  isOpen,
  onClose,
  currentSessionId,
  currentSessionStatus,
  onLoadRun,
  projectId,
}: JobsPanelProps) {
  const { t } = useLanguage();
  const statusBadge = (status: string, isLive?: boolean) => {
    const base = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold';
    if (isLive && (status === 'pending' || status === 'running')) {
      return (
        <span className={`${base} bg-blue-100 text-blue-700`}>
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse inline-block" />
          {t('claimValidation.statusRunning')}
        </span>
      );
    }
    switch (status) {
      case 'completed':
        return <span className={`${base} bg-green-100 text-green-700`}>{t('claimValidation.statusCompleted')}</span>;
      case 'partial':
        return <span className={`${base} bg-orange-100 text-orange-700`}>{t('claimValidation.statusPartial')}</span>;
      case 'failed':
        return <span className={`${base} bg-red-100 text-red-700`}>{t('claimValidation.statusFailed')}</span>;
      case 'pending':
        return <span className={`${base} bg-gray-100 text-gray-500`}>{t('claimValidation.statusPending')}</span>;
      default:
        return <span className={`${base} bg-gray-100 text-gray-500`}>{status}</span>;
    }
  };

  const [jobs, setJobs]       = useState<JobEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const fetchJobs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = projectId
        ? `/api/claim-validation/jobs?projectId=${encodeURIComponent(projectId)}`
        : '/api/claim-validation/jobs';
      const res  = await fetch(url);
      const data = await res.json() as { jobs?: JobEntry[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? t('claimValidation.jobsLoadFailed'));
      setJobs(data.jobs ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('claimValidation.jobsLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => {
    if (isOpen) void fetchJobs();
  }, [isOpen, fetchJobs]);

  const allJobs: JobEntry[] = jobs.some((j) => j.session_id === currentSessionId)
    ? jobs
    : currentSessionId
      ? [
          {
            session_id:       currentSessionId,
            status:           currentSessionStatus ?? 'running',
            total:            0,
            completed_count:  0,
            failed_count:     0,
            corpus_id:        '',
            is_live:          true,
          },
          ...jobs,
        ]
      : jobs;

  if (!isOpen) return null;

  return (
    <>
      {}
      <div
        className="fixed inset-0 bg-black/30 z-40"
        onClick={onClose}
        aria-hidden
      />

      {}
      <aside className="fixed right-0 top-0 h-full w-full max-w-md bg-white shadow-2xl z-50 flex flex-col">
        {}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <div>
            <h2 className="text-base font-semibold text-gray-900">{t('claimValidation.jobsTitle')}</h2>
            <p className="text-xs text-gray-400 mt-0.5">{t('claimValidation.jobsSubtitle')}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void fetchJobs()}
              disabled={loading}
              title={t('claimValidation.refreshList')}
              className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors disabled:opacity-50"
            >
              <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors"
              aria-label={t('claimValidation.closeJobsPanel')}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {}
        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="mx-4 mt-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {!loading && !error && allJobs.length === 0 && (
            <div className="flex flex-col items-center justify-center h-48 text-gray-400">
              <svg className="w-10 h-10 mb-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              <p className="text-sm">{t('claimValidation.jobsEmpty')}</p>
              <p className="text-xs mt-1">{t('claimValidation.jobsEmptyHint')}</p>
            </div>
          )}

          {loading && allJobs.length === 0 && (
            <div className="flex items-center justify-center h-32 text-gray-400 text-sm gap-2">
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              {t('claimValidation.jobsLoading')}
            </div>
          )}

          <ul className="divide-y divide-gray-100">
            {allJobs.map((job) => {
              const isCurrentLive = job.session_id === currentSessionId && job.is_live;
              const canLoad = !job.is_live && (job.status === 'completed' || job.status === 'partial' || job.status === 'failed');
              const timestamp = job.saved_at ?? job.created_at;

              return (
                <li
                  key={job.session_id}
                  className={`px-5 py-4 hover:bg-gray-50 transition-colors ${isCurrentLive ? 'bg-blue-50/50' : ''}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      {}
                      <p className="text-sm font-medium text-gray-800 truncate">
                        {job.document_filename ?? t('claimValidation.unknownDocument')}
                      </p>
                      {}
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        {statusBadge(job.status, job.is_live)}
                        {timestamp && (
                          <span className="text-xs text-gray-400">{formatDate(timestamp)}</span>
                        )}
                      </div>
                      {}
                      {job.total > 0 && (
                        <p className="text-xs text-gray-400 mt-1">
                          {t('claimValidation.claimsMeta', { completed: job.completed_count, total: job.total })}
                          {job.failed_count > 0 && (
                            <span className="text-red-400">{t('claimValidation.failedMeta', { n: job.failed_count })}</span>
                          )}
                        </p>
                      )}
                    </div>

                    {}
                    <div className="shrink-0">
                      {canLoad && (
                        <button
                          onClick={() => { onLoadRun(job.session_id); onClose(); }}
                          className="px-3 py-1.5 rounded-lg bg-indigo-50 text-indigo-700 text-xs font-semibold hover:bg-indigo-100 transition-colors"
                        >
                          {t('claimValidation.load')}
                        </button>
                      )}
                      {isCurrentLive && (
                        <span className="px-3 py-1.5 rounded-lg bg-blue-50 text-blue-500 text-xs font-semibold">
                          {t('claimValidation.active')}
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        {}
        <div className="px-5 py-3 border-t border-gray-100 bg-gray-50">
          <p className="text-xs text-gray-400 text-center">
            {projectId
              ? t('claimValidation.jobsFooterWithProject')
              : t('claimValidation.jobsFooterNoProject')}
          </p>
        </div>
      </aside>
    </>
  );
}
