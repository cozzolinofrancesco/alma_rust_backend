'use client';

import { ChevronDown, Download, FileText, Maximize2, Minimize2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLanguage } from '../../../contexts/LanguageContext';
import type { StructuredDoc } from '../../../canvas-272/lib/exportFormatter';
import type { ReviewRun, ReviewerId } from '../../lib/reviewers/types';
import {
  EXPORT_WIZARD_STORAGE_VERSION,
  fingerprintStructuredDoc,
  readExportWizardDraft,
  validateSectionOrder,
  validateStepOrders,
  writeExportWizardDraft,
  type ExportWizardPersisted,
} from '../../lib/exportWizardPersist';
import { applyStepOrder } from '../../lib/stepOrder';
import { exportStructuredDocToGoogleDoc } from '../../../canvas-272/lib/exportGoogleDoc';
import { exportStructuredDocToPdf } from '../../../canvas-272/lib/exportPdf';
import { exportStructuredDocToDocx } from '../../../canvas-272/lib/exportDocx';
import StructureView from './StructureView';
import RenderedView, { type RenderedViewHandle } from './RenderedView';
import SectionOutline from './SectionOutline';
import SectionReviewPanel from './SectionReviewPanel';
import {
  computeAutoSectionOrder,
  structuredDocHasSectionNumberHeadings,
} from '../../lib/computeAutoSectionOrder';

type WizardStep = 'structure' | 'document';
type ExportStatus = 'idle' | 'working';

const DOC_LAYOUT_OUTLINE_PX = 36;
const DOC_LAYOUT_HANDLE_PX = 8;
const DOC_LAYOUT_FIXED_LEFT_PX = DOC_LAYOUT_OUTLINE_PX + DOC_LAYOUT_HANDLE_PX;
const DOC_LAYOUT_MIN_EDITOR_PX = 0;

interface ExportWizardModalProps {
  open: boolean;
  doc: StructuredDoc | null;
  persistId?: string | null;
  latestRun: ReviewRun | null;
  isStale: boolean;
  isRunning: boolean;
  runError: string | null;
  onClose: () => void;
  onRun: (reviewerIds: ReviewerId[], sectionDoc?: StructuredDoc) => void;
  onAcknowledge: (reviewerId: ReviewerId, commentId: string, acked: boolean) => void;
  onJumpToStep?: (stepNumber: string) => void;
  onToast: (msg: string) => void;
  agentVersions?: string[];
  currentAgentVersion?: string;
}

