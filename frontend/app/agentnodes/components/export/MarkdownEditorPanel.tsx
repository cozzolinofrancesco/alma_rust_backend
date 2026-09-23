'use client';

import 'katex/dist/katex.min.css';
import {
  Bold,
  Braces,
  Check,
  Code,
  Copy,
  Download,
  Eye,
  FileDown,
  Hash,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Loader2,
  Minus,
  Pilcrow,
  Quote,
  Redo2,
  Sigma,
  Sparkles,
  SquareCode,
  Strikethrough,
  Table as TableIcon,
  Underline as UnderlineIcon,
  Undo2,
  Wand2,
  X as XIcon,
} from 'lucide-react';
import {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import {
  sanitizeMarkdownForDocumentPreview,
  stripSectionMarkerFromExportLabel,
} from '../../../canvas-272/lib/exportFormatter';
import { imageDataSanitizeSchema } from '../../../canvas-272/lib/sanitizeSchema';
import { useLanguage } from '../../../contexts/LanguageContext';
import { DEFAULT_MODEL } from '../../../lib/modelConfig';

export interface MarkdownEditorPanelHandle {
  scrollToSection: (heading: string | null) => void;
}

interface MarkdownEditorPanelProps {
  value: string;
  onChange: (value: string) => void;
  downloadName?: string;
  disableAi?: boolean;
  outlineFocusHeading?: string | null;
}

type AiAction = 'grammar' | 'alternatives' | 'custom';

interface SelectionSnapshot {
  start: number;
  end: number;
  text: string;
}
interface ContextMenuState {
  x: number;
  y: number;
  selection: SelectionSnapshot;
}
interface AiDialogState {
  action: AiAction;
  selection: SelectionSnapshot;
  prompt: string;
}

type FormatKey =
  | 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'codeBlock'
  | 'h1' | 'h2' | 'h3' | 'paragraph'
  | 'ul' | 'ol' | 'quote' | 'hr' | 'table'
  | 'inlineMath' | 'blockMath';

const MAX_HISTORY = 120;

const isMacPlatform = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/i.test(navigator.platform ?? navigator.userAgent ?? '');
};

function buildAiPrompt(action: AiAction, selectedText: string, userPrompt: string): string {
  switch (action) {
    case 'grammar':
      return `Please correct any grammar, spelling, and punctuation errors in the following text while maintaining its original meaning and tone: "${selectedText}"`;
    case 'alternatives':
      return `Please provide 3-5 alternative ways to rephrase the following text while maintaining the same meaning: "${selectedText}"`;
    case 'custom':
      return userPrompt.trim()
        ? `${userPrompt.trim()}\n\nContext text: "${selectedText}"`
        : `Selected text: "${selectedText}"`;
    default:
      return selectedText;
  }
}

function wrapSelection(
  text: string, start: number, end: number,
  prefix: string, suffix: string, placeholder: string,
): { text: string; selectionStart: number; selectionEnd: number } {
  const selected = text.slice(start, end);
  const body = selected.length > 0 ? selected : placeholder;
  const next = `${text.slice(0, start)}${prefix}${body}${suffix}${text.slice(end)}`;
  const newStart = start + prefix.length;
  const newEnd = newStart + body.length;
  return { text: next, selectionStart: newStart, selectionEnd: newEnd };
}

function prependLines(
  text: string, start: number, end: number,
  prefix: string, placeholder: string, numbered = false,
): { text: string; selectionStart: number; selectionEnd: number } {
  const before = text.slice(0, start);
  const selected = text.slice(start, end);
  const after = text.slice(end);
  const lines = (selected.length > 0 ? selected : placeholder).split('\n');
  const decorated = lines
    .map((line, i) => {
      const p = numbered ? `${i + 1}. ` : prefix;
      return `${p}${line}`;
    })
    .join('\n');
  const next = `${before}${decorated}${after}`;
  return { text: next, selectionStart: start, selectionEnd: start + decorated.length };
}

