'use client';

import { useState } from 'react';
import { getTagColor } from '../../../components/StepReferenceSelector';
import type { StructuredDoc } from '../../../canvas-272/lib/exportFormatter';
import { useLanguage } from '../../../contexts/LanguageContext';
import { applyStepOrder } from '../../lib/stepOrder';
import { GripVertical } from 'lucide-react';

interface StructureViewProps {
  doc: StructuredDoc;
  sectionOrder: number[];
  hiddenSections: Set<number>;
  stepOrders: Record<number, string[]>;
  onReorder: (newOrder: number[]) => void;
  onToggleHidden: (sectionIndex: number) => void;
  onReorderSteps: (sectionIndex: number, newStepNumbers: string[]) => void;
}

interface StepDrag {
  sectionIdx: number;
  stepNumber: string;
}

export default function StructureView({
  doc,
  sectionOrder,
  hiddenSections,
  stepOrders,
  onReorder,
  onToggleHidden,
  onReorderSteps,
}: StructureViewProps) {
  const { t, locale } = useLanguage();
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [dragSourceOrderIdx, setDragSourceOrderIdx] = useState<number | null>(null);
  const [stepDrag, setStepDrag] = useState<StepDrag | null>(null);
  const [stepDragOver, setStepDragOver] = useState<StepDrag | null>(null);

  const totalSteps = sectionOrder
    .filter((i) => !hiddenSections.has(i))
    .reduce((n, i) => n + doc.sections[i].steps.length, 0);

  const totalWords = sectionOrder
    .filter((i) => !hiddenSections.has(i))
    .reduce(
      (n, i) =>
        n +
        doc.sections[i].steps.reduce(
          (m, st) => m + st.output.trim().split(/\s+/).filter(Boolean).length,
          0,
        ),
      0,
    );

  const visibleCount = sectionOrder.filter((i) => !hiddenSections.has(i)).length;

  const sectionUnit =
    doc.sections.length === 1
      ? t('agentnodesPage.structure.sectionSingular')
      : t('agentnodesPage.structure.sectionPlural');

  const sectionsMetaLine =
    locale === 'ja'
      ? t('agentnodesPage.structure.sectionsMeta', { visible: visibleCount, total: doc.sections.length })
      : t('agentnodesPage.structure.sectionsMeta', {
          visible: visibleCount,
          total: doc.sections.length,
          sectionUnit,
        });

  const stepUnit = totalSteps === 1 ? t('agentnodesPage.structure.stepSingular') : t('agentnodesPage.structure.stepPlural');
  const wordUnit = totalWords === 1 ? t('agentnodesPage.structure.wordSingular') : t('agentnodesPage.structure.wordPlural');

  const stepsWordsLine =
    locale === 'ja'
      ? t('agentnodesPage.structure.stepsWordsLine', {
          steps: totalSteps,
          words: totalWords.toLocaleString(),
        })
      : t('agentnodesPage.structure.stepsWordsLine', {
          steps: totalSteps,
          stepUnit,
          words: totalWords.toLocaleString(),
          wordUnit,
        });

  const handleDragStart = (orderIdx: number) => {
    setDragSourceOrderIdx(orderIdx);
  };

  const handleDragOver = (e: React.DragEvent, orderIdx: number) => {
    e.preventDefault();
    setDragOverIdx(orderIdx);
  };

  const handleDrop = (e: React.DragEvent, targetOrderIdx: number) => {
    e.preventDefault();
    if (dragSourceOrderIdx === null || dragSourceOrderIdx === targetOrderIdx) {
      setDragOverIdx(null);
      setDragSourceOrderIdx(null);
      return;
    }
    const newOrder = [...sectionOrder];
    const [moved] = newOrder.splice(dragSourceOrderIdx, 1);
    newOrder.splice(targetOrderIdx, 0, moved);
    onReorder(newOrder);
    setDragOverIdx(null);
    setDragSourceOrderIdx(null);
  };

  const handleDragEnd = () => {
    setDragOverIdx(null);
    setDragSourceOrderIdx(null);
  };

  const resetStepDrag = () => {
    setStepDrag(null);
    setStepDragOver(null);
  };

  const handleStepDragStart = (e: React.DragEvent, sectionIdx: number, stepNumber: string) => {
    e.stopPropagation();
    setStepDrag({ sectionIdx, stepNumber });
  };

  const handleStepDragOver = (e: React.DragEvent, sectionIdx: number, stepNumber: string) => {
    if (!stepDrag || stepDrag.sectionIdx !== sectionIdx) return;
    e.preventDefault();
    e.stopPropagation();
    setStepDragOver({ sectionIdx, stepNumber });
  };

  const handleStepDrop = (
    e: React.DragEvent,
    sectionIdx: number,
    targetStepNumber: string,
    currentOrder: string[],
  ) => {
    e.stopPropagation();
    if (!stepDrag || stepDrag.sectionIdx !== sectionIdx || stepDrag.stepNumber === targetStepNumber) {
      resetStepDrag();
      return;
    }
    e.preventDefault();
    const from = currentOrder.indexOf(stepDrag.stepNumber);
    const to = currentOrder.indexOf(targetStepNumber);
    if (from === -1 || to === -1 || from === to) {
      resetStepDrag();
      return;
    }
    const next = [...currentOrder];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onReorderSteps(sectionIdx, next);
    resetStepDrag();
  };

  const handleStepDragEnd = (e: React.DragEvent) => {
    e.stopPropagation();
    resetStepDrag();
  };

  return (
    <div className="an-wizard-structure">
      <div className="an-wizard-structure__meta">
        <span>{sectionsMetaLine}</span>
        <span>·</span>
        <span>{stepsWordsLine}</span>
        <span className="an-wizard-structure__meta-hint">{t('agentnodesPage.structure.dragHint')}</span>
      </div>

      <div className="an-wizard-structure__flow">
        {sectionOrder.map((sectionIdx, orderIdx) => {
          const section = doc.sections[sectionIdx];
          const heading = section.heading ?? t('agentnodesPage.common.prelude');
          const colorKey =
            section.heading &&
            ((typeof section.tag === 'string' && section.tag.trim()) || section.heading);
          const tc = colorKey ? getTagColor(colorKey) : null;
          const isHidden = hiddenSections.has(sectionIdx);
          const isDragOver = dragOverIdx === orderIdx;
          const isDragging = dragSourceOrderIdx === orderIdx;

          const orderedSteps = applyStepOrder(section.steps, stepOrders[sectionIdx]);
          const currentStepOrder = orderedSteps.map((s) => s.number);

          const cardStepLabel =
            section.steps.length === 1
              ? t('agentnodesPage.structure.cardStepOne')
              : t('agentnodesPage.structure.cardStepMany', { count: section.steps.length });

          return (
            <div
              key={sectionIdx}
              className="an-wizard-structure__flow-item"
              draggable
              onDragStart={() => handleDragStart(orderIdx)}
              onDragOver={(e) => handleDragOver(e, orderIdx)}
              onDrop={(e) => handleDrop(e, orderIdx)}
              onDragEnd={handleDragEnd}
            >
              <div
                className={[
                  'an-wizard-structure__card',
                  isHidden ? 'an-wizard-structure__card--hidden' : '',
                  isDragOver ? 'an-wizard-structure__card--drag-over' : '',
                  isDragging ? 'an-wizard-structure__card--dragging' : '',
                ].filter(Boolean).join(' ')}
                style={
                  tc && !isHidden
                    ? { borderTopColor: tc.border, background: tc.bg }
                    : undefined
                }
              >
                <div className="an-wizard-structure__card-header">
                  <span
                    className="an-wizard-structure__drag-handle"
                    aria-hidden
                    title={t('agentnodesPage.structure.dragHandleTitle')}
                  >
                    <GripVertical size={14} />
                  </span>
                  <div
                    className="an-wizard-structure__card-heading"
                    style={tc && !isHidden ? { color: tc.text } : undefined}
                  >
                    {heading}
                  </div>
                  <button
                    type="button"
                    className="an-wizard-structure__toggle-btn"
                    title={isHidden ? t('agentnodesPage.structure.includeExport') : t('agentnodesPage.structure.excludeExport')}
                    aria-label={
                      isHidden
                        ? t('agentnodesPage.structure.includeAria', { heading })
                        : t('agentnodesPage.structure.excludeAria', { heading })
                    }
                    onClick={() => onToggleHidden(sectionIdx)}
                  >
                    {isHidden ? '◎' : '◉'}
                  </button>
                </div>

                <div className="an-wizard-structure__card-count">{cardStepLabel}</div>

                {!isHidden && (
                  <ul className="an-wizard-structure__card-steps">
                    {orderedSteps.map((step) => {
                      const isStepDragging =
                        stepDrag?.sectionIdx === sectionIdx && stepDrag.stepNumber === step.number;
                      const isStepDragOver =
                        stepDragOver?.sectionIdx === sectionIdx &&
                        stepDragOver.stepNumber === step.number;
                      return (
                        <li
                          key={step.number}
                          className={[
                            'an-wizard-structure__card-step',
                            isStepDragging ? 'an-wizard-structure__card-step--dragging' : '',
                            isStepDragOver ? 'an-wizard-structure__card-step--drag-over' : '',
                          ].filter(Boolean).join(' ')}
                          title={step.name}
                          draggable
                          onDragStart={(e) => handleStepDragStart(e, sectionIdx, step.number)}
                          onDragOver={(e) => handleStepDragOver(e, sectionIdx, step.number)}
                          onDrop={(e) => handleStepDrop(e, sectionIdx, step.number, currentStepOrder)}
                          onDragEnd={handleStepDragEnd}
                        >
                          <span className="an-wizard-structure__card-step-handle" aria-hidden>
                            <GripVertical size={16} />
                          </span>
                          <span className="an-wizard-structure__card-step-name">
                            {step.name.length > 40 ? `${step.name.slice(0, 38)}…` : step.name}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {orderIdx < sectionOrder.length - 1 && (
                <span className="an-wizard-structure__arrow" aria-hidden>→</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
