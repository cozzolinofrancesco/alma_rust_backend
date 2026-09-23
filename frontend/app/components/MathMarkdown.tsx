"use client";
import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { MathJax, MathJaxContext } from 'better-react-mathjax';
import { mathJaxConfig, preprocessMath } from '../lib/mathJax';

/**
 * Renders agent/AI markdown with math typeset by MathJax — the same strategy the
 * working "output" view uses (app/ai-agents/edit/[agent-id]/page.tsx). MathJax
 * reads both `$…$` and `\(…\)` / `\[…\]` (per mathJaxConfig), so LaTeX the models
 * emit renders correctly where remark-math + rehype-katex (which only speak
 * `$…$`) previously left it raw.
 *
 * Self-contained: provides its own MathJaxContext. `<MathJax dynamic>` re-typesets
 * when `content` changes (e.g. a step result that arrives after a run).
 */
const REMARK_PLUGINS = [remarkGfm, remarkMath];

export const MathMarkdown = React.memo(({ content }: { content: string }) => {
  const processed = useMemo(() => preprocessMath(content), [content]);
  return (
    <MathJaxContext {...mathJaxConfig}>
      <MathJax dynamic>
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{processed}</ReactMarkdown>
      </MathJax>
    </MathJaxContext>
  );
});
MathMarkdown.displayName = 'MathMarkdown';
