"use client";
import React, { useEffect, useRef, useState } from "react";

export type Step = { id: string; name: string; tag?: string };

interface TagColors {
  bg: string;
  border: string;
  text: string;
}

const RAINBOW_PALETTE: TagColors[] = [
  { bg: "hsl(0,70%,92%)",   border: "hsl(0,70%,55%)",   text: "hsl(0,60%,38%)"   },
  { bg: "hsl(30,70%,92%)",  border: "hsl(30,65%,52%)",  text: "hsl(30,60%,36%)"  },
  { bg: "hsl(55,68%,91%)",  border: "hsl(55,60%,48%)",  text: "hsl(55,55%,32%)"  },
  { bg: "hsl(120,50%,92%)", border: "hsl(120,45%,48%)", text: "hsl(120,40%,30%)" },
  { bg: "hsl(175,50%,91%)", border: "hsl(175,50%,42%)", text: "hsl(175,45%,28%)" },
  { bg: "hsl(210,60%,92%)", border: "hsl(210,60%,55%)", text: "hsl(210,55%,36%)" },
  { bg: "hsl(240,55%,92%)", border: "hsl(240,55%,60%)", text: "hsl(240,45%,38%)" },
  { bg: "hsl(275,55%,92%)", border: "hsl(275,50%,58%)", text: "hsl(275,45%,36%)" },
  { bg: "hsl(330,65%,92%)", border: "hsl(330,60%,58%)", text: "hsl(330,50%,36%)" },
];

function hashTag(tag: string): number {
  let h = 0;
  for (let i = 0; i < tag.length; i++) {
    h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  }
  return h % RAINBOW_PALETTE.length;
}

export function getTagColor(tag: string): TagColors {
  return RAINBOW_PALETTE[hashTag(tag)];
}

interface Props {
  allSteps: Step[];
  selected: string[];
  onChange: (steps: string[]) => void;
}

function GroupSelectAllCheckbox({
  tag,
  stepIds,
  selected,
  onToggle,
}: {
  tag: string;
  stepIds: string[];
  selected: string[];
  onToggle: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const allSelected =
    stepIds.length > 0 && stepIds.every((id) => selected.includes(id));
  const someSelected = stepIds.some((id) => selected.includes(id));

  useEffect(() => {
    const el = inputRef.current;
    if (el) el.indeterminate = someSelected && !allSelected;
  }, [someSelected, allSelected]);

  return (
    <label
      className="step-ref-group-select-wrap"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="checkbox"
        className="step-ref-group-select"
        checked={allSelected}
        onChange={onToggle}
        aria-label={`Select all outputs in ${tag}`}
      />
    </label>
  );
}

export default function StepReferenceSelector({ allSteps, selected, onChange }: Props) {
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const toggle = (id: string) => {
    if (selected.includes(id)) {
      onChange(selected.filter((s) => s !== id));
    } else {
      onChange([...selected, id]);
    }
  };

  const toggleGroup = (tag: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [tag]: !prev[tag] }));
  };

  const toggleGroupSelection = (steps: Step[]) => {
    const ids = steps.map((s) => s.id);
    const allIn = ids.length > 0 && ids.every((id) => selected.includes(id));
    if (allIn) {
      onChange(selected.filter((s) => !ids.includes(s)));
    } else {
      onChange([...new Set([...selected, ...ids])]);
    }
  };

  if (allSteps.length === 0) return null;

  const untagged: Step[] = [];
  const tagGroups = new Map<string, Step[]>();

  for (const step of allSteps) {
    const t = step.tag?.trim();
    if (t) {
      if (!tagGroups.has(t)) tagGroups.set(t, []);
      tagGroups.get(t)!.push(step);
    } else {
      untagged.push(step);
    }
  }

  return (
    <div className="step-ref-selector">
      <strong>Use output:</strong>

      {}
      {untagged.length > 0 && (
        <div className="step-ref-options">
          {untagged.map((step) => (
            <label key={step.id} className="step-ref-option">
              <input
                type="checkbox"
                checked={selected.includes(step.id)}
                onChange={() => toggle(step.id)}
              />
              {step.name}
            </label>
          ))}
        </div>
      )}

      {}
      {Array.from(tagGroups.entries()).map(([tag, steps]) => {
        const colors = getTagColor(tag);
        const isCollapsed = !!collapsedGroups[tag];
        const groupSelectedCount = steps.filter((s) => selected.includes(s.id)).length;

        return (
          <div
            key={tag}
            className="step-ref-group"
            style={{ borderColor: colors.border, backgroundColor: colors.bg }}
          >
            <div
              className="step-ref-group-header"
              style={{ borderLeftColor: colors.border, color: colors.text }}
              onClick={() => toggleGroup(tag)}
            >
              <GroupSelectAllCheckbox
                tag={tag}
                stepIds={steps.map((s) => s.id)}
                selected={selected}
                onToggle={() => toggleGroupSelection(steps)}
              />
              <span className={`group-chevron ${isCollapsed ? "collapsed" : ""}`}>▾</span>
              <span className="group-tag-name">{tag}</span>
              <span className="group-meta" style={{ color: colors.text }}>
                {steps.length} step{steps.length !== 1 ? "s" : ""}
                {groupSelectedCount > 0 && ` · ${groupSelectedCount} selected`}
              </span>
            </div>

            {!isCollapsed && (
              <div className="step-ref-group-items">
                {steps.map((step) => (
                  <label key={step.id} className="step-ref-option">
                    <input
                      type="checkbox"
                      checked={selected.includes(step.id)}
                      onChange={() => toggle(step.id)}
                    />
                    {step.name}
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