function insertBlock(
  text: string, start: number, end: number, block: string,
): { text: string; selectionStart: number; selectionEnd: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const needsLeadingBreak = before.length > 0 && !before.endsWith('\n\n');
  const needsTrailingBreak = after.length > 0 && !after.startsWith('\n\n');
  const payload = `${needsLeadingBreak ? (before.endsWith('\n') ? '\n' : '\n\n') : ''}${block}${
    needsTrailingBreak ? '\n\n' : ''
  }`;
  const next = `${before}${payload}${after}`;
  const pos = before.length + payload.length;
  return { text: next, selectionStart: pos, selectionEnd: pos };
}

function scrollPreviewContainerToSectionHeading(
  container: HTMLElement,
  heading: string | null,
): void {
  if (!heading) {
    container.scrollTop = 0;
    return;
  }
  const stripped = stripSectionMarkerFromExportLabel(heading);
  const candidates = new Set(
    [heading, stripped]
      .filter((s): s is string => Boolean(s?.trim()))
      .map((s) => s.trim()),
  );
  const hs = container.querySelectorAll('h1');
  for (const h of hs) {
    const t = h.textContent?.trim() ?? '';
    if (candidates.has(t)) {
      const cRect = container.getBoundingClientRect();
      const hRect = h.getBoundingClientRect();
      const nextTop = hRect.top - cRect.top + container.scrollTop - 8;
      container.scrollTop = Math.max(0, nextTop);
      return;
    }
  }
  container.scrollTop = 0;
}

