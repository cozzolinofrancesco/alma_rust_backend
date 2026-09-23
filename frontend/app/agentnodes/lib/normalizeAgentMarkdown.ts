/**
 * Normalizes raw step-agent output into markdown that renders cleanly with
 * remark-gfm + remark-math + rehype-katex.
 *
 * Agents frequently emit output that is *almost* markdown but breaks two ways:
 *  1. Bare LaTeX with no `$` delimiters, e.g. `6.62 \times 10^{-3}`. remark-math
 *     only renders math inside `$…$` / `$$…$$`, so un-delimited LaTeX shows raw.
 *  2. Tab-separated rows instead of pipe tables. remark-gfm only recognizes
 *     `|`-delimited tables, so tab rows render as a run of plain text.
 *
 * Two passes share one engine, differing only in what counts as a math "signal":
 *  - `normalizeAgentMarkdown` (pass 1) wraps a *curated* set of known commands.
 *    Precise: it only touches spans built from recognized commands.
 *  - `verifyAndRepairMath` (pass 2) is a *catch-all* safety net that wraps any
 *    residual `\command` the curated list missed (this is how `\text` used to
 *    slip through and render raw). Run it after pass 1: already-wrapped `$…$`
 *    and code spans are protected, so it only repairs what leaked.
 *  - `finalizeAgentMarkdown` composes both and is what render sites should call.
 *
 * Every pass is deterministic, idempotent, and conservative:
 *  - It never touches fenced code blocks or inline `code` spans.
 *  - It never re-wraps content already inside `$…$` / `$$…$$`.
 *  - It only wraps spans that contain a real LaTeX signal.
 */

// Atoms that can appear inside a math span (none of these is a plain letter,
// so a math span can never bleed into surrounding words).
const MATH_ATOM = String.raw`(?:[-+]?\d[\d.,]*|\\[a-zA-Z]+|\{[^}]*\}|[\^_×·/]|\s)`;

// Curated signal (pass 1): presence of one of these well-known commands is what
// marks a span as math. The trailing `(?![a-zA-Z])` (not `\b`) terminates the
// command name while still allowing a following `_`, digit, or `{` — so
// subscripted commands like `\sigma_1` are recognized. Longer alternatives are
// listed before their prefixes (e.g. `leq` before `le`) so the short form can't
// win first.
const CURATED_SIGNAL = String.raw`(?:\\(?:times|cdot|pm|div|leq|geq|le|ge|neq|approx|sim|propto|frac|sqrt|log|ln|exp|alpha|beta|gamma|delta|epsilon|sigma|mu|nu|lambda|theta|phi|psi|omega|rho|tau|infty|sum|prod|int|partial|nabla|text|mathrm|mathbf|mathit|operatorname)(?![a-zA-Z])|\^\{[^}]*\}|_\{[^}]*\})`;

// Catch-all signal (pass 2): ANY LaTeX command `\word`, plus braced sub/super-
// scripts. Broader than the curated list on purpose — it repairs residual bare
// LaTeX the curated pass didn't know about. Markdown escapes are `\` + a single
// punctuation char (`\*`, `\_`, `\#`), never `\` + letters, so this does not
// touch escaped markdown. (A literal Windows path like `C:\Users` in prose is
// the one benign false positive; agent math output effectively never contains
// one.)
const CATCHALL_SIGNAL = String.raw`(?:\\[a-zA-Z]+|\^\{[^}]*\}|_\{[^}]*\})`;

// A maximal math span: math atoms surrounding at least one signal.
const CURATED_SPAN = new RegExp(`${MATH_ATOM}*${CURATED_SIGNAL}${MATH_ATOM}*`, 'g');
const CATCHALL_SPAN = new RegExp(`${MATH_ATOM}*${CATCHALL_SIGNAL}${MATH_ATOM}*`, 'g');