export default function ExportWizardModal({
  open,
  doc,
  persistId = null,
  latestRun,
  isStale,
  isRunning,
  runError,
  onClose,
  onRun,
  onAcknowledge,
  onToast,
  agentVersions,
  currentAgentVersion,
}: ExportWizardModalProps) {
  const { t } = useLanguage();
  const stepTitles = useMemo(
    (): Record<WizardStep, string> => ({
      structure: t('agentnodesPage.exportWizard.stepStructureTitle'),
      document: t('agentnodesPage.exportWizard.stepDocumentTitle'),
    }),
    [t],
  );
  const stepNumbers = useMemo(
    (): Record<WizardStep, string> => ({
      structure: t('agentnodesPage.exportWizard.step1of2'),
      document: t('agentnodesPage.exportWizard.step2of2'),
    }),
    [t],
  );
  const [step, setStep] = useState<WizardStep>('structure');
  const [exportStatus, setExportStatus] = useState<ExportStatus>('idle');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const exportTriggerRef = useRef<HTMLButtonElement>(null);
  const [exportMenuPos, setExportMenuPos] = useState<{ bottom: number; right: number } | null>(null);
  const isBusy = exportStatus === 'working' || isRunning;

  const [sectionOrder, setSectionOrder] = useState<number[]>([]);
  const [hiddenSections, setHiddenSections] = useState<Set<number>>(new Set());
  const [stepOrders, setStepOrders] = useState<Record<number, string[]>>({});

  const handleReorderSteps = useCallback((sectionIndex: number, newStepNumbers: string[]) => {
    setStepOrders((prev) => ({ ...prev, [sectionIndex]: newStepNumbers }));
  }, []);

  const defaultVersionLabel = useMemo(
    () => currentAgentVersion ?? (agentVersions?.[agentVersions.length - 1]) ?? '',
    [currentAgentVersion, agentVersions],
  );
  const [docVersion, setDocVersion] = useState(defaultVersionLabel);

  const docFingerprint = useMemo(() => (doc ? fingerprintStructuredDoc(doc) : ''), [doc]);
  const lastMarkdownRef = useRef<string>('');
  const [markdownSaveVersion, setMarkdownSaveVersion] = useState(0);
  const [documentEditorKey, setDocumentEditorKey] = useState(0);
  const [documentMarkdownSeed, setDocumentMarkdownSeed] = useState<string | undefined>(undefined);

  const [activeSection, setActiveSection] = useState<number | null>(null);
  const [lastAnalysedSection, setLastAnalysedSection] = useState<number | null>(null);
  const [reviewPct, setReviewPct] = useState(32);
  const [layoutWidth, setLayoutWidth] = useState(0);
  const docLayoutRef = useRef<HTMLDivElement>(null);
  const reviewDragRef = useRef(false);
  const renderedViewRef = useRef<RenderedViewHandle>(null);

  const bumpMarkdownSave = useCallback(() => {
    setMarkdownSaveVersion((v) => v + 1);
  }, []);

  const hiddenSectionsSerialized = useMemo(
    () => [...hiddenSections].sort((a, b) => a - b).join(','),
    [hiddenSections],
  );

  const stepOrdersSerialized = useMemo(() => JSON.stringify(stepOrders), [stepOrders]);

  const applyWizardDefaults = useCallback(() => {
    if (!doc) return;
    setStep('structure');
    setSectionOrder(computeAutoSectionOrder(doc));
    setHiddenSections(new Set());
    setStepOrders({});
    setDocVersion(defaultVersionLabel);
    setIsFullscreen(false);
    setActiveSection(null);
    setLastAnalysedSection(null);
    setReviewPct(32);
    setLayoutWidth(0);
    setExportMenuOpen(false);
    lastMarkdownRef.current = '';
    setDocumentMarkdownSeed(undefined);
    setDocumentEditorKey((k) => k + 1);
  }, [doc, defaultVersionLabel]);

  useLayoutEffect(() => {
    if (!open || !doc) return;
    if (!persistId) {
      applyWizardDefaults();
      return;
    }
    const saved = readExportWizardDraft(persistId);
    const orderOk = saved ? validateSectionOrder(saved.sectionOrder, doc.sections.length) : null;
    if (saved && saved.docFingerprint === docFingerprint && orderOk) {
      setStep(saved.step === 'document' ? 'document' : 'structure');
      const autoOrder = computeAutoSectionOrder(doc);
      const useAutoOrder = structuredDocHasSectionNumberHeadings(doc);
      const restoredOrder = useAutoOrder ? autoOrder : orderOk;
      const orderChangedFromSaved =
        useAutoOrder &&
        (orderOk.length !== autoOrder.length || orderOk.some((v, i) => v !== autoOrder[i]));
      setSectionOrder(restoredOrder);
      const hid = new Set(
        (saved.hiddenSectionIndices ?? []).filter(
          (i): i is number => Number.isInteger(i) && i >= 0 && i < doc.sections.length,
        ),
      );
      setHiddenSections(hid);
      setStepOrders(validateStepOrders(saved.stepOrders, doc));
      const versionOk = agentVersions?.includes(saved.docVersion)
        ? saved.docVersion
        : defaultVersionLabel;
      setDocVersion(versionOk);
      setIsFullscreen(Boolean(saved.isFullscreen));
      setReviewPct(
        typeof saved.reviewPct === 'number' && saved.reviewPct >= 0 && saved.reviewPct <= 100
          ? saved.reviewPct
          : 32,
      );
      const visibleCount = restoredOrder.filter((i) => !hid.has(i)).length;
      if (orderChangedFromSaved) {
        setActiveSection(null);
        setLastAnalysedSection(null);
      } else {
        const ac = saved.activeSection;
        setActiveSection(
          typeof ac === 'number' && ac >= 0 && ac < visibleCount && visibleCount > 0 ? ac : null,
        );
        const la = saved.lastAnalysedSection;
        setLastAnalysedSection(
          typeof la === 'number' && la >= 0 && la < visibleCount ? la : null,
        );
      }
      const md = typeof saved.editedMarkdown === 'string' ? saved.editedMarkdown : '';
      lastMarkdownRef.current = md;
      setDocumentMarkdownSeed(md.trim() ? md : undefined);
      setDocumentEditorKey((k) => k + 1);
      setExportMenuOpen(false);
      return;
    }
    applyWizardDefaults();
  }, [open, doc, persistId, docFingerprint, agentVersions, defaultVersionLabel, applyWizardDefaults]);

  const persistDraftToStorage = useCallback(() => {
    if (!persistId || !doc) return;
    const order =
      sectionOrder.length === doc.sections.length
        ? sectionOrder
        : doc.sections.map((_, i) => i);
    const validatedOrder = validateSectionOrder(order, doc.sections.length) ?? doc.sections.map((_, i) => i);
    const markdown =
      step === 'document'
        ? (renderedViewRef.current?.getEditedMarkdown() ?? lastMarkdownRef.current)
        : lastMarkdownRef.current;
    const payload: ExportWizardPersisted = {
      v: EXPORT_WIZARD_STORAGE_VERSION,
      docFingerprint,
      step: step === 'document' ? 'document' : 'structure',
      sectionOrder: validatedOrder,
      hiddenSectionIndices: [...hiddenSections].sort((a, b) => a - b),
      docVersion,
      activeSection,
      lastAnalysedSection,
      reviewPct,
      isFullscreen,
      editedMarkdown: markdown ?? '',
      stepOrders,
    };
    writeExportWizardDraft(persistId, payload);
  }, [
    persistId,
    doc,
    docFingerprint,
    step,
    sectionOrder,
    hiddenSectionsSerialized,
    stepOrdersSerialized,
    docVersion,
    activeSection,
    lastAnalysedSection,
    reviewPct,
    isFullscreen,
    markdownSaveVersion,
  ]);

  useEffect(() => {
    if (!open || !persistId || !doc) return undefined;
    const timeoutId = window.setTimeout(() => persistDraftToStorage(), 420);
    return () => window.clearTimeout(timeoutId);
  }, [open, persistId, doc, persistDraftToStorage]);

  useEffect(() => {
    if (open) return undefined;
    persistDraftToStorage();
    return undefined;
  }, [open, persistDraftToStorage]);

  const reviewWidthPx = useMemo(() => {
    const avail = Math.max(0, layoutWidth - DOC_LAYOUT_FIXED_LEFT_PX);
    const raw = Math.round((reviewPct / 100) * avail);
    const maxReview = Math.max(0, avail - DOC_LAYOUT_MIN_EDITOR_PX);
    return Math.min(raw, maxReview);
  }, [layoutWidth, reviewPct]);

  const startReviewDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    reviewDragRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      if (!reviewDragRef.current) return;
      const layout = docLayoutRef.current;
      if (!layout) return;
      const rect = layout.getBoundingClientRect();
      const outline = layout.firstElementChild;
      const handle = layout.querySelector('.an-review-drag-handle');
      const fixedW =
        (outline?.getBoundingClientRect().width ?? DOC_LAYOUT_OUTLINE_PX) +
        (handle?.getBoundingClientRect().width ?? DOC_LAYOUT_HANDLE_PX);
      const avail = Math.max(1, rect.width - fixedW);
      const fromRight = Math.max(0, rect.right - ev.clientX);
      const pct = Math.min(100, (fromRight / avail) * 100);
      setReviewPct(pct);
    };
    const onUp = () => {
      reviewDragRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const absorbClick = (ev: MouseEvent) => {
        ev.stopPropagation();
        window.removeEventListener('click', absorbClick, true);
      };
      window.addEventListener('click', absorbClick, true);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isBusy) {
        if (isFullscreen) { setIsFullscreen(false); }
        else { onClose(); }
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [open, onClose, isBusy, isFullscreen]);

  useEffect(() => {
    if (!exportMenuOpen) return undefined;
    const handle = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [exportMenuOpen]);

  const visibleDoc = useMemo(() => {
    if (!doc) return null;
    const sections = sectionOrder
      .filter((i) => !hiddenSections.has(i))
      .map((i) => {
        const section = doc.sections[i];
        const ordered = applyStepOrder(section.steps, stepOrders[i]);
        return ordered === section.steps ? section : { ...section, steps: ordered };
      });
    return { ...doc, sections };
  }, [doc, sectionOrder, hiddenSections, stepOrders]);

  useEffect(() => {
    if (!open || step !== 'document' || !visibleDoc) return undefined;
    const el = docLayoutRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      setLayoutWidth(el.getBoundingClientRect().width);
    });
    ro.observe(el);
    setLayoutWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, [open, step, visibleDoc]);

  const sectionCommentCounts = useMemo(() => {
    if (!visibleDoc || !latestRun) return {} as Record<number, number>;
    const counts: Record<number, number> = {};
    let totalMatched = 0;
    visibleDoc.sections.forEach((section, idx) => {
      const stepNums = new Set(section.steps.map((s) => s.number));
      let total = 0;
      for (const report of latestRun.reports) {
        for (const comment of report.comments) {
          if (stepNums.has(comment.stepNumber)) total++;
        }
      }
      if (total > 0) counts[idx] = total;
      totalMatched += total;
    });
    if (totalMatched === 0 && lastAnalysedSection !== null) {
      const totalComments = latestRun.reports.reduce((sum, r) => sum + r.comments.length, 0);
      if (totalComments > 0) counts[lastAnalysedSection] = totalComments;
    }
    return counts;
  }, [visibleDoc, latestRun, lastAnalysedSection]);

  const fileNameBase = useRef('');
  useEffect(() => {
    if (doc) {
      const versionSlug = docVersion.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      fileNameBase.current = `${(doc.title || doc.agentName).replace(/[^a-z0-9-_]+/gi, '_').slice(0, 60) || 'canvas272'}_${versionSlug}-${Date.now()}`;
    }
  }, [doc, docVersion]);

  const withExport = async (fn: () => Promise<void>, successMsg: string, failMsg: string) => {
    if (!visibleDoc) {
      return;
    }
    setExportStatus('working');
    try {
      await fn();
      onToast(successMsg);
    } catch (err) {
      onToast(
        t('agentnodesPage.exportWizard.exportFailDetail', {
          failMsg,
          detail:
            err instanceof Error ? err.message : t('agentnodesPage.exportWizard.unknownError'),
        }),
      );
    } finally {
      setExportStatus('idle');
    }
  };

  const buildExportDoc = (): StructuredDoc => {
    const edited = renderedViewRef.current?.getEditedMarkdown();
    if (edited && edited.trim()) {
      return {
        title: visibleDoc!.title,
        agentName: visibleDoc!.agentName,
        exportedAt: visibleDoc!.exportedAt,
        sections: [
          {
            heading: null,
            tag: null,
            steps: [
              {
                number: '1',
                name: visibleDoc!.agentName || 'Document',
                output: edited.trim(),
              },
            ],
          },
        ],
      };
    }
    return visibleDoc!;
  };

  const handleGoogleDoc = () =>
    void withExport(
      async () => {
        const result = await exportStructuredDocToGoogleDoc(buildExportDoc());
        if (result.webViewLink) window.open(result.webViewLink, '_blank', 'noopener,noreferrer');
      },
      t('agentnodesPage.exportWizard.toastGoogleDocOk'),
      t('agentnodesPage.exportWizard.toastGoogleDocFail'),
    );

  const handlePdf = () =>
    void withExport(
      () => exportStructuredDocToPdf(buildExportDoc(), `${fileNameBase.current}.pdf`),
      t('agentnodesPage.exportWizard.toastPdfOk'),
      t('agentnodesPage.exportWizard.toastPdfFail'),
    );

  const handleDocx = () =>
    void withExport(
      () => exportStructuredDocToDocx(buildExportDoc(), `${fileNameBase.current}.docx`),
      t('agentnodesPage.exportWizard.toastDocxOk'),
      t('agentnodesPage.exportWizard.toastDocxFail'),
    );

  if (!open || !doc) return null;

  const renderFooter = () => {
    if (step === 'structure') {
      return (
        <>
          <button type="button" className="an-wizard-footer__ghost" disabled={isBusy} onClick={onClose}>
            {t('agentnodesPage.common.cancel')}
          </button>
          <div className="an-wizard-footer__spacer" />
          <button
            type="button"
            className="an-wizard-footer__primary"
            disabled={isBusy}
            onClick={() => setStep('document')}
          >
            {t('agentnodesPage.exportWizard.nextPreview')}
          </button>
        </>
      );
    }
    const busy = exportStatus === 'working';
    return (
      <>
        <button
          type="button"
          className="an-wizard-footer__back"
          disabled={isBusy}
          onClick={() => {
            const md = renderedViewRef.current?.getEditedMarkdown();
            if (typeof md === 'string') {
              lastMarkdownRef.current = md;
              setDocumentMarkdownSeed(md.trim() ? md : undefined);
            }
            setDocumentEditorKey((k) => k + 1);
            setStep('structure');
          }}
        >
          {t('agentnodesPage.exportWizard.back')}
        </button>
        <div className="an-wizard-footer__spacer" />
        {agentVersions && agentVersions.length > 0 && (
          <div className="an-wizard-version-row">
            <label className="an-wizard-version-label" htmlFor="an-wizard-version-select">
              {t('agentnodesPage.exportWizard.versionLabel')}
            </label>
            <select
              id="an-wizard-version-select"
              className="an-wizard-version-select"
              value={docVersion}
              onChange={(e) => setDocVersion(e.target.value)}
              disabled={isBusy}
            >
              {agentVersions.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </div>
        )}
        <div className="an-wizard-footer__divider" />
        <div className="an-layout-menu an-layout-menu--upward" ref={exportMenuRef}>
          <button
            ref={exportTriggerRef}
            type="button"
            className={`an-wizard-footer__primary an-layout-menu__trigger an-export-menu__trigger${exportMenuOpen ? ' an-layout-menu__trigger--open' : ''}`}
            disabled={isBusy}
            aria-haspopup="menu"
            aria-expanded={exportMenuOpen}
            onClick={() => {
              const rect = exportTriggerRef.current?.getBoundingClientRect();
              if (rect) {
                setExportMenuPos({
                  bottom: window.innerHeight - rect.top + 6,
                  right: window.innerWidth - rect.right,
                });
              }
              setExportMenuOpen((v) => !v);
            }}
          >
            <Download className="an-export-menu__trigger-icon" size={14} strokeWidth={2} aria-hidden />
            {busy ? t('agentnodesPage.exportWizard.exporting') : t('agentnodesPage.exportWizard.export')}
            <ChevronDown
              className={`an-export-menu__trigger-chevron${exportMenuOpen ? ' an-export-menu__trigger-chevron--open' : ''}`}
              size={14}
              strokeWidth={2}
              aria-hidden
            />
          </button>
          {exportMenuOpen && exportMenuPos && (
            <div
              className="an-layout-menu__panel an-export-menu__panel"
              role="menu"
              style={{
                position: 'fixed',
                bottom: exportMenuPos.bottom,
                right: exportMenuPos.right,
                top: 'auto',
                left: 'auto',
                zIndex: 9999,
              }}
            >
              <button
                type="button"
                role="menuitem"
                className="an-layout-menu__item an-export-menu__item"
                disabled={isBusy}
                onClick={() => { setExportMenuOpen(false); handleGoogleDoc(); }}
              >
                <span className="an-layout-menu__item-icon an-export-menu__glyph" aria-hidden>
                  <FileText size={17} strokeWidth={1.75} />
                </span>
                <span className="an-layout-menu__item-body">
                  <span className="an-layout-menu__item-label">
                    {t('agentnodesPage.exportWizard.menuGoogleDoc')}
                  </span>
                  <span className="an-layout-menu__item-desc">
                    {t('agentnodesPage.exportWizard.menuGoogleDocDesc')}
                  </span>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="an-layout-menu__item an-export-menu__item"
                disabled={isBusy}
                onClick={() => { setExportMenuOpen(false); handlePdf(); }}
              >
                <span className="an-layout-menu__item-icon an-export-menu__glyph" aria-hidden>
                  <FileText size={17} strokeWidth={1.75} />
                </span>
                <span className="an-layout-menu__item-body">
                  <span className="an-layout-menu__item-label">{t('agentnodesPage.exportWizard.menuPdf')}</span>
                  <span className="an-layout-menu__item-desc">
                    {t('agentnodesPage.exportWizard.menuPdfDesc')}
                  </span>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="an-layout-menu__item an-export-menu__item"
                disabled={isBusy}
                onClick={() => { setExportMenuOpen(false); handleDocx(); }}
              >
                <span className="an-layout-menu__item-icon an-export-menu__glyph" aria-hidden>
                  <FileText size={17} strokeWidth={1.75} />
                </span>
                <span className="an-layout-menu__item-body">
                  <span className="an-layout-menu__item-label">{t('agentnodesPage.exportWizard.menuDocx')}</span>
                  <span className="an-layout-menu__item-desc">
                    {t('agentnodesPage.exportWizard.menuDocxDesc')}
                  </span>
                </span>
              </button>
            </div>
          )}
        </div>
      </>
    );
  };

  return (
    <div className="c272-modal-backdrop an-wizard-backdrop">
      <div
        className={`c272-modal an-wizard-modal${isFullscreen ? ' an-wizard-modal--fullscreen' : ''}`}
        role="dialog"
        aria-label={stepTitles[step]}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="c272-modal__header">
          <span className="c272-modal__title">{stepTitles[step]}</span>
          <span className="an-wizard-step-badge">{stepNumbers[step]}</span>
          <div className="c272-modal__spacer" />
          <button
            type="button"
            className="c272-icon-btn"
            aria-label={
              isFullscreen
                ? t('agentnodesPage.exportWizard.exitFullPage')
                : t('agentnodesPage.exportWizard.fullPage')
            }
            title={
              isFullscreen
                ? t('agentnodesPage.exportWizard.exitFullPageEsc')
                : t('agentnodesPage.exportWizard.fullPage')
            }
            onClick={() => setIsFullscreen((x) => !x)}
          >
            {isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button
            type="button"
            className="c272-modal__close"
            onClick={onClose}
            disabled={isBusy}
            aria-label={t('agentnodesPage.common.close')}
          >
            ✕
          </button>
        </div>

        <div className={`an-wizard-modal__body${step === 'document' ? ' an-wizard-modal__body--editor' : ''}`}>
          {step === 'structure' && (
            <StructureView
              doc={doc}
              sectionOrder={sectionOrder}
              hiddenSections={hiddenSections}
              stepOrders={stepOrders}
              onReorder={setSectionOrder}
              onReorderSteps={handleReorderSteps}
              onToggleHidden={(idx) =>
                setHiddenSections((prev) => {
                  const next = new Set(prev);
                  if (next.has(idx)) next.delete(idx);
                  else next.add(idx);
                  return next;
                })
              }
            />
          )}

          {step === 'document' && visibleDoc && (
            <div className="an-wizard-doc-layout" ref={docLayoutRef}>
              <SectionOutline
                sections={visibleDoc.sections}
                activeSection={activeSection}
                onSelect={(idx) => {
                  setActiveSection(idx);
                  renderedViewRef.current?.scrollToSection(
                    visibleDoc.sections[idx].heading,
                  );
                }}
                commentCounts={sectionCommentCounts}
              />
              <RenderedView
                key={documentEditorKey}
                ref={renderedViewRef}
                doc={visibleDoc}
                seedMarkdown={documentMarkdownSeed}
                outlineFocusHeading={
                  activeSection != null
                    ? visibleDoc.sections[activeSection]?.heading ?? null
                    : null
                }
                onMarkdownChange={(md) => {
                  lastMarkdownRef.current = md;
                  bumpMarkdownSave();
                }}
              />
              {}
              <div
                className="an-review-drag-handle"
                title={t('agentnodesPage.exportWizard.resizeHandleTitle')}
                onMouseDown={startReviewDrag}
                role="separator"
                aria-orientation="vertical"
                aria-label={t('agentnodesPage.exportWizard.resizeHandleAria')}
              />
              <SectionReviewPanel
                sections={visibleDoc.sections}
                activeSection={activeSection}
                lastAnalysedSection={lastAnalysedSection}
                doc={visibleDoc}
                latestRun={latestRun}
                isStale={isStale}
                isRunning={isRunning}
                runError={runError}
                onRunSection={(reviewerIds, sectionIdx) => {
                  const sectionOnlyDoc: StructuredDoc = {
                    ...visibleDoc,
                    sections: [visibleDoc.sections[sectionIdx]],
                  };
                  setLastAnalysedSection(sectionIdx);
                  onRun(reviewerIds, sectionOnlyDoc);
                }}
                onAcknowledge={onAcknowledge}
                style={{ flex: `0 0 ${reviewWidthPx}px`, minWidth: 0 }}
              />
            </div>
          )}
        </div>

        <div className="c272-modal__footer an-wizard-footer">
          {renderFooter()}
        </div>
      </div>
    </div>
  );
}
