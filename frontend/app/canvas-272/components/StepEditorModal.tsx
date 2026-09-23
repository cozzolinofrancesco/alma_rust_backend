'use client';

import 'katex/dist/katex.min.css';
import {
  Bold,
  Braces,
  Bug,
  Check,
  Code,
  Columns,
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
  Maximize2,
  Minimize2,
  Minus,
  Pilcrow,
  Quote,
  Redo2,
  Sigma,
  Sparkles,
  SquareCode,
  Strikethrough,
  Table as TableIcon,
  Type,
  Underline as UnderlineIcon,
  Undo2,
  Wand2,
  X as XIcon,
} from 'lucide-react';
import { DEFAULT_MODEL } from '../../lib/modelConfig';
import { useLanguage } from '../../contexts/LanguageContext';
import {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

interface StepEditorModalProps {
  open: boolean;
  title: string;
  stepLabel: string;
  initialValue: string;
  onClose: () => void;
  onSave: (value: string) => void;
  onOpenDebug?: () => void;
}

type ViewMode = 'split' | 'editor' | 'preview';
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
type FormatKey =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'code'
  | 'codeBlock'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'paragraph'
  | 'ul'
  | 'ol'
  | 'quote'
  | 'hr'
  | 'table'
  | 'inlineMath'
  | 'blockMath';

const MAX_HISTORY = 120;

const isMacPlatform = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/i.test(navigator.platform ?? navigator.userAgent ?? '');
};

const countWords = (s: string): number => {
  const trimmed = s.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
};

function wrapSelection(
  text: string,
  start: number,
  end: number,
  prefix: string,
  suffix: string,
  placeholder: string,
): { text: string; selectionStart: number; selectionEnd: number } {
  const selected = text.slice(start, end);
  const body = selected.length > 0 ? selected : placeholder;
  const next = `${text.slice(0, start)}${prefix}${body}${suffix}${text.slice(end)}`;
  const newStart = start + prefix.length;
  const newEnd = newStart + body.length;
  return { text: next, selectionStart: newStart, selectionEnd: newEnd };
}

function prependLines(
  text: string,
  start: number,
  end: number,
  prefix: string,
  placeholder: string,
  numbered = false,
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
  return {
    text: next,
    selectionStart: start,
    selectionEnd: start + decorated.length,
  };
}