// Segments to leave untouched: inline code, block math, inline math.
const PROTECTED_SEGMENT = /(`+)[^]*?\1|\$\$[^]*?\$\$|\$[^$\n]*?\$/g;

/** Wrap bare-LaTeX spans in a plain (non-code, non-math) segment with `$…$`. */
function wrapMathInPlain(segment: string, spanRegex: RegExp): string {
  return segment.replace(spanRegex, (match) => {
    const lead = /^\s*/.exec(match)?.[0] ?? '';
    const trail = /\s*$/.exec(match)?.[0] ?? '';
    const core = match.slice(lead.length, match.length - trail.length);
    if (!core) return match;
    return `${lead}$${core}$${trail}`;
  });
}

/** Wrap bare LaTeX in a single line, preserving inline code and existing math. */
function wrapInlineMath(line: string, spanRegex: RegExp): string {
  let result = '';
  let lastIndex = 0;
  PROTECTED_SEGMENT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PROTECTED_SEGMENT.exec(line)) !== null) {
    result += wrapMathInPlain(line.slice(lastIndex, match.index), spanRegex);
    result += match[0];
    lastIndex = match.index + match[0].length;
  }
  result += wrapMathInPlain(line.slice(lastIndex), spanRegex);
  return result;
}

const isTabRow = (line: string): boolean => line.includes('\t');

/** Convert a block of consecutive tab-separated lines into a GFM pipe table. */
function tabBlockToPipeTable(rows: string[], spanRegex: RegExp): string[] {
  const cells = rows.map((row) =>
    row.split('\t').map((cell) => wrapInlineMath(cell.trim(), spanRegex).replace(/\|/g, '\\|')),
  );
  const columnCount = cells.reduce((max, row) => Math.max(max, row.length), 0);
  const pad = (row: string[]): string[] =>
    row.length >= columnCount
      ? row
      : [...row, ...Array<string>(columnCount - row.length).fill('')];
  const toPipeRow = (row: string[]): string => `| ${pad(row).join(' | ')} |`;

  const [header, ...body] = cells;
  const separator = `| ${Array<string>(columnCount).fill('---').join(' | ')} |`;
  return ['', toPipeRow(header), separator, ...body.map(toPipeRow), ''];
}

/** Shared line-by-line engine; `spanRegex` selects which pass (curated vs catch-all). */
function wrapBareMath(input: string, spanRegex: RegExp): string {
  if (!input) return input;

  const lines = input.split('\n');
  const output: string[] = [];
  let inFence = false;
  let fenceChar = '';
  let tableBuffer: string[] = [];

  const flushTable = (): void => {
    if (tableBuffer.length > 0) {
      output.push(...tabBlockToPipeTable(tableBuffer, spanRegex));
      tableBuffer = [];
    }
  };

  for (const line of lines) {
    const fence = /^(\s*)(`{3,}|~{3,})/.exec(line);
    if (fence) {
      flushTable();
      const marker = fence[2][0];
      if (!inFence) {
        inFence = true;
        fenceChar = marker;
      } else if (marker === fenceChar) {
        inFence = false;
      }
      output.push(line);
      continue;
    }

    if (inFence) {
      output.push(line);
      continue;
    }

    if (isTabRow(line)) {
      tableBuffer.push(line);
      continue;
    }

    flushTable();
    output.push(wrapInlineMath(line, spanRegex));
  }

  flushTable();
  return output.join('\n');
}

/** Pass 1 — wrap a curated set of known LaTeX commands. */
export function normalizeAgentMarkdown(input: string): string {
  return wrapBareMath(input, CURATED_SPAN);
}

/**
 * Pass 2 — catch-all safety net. Wraps any residual bare `\command` the curated
 * pass missed. Idempotent and safe to run on already-normalized text: existing
 * `$…$` and code spans are protected, so only leaked LaTeX is repaired.
 */
export function verifyAndRepairMath(input: string): string {
  return wrapBareMath(input, CATCHALL_SPAN);
}

/**
 * Final render-ready transform: curated pass, then catch-all repair. Render
 * sites should call this so no bare LaTeX ever reaches the KaTeX renderer.
 */
export function finalizeAgentMarkdown(input: string): string {
  return verifyAndRepairMath(normalizeAgentMarkdown(input));
}
