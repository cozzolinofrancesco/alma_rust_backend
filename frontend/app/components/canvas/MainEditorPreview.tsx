'use client';

import 'katex/dist/katex.min.css';
import React from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { useTheme } from '../../contexts/ThemeContext';
import styles from '../../styles/canvas/MainEditor.module.css';

const REMARK_PLUGINS = [remarkMath, remarkGfm, remarkBreaks];
const REHYPE_PLUGINS = [rehypeKatex, rehypeRaw, rehypeSanitize];

interface MainEditorPreviewProps {
  markdown: string;
}

const MainEditorPreview: React.FC<MainEditorPreviewProps> = ({ markdown }) => {
  const { theme, isDarkMode } = useTheme();

  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={{
        code: (props: { className?: string; children?: React.ReactNode }) => {
          const { className, children } = props;
          const match = /language-(\w+)/.exec(className || '');
          const language = match ? match[1] : '';
          const isInline = !className;

          if (language === 'mermaid') {
            return (
              <div className="mermaid-container my-4 p-4 border rounded-lg bg-gray-50">
                <div className="text-sm text-gray-600 mb-2">
                  Mermaid Diagram
                </div>
                <pre className="whitespace-pre-wrap text-sm bg-gray-100 p-2 rounded border">
                  {children}
                </pre>
                <div className="text-xs text-gray-500 mt-2">
                  In production, this would render as an interactive diagram
                </div>
              </div>
            );
          }

          return (
            <code
              {...props}
              className={`${className} ${isInline ? 'px-1 py-0.5 bg-gray-100 rounded text-sm' : 'block p-2 bg-gray-100 rounded text-sm'}`}
            >
              {children}
            </code>
          );
        },
        table: ({ children }) => (
          <table className="min-w-full border-collapse border border-gray-300 my-4">
            {children}
          </table>
        ),
        th: ({ children }) => (
          <th className="border border-gray-300 px-4 py-2 bg-gray-100 text-left font-semibold">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border border-gray-300 px-4 py-2">
            {children}
          </td>
        ),
        h1: ({ children }) => (
          <h1 className={`text-3xl font-bold mb-6 ${theme.textPrimary} leading-tight`}>
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2 className={`text-2xl font-semibold mb-4 ${theme.textPrimary} leading-tight`}>
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 className={`text-xl font-medium mb-3 ${theme.textSecondary} leading-tight`}>
            {children}
          </h3>
        ),
        p: ({ children }) => (
          <p className={`mb-4 ${theme.textSecondary} leading-relaxed`}>
            {children}
          </p>
        ),
        ul: ({ children }) => (
          <ul className={`mb-4 pl-6 space-y-2 ${theme.textSecondary} list-disc`}>
            {children}
          </ul>
        ),
        ol: ({ children }) => (
          <ol className={`mb-4 pl-6 space-y-2 ${theme.textSecondary} list-decimal`}>
            {children}
          </ol>
        ),
        li: ({ children }) => (
          <li className={`${theme.textSecondary} leading-relaxed`}>
            {children}
          </li>
        ),
        blockquote: ({ children }) => (
          <blockquote className={`border-l-4 ${isDarkMode ? 'border-gray-500' : 'border-gray-400'} pl-6 my-4 italic ${theme.textSecondary} ${theme.cardBg} py-2 rounded-r`}>
            {children}
          </blockquote>
        ),
        a: ({ children, href }) => (
          <a
            href={href}
            className="text-blue-600 hover:text-blue-800 underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            {children}
          </a>
        ),
        img: ({ src, alt, ...props }) => {
          if (!src || src.trim() === '') {
            return null;
          }

          if (src.includes('drive.google.com')) {
            let fileId = '';
            if (src.includes('/file/d/')) {
              fileId = src.match(/\/file\/d\/([a-zA-Z0-9-_]+)/)?.[1] || '';
            } else if (src.includes('id=')) {
              fileId = src.match(/id=([a-zA-Z0-9-_]+)/)?.[1] || '';
            }

            if (fileId) {
              return (
                <span className="inline-block my-4 rounded-lg overflow-hidden shadow-sm w-full">
                  <iframe
                    src={`https://drive.google.com/file/d/${fileId}/preview`}
                    style={{
                      width: '100%',
                      height: '400px',
                      border: 'none',
                      borderRadius: '8px'
                    }}
                    allowFullScreen
                    title={alt || 'Google Drive Image'}
                  />
                </span>
              );
            }
          }

          return (
            <img
              src={src}
              alt={alt || ''}
              {...props}
              className={`${styles.markdownImg} ${theme.borderColor}`}
              onError={(e) => {
                const target = e.target as HTMLImageElement;
                target.style.display = 'none';
              }}
            />
          );
        },
        u: ({ children }) => (
          <u className={theme.textSecondary}>
            {children}
          </u>
        ),
        del: ({ children }) => (
          <del className={`${theme.textSecondary} line-through`}>
            {children}
          </del>
        )
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
};

export default MainEditorPreview;
