/**
 * Shared MathJax rendering config for agent/AI text output.
 *
 * Single source of truth for the strategy used by the working "output" view
 * (app/ai-agents/edit/[agent-id]/page.tsx) so other surfaces — e.g. the agent
 * step editor — render math identically instead of drifting.
 *
 * Why MathJax (not KaTeX/remark-math alone): the models are prompted to emit
 * MathJax delimiters `\(…\)` / `\[…\]`.
 * remark-math + rehype-katex only recognize `$…$`, so `\(…\)` renders raw there.
 * MathJax is configured below to accept BOTH dialects.
 */

export const mathJaxConfig = {
  config: {
    loader: { load: ['input/tex', 'output/chtml'] },
    tex: {
      inlineMath: [
        ['$', '$'],
        ['\\(', '\\)'],
      ],
      displayMath: [
        ['$$', '$$'],
        ['\\[', '\\]'],
      ],
      packages: ['base', 'ams', 'newcommand', 'mathtools', 'unicode'],
      macros: {
        RR: '{\\mathbb{R}}',
        NN: '{\\mathbb{N}}',
        ZZ: '{\\mathbb{Z}}',
        QQ: '{\\mathbb{Q}}',
        CC: '{\\mathbb{C}}',
        vec: ['\\boldsymbol{#1}', 1],
        norm: ['\\left\\|#1\\right\\|', 1],
        abs: ['\\left|#1\\right|', 1],
      },
    },
    chtml: {
      displayAlign: 'left',
      displayIndent: '2em',
    },
  },
  src: 'https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-chtml.js',
  onError: (error: Error) => {
    console.error('❌ MathJax failed to load from jsDelivr CDN:', error);
  },
};

/**
 * Promote fenced ```latex / ```math blocks and bare `\begin{equation|align|…}`
 * environments to `$$…$$` display math. Mirrors the working output view's
 * preprocessing. Inline `\(…\)` / `\[…\]` are left untouched — MathJax reads
 * them directly per `mathJaxConfig`.
 */
export const preprocessMath = (text: string): string => {
  let processed = text.replace(/```latex\s*\n([\s\S]+?)\n```/g, (match, latexContent) => {
    if (
      latexContent.includes('\\documentclass') ||
      latexContent.includes('\\usepackage') ||
      latexContent.includes('\\begin{document}') ||
      latexContent.includes('\\section')
    ) {
      return match;
    }
    return `$$\n${latexContent.trim()}\n$$`;
  });

  processed = processed.replace(/```math\s*\n([\s\S]+?)\n```/g, (_, f) => `$$\n${f.trim()}\n$$`);

  processed = processed.replace(
    /\\begin\{(equation|align|gather|multline|split)\}([\s\S]*?)\\end\{\1\}/g,
    (match, env, content) => {
      if (!match.trim().startsWith('$$')) {
        return `$$\\begin{${env}}${content}\\end{${env}}$$`;
      }
      return match;
    },
  );

  return processed;
};
