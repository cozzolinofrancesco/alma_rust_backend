'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bug, ChevronDown, ChevronRight, FileText, Lightbulb, Quote, X as XIcon } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useLanguage } from '../contexts/LanguageContext';
import type { AnswerDebugInfo, DebugSourceChunk } from '../lib/answerDebug';

interface AnswerDebugPanelProps {
  open: boolean;
  debugInfo?: AnswerDebugInfo;
  onClose: () => void;
}

function sourceLabel(source: DebugSourceChunk, untitled: string): string {
  return source.fileName ?? source.title ?? source.uri ?? untitled;
}

function Section({
  icon,
  title,
  count,
  defaultOpen = true,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [openSection, setOpenSection] = useState(defaultOpen);
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpenSection((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-50 hover:bg-gray-100 text-left"
      >
        {openSection ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <span className="text-gray-600">{icon}</span>
        <span className="font-medium text-sm text-gray-800">{title}</span>
        {typeof count === 'number' ? (
          <span className="ml-auto text-xs text-gray-500 bg-gray-200 rounded-full px-2 py-0.5">{count}</span>
        ) : null}
      </button>
      {openSection ? <div className="px-3 py-3 text-sm text-gray-700">{children}</div> : null}
    </div>
  );
}

const markdownComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  p: ({ children, ...props }) => (
    <p className="mb-2 last:mb-0 leading-relaxed text-gray-700" {...props}>
      {children}
    </p>
  ),
  ul: ({ children, ...props }) => (
    <ul className="list-disc pl-5 mb-2 last:mb-0 space-y-1 text-gray-700" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol className="list-decimal pl-5 mb-2 last:mb-0 space-y-1 text-gray-700" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => (
    <li className="leading-relaxed" {...props}>
      {children}
    </li>
  ),
  h1: ({ children, ...props }) => (
    <h1 className="text-lg font-bold mt-3 mb-1 text-gray-900" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className="text-base font-bold mt-3 mb-1 text-gray-900" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="text-sm font-bold mt-2 mb-1 text-gray-900" {...props}>
      {children}
    </h3>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote className="border-l-4 border-gray-200 pl-3 italic text-gray-600 my-2" {...props}>
      {children}
    </blockquote>
  ),
  code: ({ children, className, ...props }) => {
    const isInline = !className || !className.includes('language-');
    if (isInline) {
      return (
        <code
          className="bg-gray-100 text-gray-800 px-1 py-0.5 rounded text-xs font-mono"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <pre className="bg-gray-50 border border-gray-200 rounded p-2 overflow-x-auto text-xs font-mono my-2">
        <code {...props}>{children}</code>
      </pre>
    );
  },
  a: ({ children, ...props }) => (
    <a
      className="text-indigo-600 hover:underline font-medium"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
};

export default function AnswerDebugPanel({ open, debugInfo, onClose }: AnswerDebugPanelProps) {
  const { t } = useLanguage();

  const handleClose = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, handleClose]);

  if (!open || typeof document === 'undefined') return null;

  const sources = debugInfo?.sources ?? [];
  const supports = (debugInfo?.supports ?? []).filter((s) => s.text.trim().length > 0);
  const reasoning = debugInfo?.reasoning?.trim() ?? '';
  const untitled = t('answerDebug.untitledSource');

  return createPortal(
    <div
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('answerDebug.title')}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200">
          <Bug size={18} className="text-indigo-500" />
          <div className="flex flex-col">
            <span className="font-semibold text-gray-900">{t('answerDebug.title')}</span>
            {debugInfo?.model ? (
              <span className="text-xs text-gray-500">
                {t('answerDebug.modelLabel')}: {debugInfo.model}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label={t('answerDebug.close')}
            className="ml-auto p-1.5 rounded-md hover:bg-gray-100 text-gray-500"
          >
            <XIcon size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {!debugInfo ? (
            <div className="text-sm text-gray-500 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              {t('answerDebug.notCaptured')}
            </div>
          ) : null}
          <Section icon={<Lightbulb size={15} />} title={t('answerDebug.reasoningLabel')}>
            {reasoning ? (
              <div className="text-sm leading-relaxed text-gray-700">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {reasoning}
                </ReactMarkdown>
              </div>
            ) : (
              <div className="text-gray-400 italic">{t('answerDebug.noReasoning')}</div>
            )}
          </Section>

          <Section
            icon={<FileText size={15} />}
            title={t('answerDebug.filesUsedLabel')}
            count={sources.length}
          >
            {sources.length > 0 ? (
              <ul className="space-y-3">
                {sources.map((source) => (
                  <li key={source.index} className="flex gap-2">
                    <span className="shrink-0 text-xs font-mono text-indigo-600 bg-indigo-50 rounded px-1.5 py-0.5 h-fit">
                      [{source.index}]
                    </span>
                    <div className="min-w-0">
                      <div className="font-medium text-gray-800 break-words">
                        {sourceLabel(source, untitled)}
                        {typeof source.pageNumber === 'number' ? (
                          <span className="ml-1.5 text-xs text-gray-500">
                            {t('answerDebug.pageLabel', { n: source.pageNumber })}
                          </span>
                        ) : null}
                      </div>
                      {source.text ? (
                        <div className="mt-1 text-xs text-gray-600 bg-gray-50 rounded p-2 whitespace-pre-wrap line-clamp-6">
                          {source.text}
                        </div>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-gray-400 italic">{t('answerDebug.noSources')}</div>
            )}
          </Section>

          <Section icon={<Quote size={15} />} title={t('answerDebug.howUsedLabel')}>
            {supports.length > 0 ? (
              <ul className="space-y-3">
                {supports.map((support, i) => (
                  <li key={i} className="border-l-2 border-indigo-200 pl-3">
                    <div className="text-gray-700 italic">&ldquo;{support.text}&rdquo;</div>
                    {support.chunkIndices.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {support.chunkIndices.map((idx) => (
                          <span
                            key={idx}
                            className="text-xs font-mono text-indigo-600 bg-indigo-50 rounded px-1.5 py-0.5"
                          >
                            [{idx}]
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : sources.length > 0 ? (
              <div className="text-gray-500">{t('answerDebug.howUsedEmptyGrounded', { count: sources.length })}</div>
            ) : (
              <div className="text-gray-400 italic">{t('answerDebug.howUsedEmpty')}</div>
            )}
          </Section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