function insertBlock(
  text: string,
  start: number,
  end: number,
  block: string,
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

export default function StepEditorModal({
  open,
  title,
  stepLabel,
  initialValue,
  onClose,
  onSave,
  onOpenDebug,
}: StepEditorModalProps) {
  const { t } = useLanguage();
  const [value, setValue] = useState<string>(initialValue);
  const [viewMode, setViewMode] = useState<ViewMode>('split');
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
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

  const historyRef = useRef<string[]>([initialValue]);
  const historyIndexRef = useRef<number>(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastInitialRef = useRef<string>(initialValue);

  useEffect(() => {
    if (!open) return;
    if (lastInitialRef.current !== initialValue) {
      lastInitialRef.current = initialValue;
    }
    setValue(initialValue);
    historyRef.current = [initialValue];
    historyIndexRef.current = 0;
    setCopied(false);
    setShowLinkDialog(false);
    setShowImageDialog(false);
    setContextMenu(null);
    setAiDialog(null);
    setAiError(null);
    setAiLoading(false);
  }, [initialValue, open]);

  const pushHistory = useCallback((next: string) => {
    const stack = historyRef.current.slice(0, historyIndexRef.current + 1);
    stack.push(next);
    if (stack.length > MAX_HISTORY) stack.shift();
    historyRef.current = stack;
    historyIndexRef.current = stack.length - 1;
  }, []);

  const commitChange = useCallback(
    (next: string, selection?: { start: number; end: number }) => {
      setValue(next);
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
    [pushHistory],
  );

  const undo = useCallback(() => {
    if (historyIndexRef.current <= 0) return;
    historyIndexRef.current -= 1;
    const snapshot = historyRef.current[historyIndexRef.current];
    setValue(snapshot);
  }, []);

  const redo = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyIndexRef.current += 1;
    const snapshot = historyRef.current[historyIndexRef.current];
    setValue(snapshot);
  }, []);

  const getSelection = useCallback((): { start: number; end: number } => {
    const ta = textareaRef.current;
    if (!ta) return { start: 0, end: 0 };
    return { start: ta.selectionStart, end: ta.selectionEnd };
  }, []);

  const applyFormat = useCallback(
    (kind: FormatKey) => {
      const { start, end } = getSelection();
      let result: { text: string; selectionStart: number; selectionEnd: number };
      switch (kind) {
        case 'bold':
          result = wrapSelection(value, start, end, '**', '**', 'bold text');
          break;
        case 'italic':
          result = wrapSelection(value, start, end, '*', '*', 'italic text');
          break;
        case 'underline':
          result = wrapSelection(value, start, end, '<u>', '</u>', 'underlined text');
          break;
        case 'strike':
          result = wrapSelection(value, start, end, '~~', '~~', 'strikethrough');
          break;
        case 'code':
          result = wrapSelection(value, start, end, '`', '`', 'code');
          break;
        case 'inlineMath':
          result = wrapSelection(value, start, end, '$', '$', 'E = mc^2');
          break;
        case 'h1':
          result = prependLines(value, start, end, '# ', 'Heading 1');
          break;
        case 'h2':
          result = prependLines(value, start, end, '## ', 'Heading 2');
          break;
        case 'h3':
          result = prependLines(value, start, end, '### ', 'Heading 3');
          break;
        case 'paragraph':
          result = { text: value, selectionStart: start, selectionEnd: end };
          break;
        case 'ul':
          result = prependLines(value, start, end, '- ', 'List item');
          break;
        case 'ol':
          result = prependLines(value, start, end, '', 'List item', true);
          break;
        case 'quote':
          result = prependLines(value, start, end, '> ', 'Quote');
          break;
        case 'hr':
          result = insertBlock(value, start, end, '---');
          break;
        case 'codeBlock':
          result = insertBlock(
            value,
            start,
            end,
            '```ts\n// code here\n```',
          );
          break;
        case 'blockMath':
          result = insertBlock(value, start, end, '$$\n\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}\n$$');
          break;
        case 'table':
          result = insertBlock(
            value,
            start,
            end,
            '| Column A | Column B | Column C |\n| --- | --- | --- |\n| a1 | b1 | c1 |\n| a2 | b2 | c2 |',
          );
          break;
        default:
          return;
      }
      commitChange(result.text, {
        start: result.selectionStart,
        end: result.selectionEnd,
      });
    },
    [commitChange, getSelection, value],
  );

  const openLinkDialog = useCallback(() => {
    const { start, end } = getSelection();
    const selected = value.slice(start, end);
    setLinkText(selected);
    setLinkUrl('');
    setShowLinkDialog(true);
  }, [getSelection, value]);

  const confirmLink = useCallback(() => {
    if (!linkUrl.trim()) {
      setShowLinkDialog(false);
      return;
    }
    const label = linkText.trim() || linkUrl.trim();
    const { start, end } = getSelection();
    const md = `[${label}](${linkUrl.trim()})`;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const next = `${before}${md}${after}`;
    commitChange(next, {
      start: before.length + md.length,
      end: before.length + md.length,
    });
    setShowLinkDialog(false);
  }, [commitChange, getSelection, linkText, linkUrl, value]);

  const openImageDialog = useCallback(() => {
    setImageAlt('');
    setImageUrl('');
    setShowImageDialog(true);
  }, []);

  const confirmImage = useCallback(() => {
    if (!imageUrl.trim()) {
      setShowImageDialog(false);
      return;
    }
    const { start, end } = getSelection();
    const md = `![${imageAlt.trim() || 'image'}](${imageUrl.trim()})`;
    const before = value.slice(0, start);
    const after = value.slice(end);
    commitChange(`${before}${md}${after}`, {
      start: before.length + md.length,
      end: before.length + md.length,
    });
    setShowImageDialog(false);
  }, [commitChange, getSelection, imageAlt, imageUrl, value]);

  const handleEditorContextMenu = useCallback(
    (e: React.MouseEvent<HTMLTextAreaElement>) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      if (start === end) return;
      e.preventDefault();
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        selection: { start, end, text: value.slice(start, end) },
      });
    },
    [value],
  );

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-c272-ctx-menu]')) return;
      closeContextMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeContextMenu();
    };
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
        const res = await fetch('/api/rust/gemini', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', text: finalPrompt }],
            model: DEFAULT_MODEL,
          }),
        });
        const data: { response?: string; error?: string } = await res.json();
        if (!res.ok) {
          throw new Error(data.error || `AI request failed (HTTP ${res.status})`);
        }
        const aiText = (data.response ?? '').trim();
        if (!aiText) {
          throw new Error('AI returned an empty response');
        }
        const before = value.slice(0, selection.start);
        const after = value.slice(selection.end);
        const next = `${before}${aiText}${after}`;
        commitChange(next, {
          start: selection.start,
          end: selection.start + aiText.length,
        });
        setAiDialog(null);
      } catch (err) {
        setAiError(err instanceof Error ? err.message : 'AI request failed');
      } finally {
        setAiLoading(false);
      }
    },
    [commitChange, value],
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
        await navigator.clipboard.writeText(value);
      } else if (textareaRef.current) {
        textareaRef.current.select();
        document.execCommand('copy');
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
    }
  }, [value]);

  const handleDownload = useCallback(
    (ext: 'md' | 'txt') => {
      const safeName = (title || 'step').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 80);
      const blob = new Blob([value], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeName || 'step'}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    [title, value],
  );

  const confirmClose = useCallback(() => {
    const dirty = value !== lastInitialRef.current;
    if (dirty) {
      const ok = window.confirm(t('canvas272Page.discardEdits'));
      if (!ok) return;
    }
    onClose();
  }, [onClose, t, value]);

  useEffect(() => {
    if (!open) return undefined;
    const isMac = isMacPlatform();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        confirmClose();
        return;
      }
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;

      const key = e.key.toLowerCase();
      if (key === 's') {
        e.preventDefault();
        onSave(value);
        return;
      }
      if (key === 'b') {
        e.preventDefault();
        applyFormat('bold');
        return;
      }
      if (key === 'i' && !e.shiftKey) {
        e.preventDefault();
        applyFormat('italic');
        return;
      }
      if (key === 'u') {
        e.preventDefault();
        applyFormat('underline');
        return;
      }
      if (key === 'k') {
        e.preventDefault();
        openLinkDialog();
        return;
      }
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [applyFormat, confirmClose, onSave, open, openLinkDialog, redo, undo, value]);

  const markdownComponents = useMemo(
    () => ({
      a: (props: React.HTMLAttributes<HTMLAnchorElement>) => (
        <a {...props} target="_blank" rel="noreferrer" />
      ),
    }),
    [],
  );

  const stats = useMemo(() => {
    return {
      chars: value.length,
      words: countWords(value),
      lines: value === '' ? 0 : value.split('\n').length,
    };
  }, [value]);

  const dirty = value !== lastInitialRef.current;

  const handleBackdropMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) confirmClose();
  };

  const handleTextAreaKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const { start, end } = getSelection();
      const before = value.slice(0, start);
      const after = value.slice(end);
      const insert = '  ';
      const next = `${before}${insert}${after}`;
      commitChange(next, {
        start: start + insert.length,
        end: start + insert.length,
      });
    }
  };

  if (!open || typeof document === 'undefined') return null;

  const modalClassName = [
    'c272-modal',
    isFullscreen ? 'c272-modal--fullscreen' : '',
    viewMode === 'editor' ? 'c272-modal--editor-only' : '',
    viewMode === 'preview' ? 'c272-modal--preview-only' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return createPortal(
    <div
      className="c272-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('canvas272Page.editOutputAria', { title })}
      onMouseDown={handleBackdropMouseDown}
    >
      <div className={modalClassName} onMouseDown={(e) => e.stopPropagation()}>
        <div className="c272-modal__header">
          <div className="c272-modal__title">
            <span>{title || t('canvas272Page.stepFallback')}</span>
            <span className="c272-modal__sub">{stepLabel}</span>
          </div>
          <div className="c272-modal__spacer" />
          <div className="c272-modal__view-switch" role="group" aria-label={t('canvas272Page.viewModeGroup')}>
            <button
              type="button"
              className={`c272-seg ${viewMode === 'editor' ? 'c272-seg--active' : ''}`}
              aria-pressed={viewMode === 'editor'}
              onClick={() => setViewMode('editor')}
              title={t('canvas272Page.editorOnly')}
            >
              <Type size={14} />
              <span>{t('canvas272Page.editTab')}</span>
            </button>
            <button
              type="button"
              className={`c272-seg ${viewMode === 'split' ? 'c272-seg--active' : ''}`}
              aria-pressed={viewMode === 'split'}
              onClick={() => setViewMode('split')}
              title={t('canvas272Page.splitView')}
            >
              <Columns size={14} />
              <span>{t('canvas272Page.splitTab')}</span>
            </button>
            <button
              type="button"
              className={`c272-seg ${viewMode === 'preview' ? 'c272-seg--active' : ''}`}
              aria-pressed={viewMode === 'preview'}
              onClick={() => setViewMode('preview')}
              title={t('canvas272Page.previewOnly')}
            >
              <Eye size={14} />
              <span>{t('canvas272Page.previewTab')}</span>
            </button>
          </div>
          {onOpenDebug ? (
            <button
              type="button"
              className="c272-icon-btn"
              aria-label={t('answerDebug.openAria')}
              title={t('answerDebug.title')}
              onClick={onOpenDebug}
            >
              <Bug size={16} />
            </button>
          ) : null}
          <button
            type="button"
            className="c272-icon-btn"
            aria-label={isFullscreen ? t('canvas272Page.exitFullscreen') : t('canvas272Page.enterFullscreen')}
            title={isFullscreen ? t('canvas272Page.exitFullscreen') : t('canvas272Page.enterFullscreen')}
            onClick={() => setIsFullscreen((x) => !x)}
          >
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button
            type="button"
            className="c272-modal__close"
            aria-label={t('canvas272Page.closeModal')}
            onClick={confirmClose}
          >
            <XIcon size={18} />
          </button>
        </div>

        <div className="c272-toolbar2" role="toolbar" aria-label={t('canvas272Page.formattingToolbar')}>
          <button className="c272-tb" onClick={undo} title={t('canvas272Page.undoTitle')}>
            <Undo2 size={15} />
          </button>
          <button className="c272-tb" onClick={redo} title={t('canvas272Page.redoTitle')}>
            <Redo2 size={15} />
          </button>
          <span className="c272-tb__sep" />
          <button className="c272-tb" onClick={() => applyFormat('bold')} title={t('canvas272Page.boldTitle')}>
            <Bold size={15} />
          </button>
          <button className="c272-tb" onClick={() => applyFormat('italic')} title={t('canvas272Page.italicTitle')}>
            <Italic size={15} />
          </button>
          <button className="c272-tb" onClick={() => applyFormat('underline')} title={t('canvas272Page.underlineTitle')}>
            <UnderlineIcon size={15} />
          </button>
          <button className="c272-tb" onClick={() => applyFormat('strike')} title={t('canvas272Page.strikeTitle')}>
            <Strikethrough size={15} />
          </button>
          <button className="c272-tb" onClick={() => applyFormat('code')} title={t('canvas272Page.codeTitle')}>
            <Code size={15} />
          </button>
          <span className="c272-tb__sep" />
          <button className="c272-tb" onClick={() => applyFormat('h1')} title={t('canvas272Page.h1Title')}>
            <Hash size={14} />
            <span className="c272-tb__label">1</span>
          </button>
          <button className="c272-tb" onClick={() => applyFormat('h2')} title={t('canvas272Page.h2Title')}>
            <Hash size={14} />
            <span className="c272-tb__label">2</span>
          </button>
          <button className="c272-tb" onClick={() => applyFormat('h3')} title={t('canvas272Page.h3Title')}>
            <Hash size={14} />
            <span className="c272-tb__label">3</span>
          </button>
          <button className="c272-tb" onClick={() => applyFormat('paragraph')} title={t('canvas272Page.paragraphTitle')}>
            <Pilcrow size={15} />
          </button>
          <span className="c272-tb__sep" />
          <button className="c272-tb" onClick={() => applyFormat('ul')} title={t('canvas272Page.ulTitle')}>
            <List size={15} />
          </button>
          <button className="c272-tb" onClick={() => applyFormat('ol')} title={t('canvas272Page.olTitle')}>
            <ListOrdered size={15} />
          </button>
          <button className="c272-tb" onClick={() => applyFormat('quote')} title={t('canvas272Page.quoteTitle')}>
            <Quote size={15} />
          </button>
          <button className="c272-tb" onClick={() => applyFormat('hr')} title={t('canvas272Page.hrTitle')}>
            <Minus size={15} />
          </button>
          <span className="c272-tb__sep" />
          <button className="c272-tb" onClick={() => applyFormat('codeBlock')} title={t('canvas272Page.codeBlockTitle')}>
            <SquareCode size={15} />
          </button>
          <button className="c272-tb" onClick={() => applyFormat('table')} title={t('canvas272Page.tableTitle')}>
            <TableIcon size={15} />
          </button>
          <button className="c272-tb" onClick={openLinkDialog} title={t('canvas272Page.linkTitle')}>
            <LinkIcon size={15} />
          </button>
          <button className="c272-tb" onClick={openImageDialog} title={t('canvas272Page.imageTitle')}>
            <ImageIcon size={15} />
          </button>
          <span className="c272-tb__sep" />
          <button className="c272-tb" onClick={() => applyFormat('inlineMath')} title={t('canvas272Page.inlineMathTitle')}>
            <Sigma size={15} />
          </button>
          <button className="c272-tb" onClick={() => applyFormat('blockMath')} title={t('canvas272Page.blockMathTitle')}>
            <Braces size={15} />
          </button>
          <span className="c272-tb__spacer" />
          <button className="c272-tb" onClick={handleCopy} title={t('canvas272Page.copyMarkdown')}>
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
          <button className="c272-tb" onClick={() => handleDownload('md')} title={t('canvas272Page.downloadMd')}>
            <FileDown size={15} />
          </button>
          <button className="c272-tb" onClick={() => handleDownload('txt')} title={t('canvas272Page.downloadTxt')}>
            <Download size={15} />
          </button>
        </div>

        <div className="c272-modal__body">
          {viewMode !== 'preview' ? (
            <div className="c272-modal__pane c272-modal__pane--editor">
              <div className="c272-modal__pane-title">{t('canvas272Page.markdownSource')}</div>
              <textarea
                ref={textareaRef}
                className="c272-modal__editor"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  const last = historyRef.current[historyIndexRef.current];
                  if (last !== e.target.value) {
                    pushHistory(e.target.value);
                  }
                }}
                onKeyDown={handleTextAreaKeyDown}
                onContextMenu={handleEditorContextMenu}
                placeholder={t('canvas272Page.editorPlaceholder')}
                spellCheck
              />
            </div>
          ) : null}
          {viewMode !== 'editor' ? (
            <div className="c272-modal__pane c272-modal__pane--preview">
              <div className="c272-modal__pane-title">{t('canvas272Page.previewPane')}</div>
              <div className="c272-modal__preview markdown-body">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
                  rehypePlugins={[rehypeRaw, rehypeSanitize, rehypeKatex]}
                  components={markdownComponents}
                >
                  {value || t('canvas272Page.noOutputYet')}
                </ReactMarkdown>
              </div>
            </div>
          ) : null}
        </div>

        <div className="c272-modal__footer">
          <div className="c272-modal__stats">
            <span>
              <strong>{stats.words}</strong> {t('canvas272Page.wordsLabel')}
            </span>
            <span>
              <strong>{stats.chars}</strong> {t('canvas272Page.charsLabel')}
            </span>
            <span>
              <strong>{stats.lines}</strong> {t('canvas272Page.linesLabel')}
            </span>
            {dirty ? <span className="c272-modal__dirty">{t('canvas272Page.unsaved')}</span> : null}
          </div>
          <div className="c272-modal__spacer" />
          <button type="button" className="c272-btn" onClick={confirmClose}>
            {t('canvas272Page.cancel')}
          </button>
          <button
            type="button"
            className="c272-btn c272-btn--primary"
            onClick={() => onSave(value)}
            title={t('canvas272Page.saveLocalTitle')}
          >
            {t('canvas272Page.saveLocal')}
          </button>
        </div>

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
              <button className="c272-btn" onClick={() => setShowLinkDialog(false)}>
                {t('canvas272Page.cancel')}
              </button>
              <button className="c272-btn c272-btn--primary" onClick={confirmLink}>
                {t('canvas272Page.insertBtn')}
              </button>
            </div>
          </div>
        ) : null}

        {contextMenu ? (
          <div
            data-c272-ctx-menu
            className="c272-ctx-menu"
            role="menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <div className="c272-ctx-menu__head">
              <Sparkles size={13} />
              <span>{t('canvas272Page.aiMenuHead')}</span>
            </div>
            <button
              type="button"
              className="c272-ctx-menu__item"
              onClick={() => handleChooseAiAction('grammar')}
            >
              <Wand2 size={14} />
              <div>
                <div className="c272-ctx-menu__title">{t('canvas272Page.grammarTitle')}</div>
                <div className="c272-ctx-menu__sub">{t('canvas272Page.grammarSub')}</div>
              </div>
            </button>
            <button
              type="button"
              className="c272-ctx-menu__item"
              onClick={() => handleChooseAiAction('alternatives')}
            >
              <Wand2 size={14} />
              <div>
                <div className="c272-ctx-menu__title">{t('canvas272Page.alternativesTitle')}</div>
                <div className="c272-ctx-menu__sub">{t('canvas272Page.alternativesSub')}</div>
              </div>
            </button>
            <button
              type="button"
              className="c272-ctx-menu__item"
              onClick={() => handleChooseAiAction('custom')}
            >
              <Wand2 size={14} />
              <div>
                <div className="c272-ctx-menu__title">{t('canvas272Page.customPromptTitle')}</div>
                <div className="c272-ctx-menu__sub">{t('canvas272Page.customPromptSub')}</div>
              </div>
            </button>
          </div>
        ) : null}

        {aiDialog ? (
          <div
            className="c272-ai-dialog-backdrop"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget && !aiLoading) setAiDialog(null);
            }}
          >
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
                        setAiDialog((prev) =>
                          prev ? { ...prev, prompt: e.target.value } : prev,
                        )
                      }
                      placeholder={t('canvas272Page.customPromptPlaceholder')}
                      autoFocus
                      rows={4}
                    />
                  </div>
                ) : null}
                {aiError ? (
                  <div className="c272-ai-dialog__error" role="alert">
                    {aiError}
                  </div>
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
                >
                  {t('canvas272Page.cancel')}
                </button>
                <div className="c272-modal__spacer" />
                <button
                  type="button"
                  className="c272-btn c272-btn--primary"
                  disabled={
                    aiLoading ||
                    (aiDialog.action === 'custom' && !aiDialog.prompt.trim())
                  }
                  onClick={() =>
                    runAiReplace(aiDialog.action, aiDialog.selection, aiDialog.prompt)
                  }
                >
                  {aiLoading ? (
                    <>
                      <Loader2 size={14} className="c272-spin" /> {t('canvas272Page.generating')}
                    </>
                  ) : (
                    <>
                      <Sparkles size={14} /> {t('canvas272Page.sendToAi')}
                    </>
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
              <button className="c272-btn" onClick={() => setShowImageDialog(false)}>
                {t('canvas272Page.cancel')}
              </button>
              <button className="c272-btn c272-btn--primary" onClick={confirmImage}>
                {t('canvas272Page.insertBtn')}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