const MarkdownEditorPanel = forwardRef<MarkdownEditorPanelHandle, MarkdownEditorPanelProps>(function MarkdownEditorPanel({
  value,
  onChange,
  downloadName = 'document',
  disableAi = false,
  outlineFocusHeading,
}, ref) {
  const { t } = useLanguage();
  const [showPreview, setShowPreview] = useState(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [showLinkDialog, setShowLinkDialog] = useState<boolean>(false);
  const [linkUrl, setLinkUrl] = useState<string>('');
  const [linkText, setLinkText] = useState<string>('');
  const [showImageDialog, setShowImageDialog] = useState<boolean>(false);
  const [imageUrl, setImageUrl] = useState<string>('');
  const [imageAlt, setImageAlt] = useState<string>('');

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [aiDialog, setAiDialog] = useState<AiDialogState | null>(null);
  const [aiLoading, setAiLoading] = useState<boolean>(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const historyRef = useRef<string[]>([value]);
  const historyIndexRef = useRef<number>(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const showPreviewRef = useRef(false);
  const formatToolbarRef = useRef<HTMLDivElement | null>(null);
  const [toolbarScrollHint, setToolbarScrollHint] = useState<{ moreLeft: boolean; moreRight: boolean }>({
    moreLeft: false,
    moreRight: false,
  });
  const valueRef = useRef<string>(value);
  useEffect(() => { valueRef.current = value; }, [value]);
  useEffect(() => { showPreviewRef.current = showPreview; }, [showPreview]);

  const previewSource = useMemo(
    () => sanitizeMarkdownForDocumentPreview(value),
    [value],
  );

  useEffect(() => {
    if (!showPreview) return undefined;
    const handle = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowPreview(false); };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [showPreview]);

  const syncFormatToolbarScrollHint = useCallback(() => {
    const el = formatToolbarRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    const eps = 2;
    if (scrollWidth <= clientWidth + eps) {
      setToolbarScrollHint({ moreLeft: false, moreRight: false });
      return;
    }
    const maxScroll = scrollWidth - clientWidth;
    setToolbarScrollHint({
      moreLeft: scrollLeft > eps,
      moreRight: scrollLeft < maxScroll - eps,
    });
  }, []);

  useLayoutEffect(() => {
    const el = formatToolbarRef.current;
    if (!el) return undefined;
    syncFormatToolbarScrollHint();
    const onScroll = () => syncFormatToolbarScrollHint();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => syncFormatToolbarScrollHint());
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [syncFormatToolbarScrollHint, showPreview]);

  const runScrollToSection = useCallback((heading: string | null) => {
    const previewRoot = previewScrollRef.current;
    if (showPreviewRef.current && previewRoot) {
      scrollPreviewContainerToSectionHeading(previewRoot, heading);
      return;
    }
    const ta = textareaRef.current;
    if (!ta) return;
    const md = valueRef.current;
    let charPos = 0;
    if (heading) {
      const candidates = [`# ${heading}`, `# ${stripSectionMarkerFromExportLabel(heading)}`];
      for (const p of candidates) {
        const pos = md.indexOf(p);
        if (pos >= 0) {
          charPos = pos;
          break;
        }
      }
    }
    ta.focus();
    ta.setSelectionRange(charPos, charPos);
    requestAnimationFrame(() => {
      const linesBeforePos = md.slice(0, charPos).split('\n').length - 1;
      const lineHeight = parseInt(getComputedStyle(ta).lineHeight, 10) || 20;
      ta.scrollTop = linesBeforePos * lineHeight - 60;
    });
  }, []);

  useLayoutEffect(() => {
    if (outlineFocusHeading === undefined) return;
    if (!showPreview) return;
    const previewRoot = previewScrollRef.current;
    if (!previewRoot) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollPreviewContainerToSectionHeading(previewRoot, outlineFocusHeading);
      });
    });
  }, [showPreview, outlineFocusHeading]);

  useImperativeHandle(ref, () => ({
    scrollToSection: (heading: string | null) => {
      requestAnimationFrame(() => runScrollToSection(heading));
    },
  }), [runScrollToSection]);

  const pushHistory = useCallback((next: string) => {
    const stack = historyRef.current.slice(0, historyIndexRef.current + 1);
    stack.push(next);
    if (stack.length > MAX_HISTORY) stack.shift();
    historyRef.current = stack;
    historyIndexRef.current = stack.length - 1;
  }, []);

  const commitChange = useCallback(
    (next: string, selection?: { start: number; end: number }) => {
      onChange(next);
      pushHistory(next);
      if (selection) {
        requestAnimationFrame(() => {
          const ta = textareaRef.current;
          if (!ta) return;
          ta.focus();
          ta.setSelectionRange(selection.start, selection.end);
        });
      }
    },
    [onChange, pushHistory],
  );

  const undo = useCallback(() => {
    if (historyIndexRef.current <= 0) return;
    historyIndexRef.current -= 1;
    onChange(historyRef.current[historyIndexRef.current]);
  }, [onChange]);

  const redo = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyIndexRef.current += 1;
    onChange(historyRef.current[historyIndexRef.current]);
  }, [onChange]);

  const getSelection = useCallback((): { start: number; end: number } => {
    const ta = textareaRef.current;
    if (!ta) return { start: 0, end: 0 };
    return { start: ta.selectionStart, end: ta.selectionEnd };
  }, []);

  const applyFormat = useCallback(
    (kind: FormatKey) => {
      const { start, end } = getSelection();
      const v = valueRef.current;
      let result: { text: string; selectionStart: number; selectionEnd: number };
      switch (kind) {
        case 'bold':       result = wrapSelection(v, start, end, '**', '**', 'bold text'); break;
        case 'italic':     result = wrapSelection(v, start, end, '*', '*', 'italic text'); break;
        case 'underline':  result = wrapSelection(v, start, end, '<u>', '</u>', 'underlined text'); break;
        case 'strike':     result = wrapSelection(v, start, end, '~~', '~~', 'strikethrough'); break;
        case 'code':       result = wrapSelection(v, start, end, '`', '`', 'code'); break;
        case 'inlineMath': result = wrapSelection(v, start, end, '$', '$', 'E = mc^2'); break;
        case 'h1':         result = prependLines(v, start, end, '# ', 'Heading 1'); break;
        case 'h2':         result = prependLines(v, start, end, '## ', 'Heading 2'); break;
        case 'h3':         result = prependLines(v, start, end, '### ', 'Heading 3'); break;
        case 'paragraph':  result = { text: v, selectionStart: start, selectionEnd: end }; break;
        case 'ul':         result = prependLines(v, start, end, '- ', 'List item'); break;
        case 'ol':         result = prependLines(v, start, end, '', 'List item', true); break;
        case 'quote':      result = prependLines(v, start, end, '> ', 'Quote'); break;
        case 'hr':         result = insertBlock(v, start, end, '---'); break;
        case 'codeBlock':  result = insertBlock(v, start, end, '```ts\n// code here\n```'); break;
        case 'blockMath':  result = insertBlock(v, start, end, '$$\n\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}\n$$'); break;
        case 'table':
          result = insertBlock(v, start, end,
            '| Column A | Column B | Column C |\n| --- | --- | --- |\n| a1 | b1 | c1 |\n| a2 | b2 | c2 |');
          break;
        default: return;
      }
      commitChange(result.text, { start: result.selectionStart, end: result.selectionEnd });
    },
    [commitChange, getSelection],
  );

  const openLinkDialog = useCallback(() => {
    const { start, end } = getSelection();
    const selected = valueRef.current.slice(start, end);
    setLinkText(selected);
    setLinkUrl('');
    setShowLinkDialog(true);
  }, [getSelection]);

  const confirmLink = useCallback(() => {
    if (!linkUrl.trim()) { setShowLinkDialog(false); return; }
    const label = linkText.trim() || linkUrl.trim();
    const { start, end } = getSelection();
    const md = `[${label}](${linkUrl.trim()})`;
    const v = valueRef.current;
    const before = v.slice(0, start);
    const after = v.slice(end);
    commitChange(`${before}${md}${after}`, {
      start: before.length + md.length, end: before.length + md.length,
    });
    setShowLinkDialog(false);
  }, [commitChange, getSelection, linkText, linkUrl]);

  const openImageDialog = useCallback(() => {
    setImageAlt(''); setImageUrl(''); setShowImageDialog(true);
  }, []);

  const confirmImage = useCallback(() => {
    if (!imageUrl.trim()) { setShowImageDialog(false); return; }
    const { start, end } = getSelection();
    const md = `![${imageAlt.trim() || 'image'}](${imageUrl.trim()})`;
    const v = valueRef.current;
    const before = v.slice(0, start);
    const after = v.slice(end);
    commitChange(`${before}${md}${after}`, {
      start: before.length + md.length, end: before.length + md.length,
    });
    setShowImageDialog(false);
  }, [commitChange, getSelection, imageAlt, imageUrl]);

  const openAiMenu = useCallback(
    (e: React.MouseEvent<HTMLTextAreaElement>) => {
      if (disableAi) return;
      const ta = textareaRef.current;
      if (!ta) return;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      if (start === end) return;
      e.preventDefault();
      setContextMenu({
        x: e.clientX, y: e.clientY,
        selection: { start, end, text: valueRef.current.slice(start, end) },
      });
    },
    [disableAi],
  );

  const handleEditorContextMenu = openAiMenu;

  const handleEditorClick = useCallback(
    (e: React.MouseEvent<HTMLTextAreaElement>) => {
      const isMac = isMacPlatform();
      if (isMac ? e.metaKey : e.ctrlKey) {
        openAiMenu(e);
      }
    },
    [openAiMenu],
  );

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-an-ctx-menu]')) return;
      closeContextMenu();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeContextMenu(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu, closeContextMenu]);

  const runAiReplace = useCallback(
    async (action: AiAction, selection: SelectionSnapshot, userPrompt: string) => {
      if (!selection.text.trim()) return;
      setAiLoading(true);
      setAiError(null);
      try {
        const finalPrompt = buildAiPrompt(action, selection.text, userPrompt);
        const res = await fetch('/api/gemini', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', text: finalPrompt }],
            model: DEFAULT_MODEL,
          }),
        });
        const data: { response?: string; error?: string } = await res.json();
        if (!res.ok) throw new Error(data.error || `AI request failed (HTTP ${res.status})`);
        const aiText = (data.response ?? '').trim();
        if (!aiText) throw new Error('AI returned an empty response');
        const v = valueRef.current;
        const before = v.slice(0, selection.start);
        const after = v.slice(selection.end);
        commitChange(`${before}${aiText}${after}`, {
          start: selection.start, end: selection.start + aiText.length,
        });
        setAiDialog(null);
      } catch (err) {
        setAiError(err instanceof Error ? err.message : 'AI request failed');
      } finally {
        setAiLoading(false);
      }
    },
    [commitChange],
  );

  const handleChooseAiAction = useCallback(
    (action: AiAction) => {
      if (!contextMenu) return;
      const { selection } = contextMenu;
      setContextMenu(null);
      if (action === 'custom') {
        setAiDialog({ action, selection, prompt: '' });
        return;
      }
      void runAiReplace(action, selection, '');
    },
    [contextMenu, runAiReplace],
  );

  const handleCopy = useCallback(async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(valueRef.current);
      } else if (textareaRef.current) {
        textareaRef.current.select();
        document.execCommand('copy');
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
    }
  }, []);

  const handleDownload = useCallback(
    (ext: 'md' | 'txt') => {
      const safeName = downloadName.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 80) || 'document';
      const payload = sanitizeMarkdownForDocumentPreview(valueRef.current);
      const blob = new Blob([payload], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeName}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    [downloadName],
  );

  const handleTextAreaKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const { start, end } = getSelection();
      const v = valueRef.current;
      const insert = '  ';
      commitChange(`${v.slice(0, start)}${insert}${v.slice(end)}`, {
        start: start + insert.length, end: start + insert.length,
      });
      return;
    }
    const isMac = isMacPlatform();
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === 'b') { e.preventDefault(); applyFormat('bold'); return; }
    if (key === 'i' && !e.shiftKey) { e.preventDefault(); applyFormat('italic'); return; }
    if (key === 'u') { e.preventDefault(); applyFormat('underline'); return; }
    if (key === 'k') { e.preventDefault(); openLinkDialog(); return; }
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); redo(); }
  };

  const markdownComponents = useMemo(
    () => ({
      a: (props: React.HTMLAttributes<HTMLAnchorElement>) => (
        <a {...props} target="_blank" rel="noreferrer" />
      ),
    }),
    [],
  );

  const handleAiDialogBackdrop = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !aiLoading) setAiDialog(null);
  };

  return (
    <div className="an-md-editor">
      <div
        className={[
          'an-md-editor__toolbar-wrap',
          toolbarScrollHint.moreLeft ? 'an-md-editor__toolbar-wrap--more-left' : '',
          toolbarScrollHint.moreRight ? 'an-md-editor__toolbar-wrap--more-right' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <div
          ref={formatToolbarRef}
          className="c272-toolbar2"
          role="toolbar"
          aria-label={t('canvas272Page.formattingToolbar')}
        >
        <button
          type="button"
          className={`c272-tb${showPreview ? ' c272-tb--active' : ''}`}
          onClick={() => setShowPreview((x) => !x)}
          title={t('canvas272Page.previewMarkdownTitle')}
          aria-pressed={showPreview}
          aria-label={showPreview ? t('canvas272Page.previewMarkdownAriaHide') : t('canvas272Page.previewMarkdownAriaShow')}
        >
          <Eye size={15} strokeWidth={2} aria-hidden />
        </button>
        <span className="c272-tb__sep" />
        <button className="c272-tb" onClick={undo} title={t('canvas272Page.undoTitle')} type="button"><Undo2 size={15} /></button>
        <button className="c272-tb" onClick={redo} title={t('canvas272Page.redoTitle')} type="button"><Redo2 size={15} /></button>
        <span className="c272-tb__sep" />
        <button className="c272-tb" onClick={() => applyFormat('bold')} title={t('canvas272Page.boldTitle')} type="button"><Bold size={15} /></button>
        <button className="c272-tb" onClick={() => applyFormat('italic')} title={t('canvas272Page.italicTitle')} type="button"><Italic size={15} /></button>
        <button className="c272-tb" onClick={() => applyFormat('underline')} title={t('canvas272Page.underlineTitle')} type="button"><UnderlineIcon size={15} /></button>
        <button className="c272-tb" onClick={() => applyFormat('strike')} title={t('canvas272Page.strikeTitle')} type="button"><Strikethrough size={15} /></button>
        <button className="c272-tb" onClick={() => applyFormat('code')} title={t('canvas272Page.codeTitle')} type="button"><Code size={15} /></button>
        <span className="c272-tb__sep" />
        <button className="c272-tb" onClick={() => applyFormat('h1')} title={t('canvas272Page.h1Title')} type="button">
          <Hash size={14} /><span className="c272-tb__label">1</span>
        </button>
        <button className="c272-tb" onClick={() => applyFormat('h2')} title={t('canvas272Page.h2Title')} type="button">
          <Hash size={14} /><span className="c272-tb__label">2</span>
        </button>
        <button className="c272-tb" onClick={() => applyFormat('h3')} title={t('canvas272Page.h3Title')} type="button">
          <Hash size={14} /><span className="c272-tb__label">3</span>
        </button>
        <button className="c272-tb" onClick={() => applyFormat('paragraph')} title={t('canvas272Page.paragraphTitle')} type="button"><Pilcrow size={15} /></button>
        <span className="c272-tb__sep" />
        <button className="c272-tb" onClick={() => applyFormat('ul')} title={t('canvas272Page.ulTitle')} type="button"><List size={15} /></button>
        <button className="c272-tb" onClick={() => applyFormat('ol')} title={t('canvas272Page.olTitle')} type="button"><ListOrdered size={15} /></button>
        <button className="c272-tb" onClick={() => applyFormat('quote')} title={t('canvas272Page.quoteTitle')} type="button"><Quote size={15} /></button>
        <button className="c272-tb" onClick={() => applyFormat('hr')} title={t('canvas272Page.hrTitle')} type="button"><Minus size={15} /></button>
        <span className="c272-tb__sep" />
        <button className="c272-tb" onClick={() => applyFormat('codeBlock')} title={t('canvas272Page.codeBlockTitle')} type="button"><SquareCode size={15} /></button>
        <button className="c272-tb" onClick={() => applyFormat('table')} title={t('canvas272Page.tableTitle')} type="button"><TableIcon size={15} /></button>
        <button className="c272-tb" onClick={openLinkDialog} title={t('canvas272Page.linkTitle')} type="button"><LinkIcon size={15} /></button>
        <button className="c272-tb" onClick={openImageDialog} title={t('canvas272Page.imageTitle')} type="button"><ImageIcon size={15} /></button>
        <span className="c272-tb__sep" />
        <button className="c272-tb" onClick={() => applyFormat('inlineMath')} title={t('canvas272Page.inlineMathTitle')} type="button"><Sigma size={15} /></button>
        <button className="c272-tb" onClick={() => applyFormat('blockMath')} title={t('canvas272Page.blockMathTitle')} type="button"><Braces size={15} /></button>
        <span className="c272-tb__spacer" />
        <button className="c272-tb" onClick={handleCopy} title={t('canvas272Page.copyMarkdown')} type="button">
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </button>
        <button className="c272-tb" onClick={() => handleDownload('md')} title={t('canvas272Page.downloadMd')} type="button"><FileDown size={15} /></button>
        <button className="c272-tb" onClick={() => handleDownload('txt')} title={t('canvas272Page.downloadTxt')} type="button"><Download size={15} /></button>
        </div>
      </div>

      {}
      <div className="an-md-editor__body">
        {showPreview ? (
          <div ref={previewScrollRef} className="an-md-preview-inline markdown-body">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
              rehypePlugins={[rehypeRaw, [rehypeSanitize, imageDataSanitizeSchema], rehypeKatex]}
              components={markdownComponents}
            >
              {previewSource || t('canvas272Page.emptyPreview')}
            </ReactMarkdown>
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            className="c272-modal__editor"
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              const last = historyRef.current[historyIndexRef.current];
              if (last !== e.target.value) pushHistory(e.target.value);
            }}
            onKeyDown={handleTextAreaKeyDown}
            onContextMenu={handleEditorContextMenu}
            onClick={handleEditorClick}
            placeholder={t('canvas272Page.exportMarkdownPlaceholder')}
            spellCheck
          />
        )}
      </div>

      {}
      {showLinkDialog ? (
        <div className="c272-inline-dialog" role="dialog" aria-label={t('canvas272Page.insertLinkAria')}>
          <div className="c272-inline-dialog__row">
            <label>{t('canvas272Page.textLabel')}</label>
            <input
              type="text"
              value={linkText}
              onChange={(e) => setLinkText(e.target.value)}
              placeholder={t('canvas272Page.linkLabelPlaceholder')}
            />
          </div>
          <div className="c272-inline-dialog__row">
            <label>{t('canvas272Page.urlLabel')}</label>
            <input
              type="url"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder={t('canvas272Page.urlInputPlaceholder')}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmLink();
                if (e.key === 'Escape') setShowLinkDialog(false);
              }}
            />
          </div>
          <div className="c272-inline-dialog__actions">
            <button className="c272-btn" onClick={() => setShowLinkDialog(false)} type="button">{t('canvas272Page.cancel')}</button>
            <button className="c272-btn c272-btn--primary" onClick={confirmLink} type="button">{t('canvas272Page.insertBtn')}</button>
          </div>
        </div>
      ) : null}

      {}
      {showImageDialog ? (
        <div className="c272-inline-dialog" role="dialog" aria-label={t('canvas272Page.insertImageAria')}>
          <div className="c272-inline-dialog__row">
            <label>{t('canvas272Page.imageAltShortLabel')}</label>
            <input
              type="text"
              value={imageAlt}
              onChange={(e) => setImageAlt(e.target.value)}
              placeholder={t('canvas272Page.imageAltPlaceholder')}
            />
          </div>
          <div className="c272-inline-dialog__row">
            <label>{t('canvas272Page.urlLabel')}</label>
            <input
              type="url"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              placeholder={t('canvas272Page.urlInputPlaceholder')}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmImage();
                if (e.key === 'Escape') setShowImageDialog(false);
              }}
            />
          </div>
          <div className="c272-inline-dialog__actions">
            <button className="c272-btn" onClick={() => setShowImageDialog(false)} type="button">{t('canvas272Page.cancel')}</button>
            <button className="c272-btn c272-btn--primary" onClick={confirmImage} type="button">{t('canvas272Page.insertBtn')}</button>
          </div>
        </div>
      ) : null}

      {}
      {contextMenu ? (
        <div
          data-an-ctx-menu
          className="c272-ctx-menu"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y, position: 'fixed' }}
        >
          <div className="c272-ctx-menu__head">
            <Sparkles size={13} />
            <span>{t('canvas272Page.aiMenuHead')}</span>
          </div>
          <button type="button" className="c272-ctx-menu__item" onClick={() => handleChooseAiAction('grammar')}>
            <Wand2 size={14} />
            <div>
              <div className="c272-ctx-menu__title">{t('canvas272Page.grammarTitle')}</div>
              <div className="c272-ctx-menu__sub">{t('canvas272Page.grammarSub')}</div>
            </div>
          </button>
          <button type="button" className="c272-ctx-menu__item" onClick={() => handleChooseAiAction('alternatives')}>
            <Wand2 size={14} />
            <div>
              <div className="c272-ctx-menu__title">{t('canvas272Page.alternativesTitle')}</div>
              <div className="c272-ctx-menu__sub">{t('canvas272Page.alternativesSub')}</div>
            </div>
          </button>
          <button type="button" className="c272-ctx-menu__item" onClick={() => handleChooseAiAction('custom')}>
            <Wand2 size={14} />
            <div>
              <div className="c272-ctx-menu__title">{t('canvas272Page.customPromptTitle')}</div>
              <div className="c272-ctx-menu__sub">{t('canvas272Page.customPromptSub')}</div>
            </div>
          </button>
        </div>
      ) : null}

      {}
      {aiDialog ? (
        <div className="c272-ai-dialog-backdrop" onMouseDown={handleAiDialogBackdrop}>
          <div className="c272-ai-dialog" role="dialog" aria-label={t('canvas272Page.aiCustomPromptAria')}>
            <div className="c272-ai-dialog__header">
              <Sparkles size={16} />
              <span>
                {aiDialog.action === 'grammar'
                  ? t('canvas272Page.aiGrammarCheck')
                  : aiDialog.action === 'alternatives'
                  ? t('canvas272Page.aiAlternatives')
                  : t('canvas272Page.aiCustomPromptLabel')}
              </span>
              <div className="c272-modal__spacer" />
              <button
                className="c272-modal__close"
                aria-label={t('canvas272Page.closeModal')}
                onClick={() => !aiLoading && setAiDialog(null)}
                type="button"
              >
                <XIcon size={16} />
              </button>
            </div>
            <div className="c272-ai-dialog__body">
              <div className="c272-ai-dialog__section">
                <div className="c272-ai-dialog__label">{t('canvas272Page.selectedText')}</div>
                <div className="c272-ai-dialog__selection">&ldquo;{aiDialog.selection.text}&rdquo;</div>
              </div>
              {aiDialog.action === 'custom' ? (
                <div className="c272-ai-dialog__section">
                  <div className="c272-ai-dialog__label">{t('canvas272Page.yourPrompt')}</div>
                  <textarea
                    className="c272-ai-dialog__prompt"
                    value={aiDialog.prompt}
                    onChange={(e) =>
                      setAiDialog((prev) => (prev ? { ...prev, prompt: e.target.value } : prev))
                    }
                    placeholder={t('canvas272Page.customPromptPlaceholderExport')}
                    autoFocus
                    rows={4}
                  />
                </div>
              ) : null}
              {aiError ? (
                <div className="c272-ai-dialog__error" role="alert">{aiError}</div>
              ) : null}
              <div className="c272-ai-dialog__note">
                {t('canvas272Page.aiReplaceNote')}
              </div>
            </div>
            <div className="c272-ai-dialog__footer">
              <button
                type="button"
                className="c272-btn"
                disabled={aiLoading}
                onClick={() => setAiDialog(null)}
              >{t('canvas272Page.cancel')}</button>
              <div className="c272-modal__spacer" />
              <button
                type="button"
                className="c272-btn c272-btn--primary"
                disabled={aiLoading || (aiDialog.action === 'custom' && !aiDialog.prompt.trim())}
                onClick={() => runAiReplace(aiDialog.action, aiDialog.selection, aiDialog.prompt)}
              >
                {aiLoading ? (
                  <><Loader2 size={14} className="c272-spin" /> {t('canvas272Page.generating')}</>
                ) : (
                  <><Sparkles size={14} /> {t('canvas272Page.sendToAi')}</>
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {aiLoading && !aiDialog ? (
        <div className="c272-ai-loading" role="status" aria-live="polite">
          <Loader2 size={16} className="c272-spin" />
          <span>{t('canvas272Page.askingAi')}</span>
        </div>
      ) : null}
    </div>
  );
});

MarkdownEditorPanel.displayName = 'MarkdownEditorPanel';

export default MarkdownEditorPanel;
