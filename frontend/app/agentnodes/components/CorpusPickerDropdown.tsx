'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { colorForUser, OWN_USER_COLOR, PROJECT_LINK_BORDER } from '../../lib/userColor';
import { getDisplayNameFromEmail } from '../../lib/formatName';
import { categoryOf, filterCorpusItems, distinctAuthors, type CorpusCategory } from './corpusPickerFilter';

export interface CorpusPickerItem {
  /** The value stored on the layer (registry id / filesearch- id). */
  id: string;
  /** Human-readable corpus name. */
  label: string;
  /** Email of the person who owns/attached the corpus (for attribution + color). */
  ownerEmail?: string;
  /** True when the corpus belongs to the current user (rendered neutral, sorted first). */
  isOwn: boolean;
  /** True when the corpus is linked to the current project (rendered with a gold border). */
  isProjectLinked: boolean;
}

interface CorpusPickerDropdownProps {
  items: CorpusPickerItem[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  searchable?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  /** Formats "created by {name}"; defaults to English. */
  createdByLabel?: (name: string) => string;
  /** Category-chip + author-filter labels; default to English. */
  filterMineLabel?: string;
  filterProjectLabel?: string;
  filterOthersLabel?: string;
  allAuthorsLabel?: string;
  className?: string;
}

// Sort: own corpuses first, then project-linked, then the rest — each group A→Z.
function sortItems(items: CorpusPickerItem[]): CorpusPickerItem[] {
  const rank = (i: CorpusPickerItem) => (i.isOwn ? 0 : i.isProjectLinked ? 1 : 2);
  return [...items].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return a.label.localeCompare(b.label);
  });
}

export function CorpusPickerDropdown({
  items,
  value,
  onChange,
  disabled = false,
  searchable = false,
  placeholder = 'Select a corpus…',
  searchPlaceholder = 'Search corpora by name…',
  createdByLabel = (name: string) => `by ${name}`,
  filterMineLabel = 'Mine',
  filterProjectLabel = 'Project',
  filterOthersLabel = 'Others',
  allAuthorsLabel = 'All authors',
  className,
}: CorpusPickerDropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeCategories, setActiveCategories] = useState<Set<CorpusCategory>>(new Set());
  const [authorFilter, setAuthorFilter] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const sorted = useMemo(() => sortItems(items), [items]);
  const selected = useMemo(() => items.find((i) => i.id === value) ?? null, [items, value]);

  // Which ownership buckets actually appear in the list (drives whether chips are shown).
  const presentCategories = useMemo(() => {
    const set = new Set<CorpusCategory>();
    for (const i of items) set.add(categoryOf(i));
    return set;
  }, [items]);

  const authors = useMemo(() => distinctAuthors(items, getDisplayNameFromEmail), [items]);

  const toggleCategory = (cat: CorpusCategory) => {
    setActiveCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const filtered = useMemo(
    () =>
      filterCorpusItems(
        sorted,
        {
          query: searchable ? query : '',
          categories: activeCategories,
          authorEmail: authorFilter,
        },
        getDisplayNameFromEmail,
      ),
    [sorted, query, searchable, activeCategories, authorFilter],
  );

  const updatePosition = () => {
    if (rootRef.current) {
      const rect = rootRef.current.getBoundingClientRect();
      setDropdownStyle({
        position: 'fixed',
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
        zIndex: 99999,
        maxHeight: 320,
        overflowY: 'auto',
        background: '#fff',
        border: '1px solid #cfcad9',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
        padding: 6,
      });
    }
  };

  useEffect(() => {
    if (!open) return undefined;
    updatePosition();
    
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        (rootRef.current && rootRef.current.contains(target)) ||
        (dropdownRef.current && dropdownRef.current.contains(target))
      ) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    
    // Add scroll/resize listeners for position updates
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const rowStyle = (item: CorpusPickerItem, isSelected: boolean): React.CSSProperties => {
    const color = item.isOwn ? OWN_USER_COLOR : colorForUser(item.ownerEmail);
    return {
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      padding: '8px 10px',
      cursor: 'pointer',
      background: isSelected ? '#efeafc' : color.bg,
      color: color.text,
      border: item.isProjectLinked
        ? `2px solid ${PROJECT_LINK_BORDER}`
        : `1px solid ${color.border}`,
      borderRadius: 6,
      margin: '3px 0',
    };
  };

  return (
    <div ref={rootRef} className={className} style={{ position: 'relative', width: '100%' }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          width: '100%',
          textAlign: 'left',
          padding: '8px 10px',
          borderRadius: 6,
          border: selected?.isProjectLinked
            ? `2px solid ${PROJECT_LINK_BORDER}`
            : '1px solid #cfcad9',
          background: disabled ? '#f2f1f5' : '#fff',
          color: '#2a2340',
          cursor: disabled ? 'not-allowed' : 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected ? selected.label : placeholder}
          {selected && selected.ownerEmail ? (
            <span style={{ opacity: 0.7, marginLeft: 6, fontSize: '0.85em' }}>
              {createdByLabel(getDisplayNameFromEmail(selected.ownerEmail))}
            </span>
          ) : null}
        </span>
        <span aria-hidden style={{ opacity: 0.6 }}>▾</span>
      </button>

      {open && typeof document !== 'undefined' ? createPortal(
        <div
          ref={dropdownRef}
          role="listbox"
          style={dropdownStyle}
        >
          {searchable ? (
            <input
              type="text"
              autoFocus
              value={query}
              placeholder={searchPlaceholder}
              onChange={(e) => setQuery(e.target.value)}
              style={{
                width: '100%',
                padding: '6px 8px',
                marginBottom: 6,
                borderRadius: 6,
                border: '1px solid #cfcad9',
                boxSizing: 'border-box',
              }}
            />
          ) : null}

          {/* Category chips — shown only when more than one ownership bucket is present. */}
          {searchable && presentCategories.size > 1 ? (
            <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
              {(
                [
                  ['mine', filterMineLabel],
                  ['project', filterProjectLabel],
                  ['others', filterOthersLabel],
                ] as Array<[CorpusCategory, string]>
              )
                .filter(([cat]) => presentCategories.has(cat))
                .map(([cat, label]) => {
                  const active = activeCategories.has(cat);
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => toggleCategory(cat)}
                      aria-pressed={active}
                      style={{
                        padding: '3px 10px',
                        borderRadius: 999,
                        fontSize: '0.8em',
                        cursor: 'pointer',
                        border: active ? '1px solid #6c4bd8' : '1px solid #cfcad9',
                        background: active ? '#6c4bd8' : '#fff',
                        color: active ? '#fff' : '#2a2340',
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
            </div>
          ) : null}

          {/* Author filter — shown only when more than one distinct author is present. */}
          {searchable && authors.length > 1 ? (
            <select
              value={authorFilter}
              onChange={(e) => setAuthorFilter(e.target.value)}
              style={{
                width: '100%',
                padding: '6px 8px',
                marginBottom: 6,
                borderRadius: 6,
                border: '1px solid #cfcad9',
                boxSizing: 'border-box',
                background: '#fff',
                color: '#2a2340',
              }}
            >
              <option value="">{allAuthorsLabel}</option>
              {authors.map((a) => (
                <option key={a.email} value={a.email}>
                  {a.name}
                </option>
              ))}
            </select>
          ) : null}

          <div
            role="option"
            aria-selected={!value}
            onClick={() => {
              onChange('');
              setOpen(false);
            }}
            style={{
              padding: '8px 10px',
              cursor: 'pointer',
              color: '#6c757d',
              borderRadius: 6,
              margin: '3px 0',
            }}
          >
            {placeholder}
          </div>

          {filtered.map((item) => {
            const isSelected = item.id === value;
            return (
              <div
                key={item.id}
                role="option"
                aria-selected={isSelected}
                title={item.id}
                onClick={() => {
                  onChange(item.id);
                  setOpen(false);
                }}
                style={rowStyle(item, isSelected)}
              >
                <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {item.label}
                </span>
                {item.ownerEmail ? (
                  <span style={{ fontSize: '0.8em', opacity: 0.8 }}>
                    {createdByLabel(getDisplayNameFromEmail(item.ownerEmail))}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>,
        document.body
      ) : null}
    </div>
  );
}

export default CorpusPickerDropdown;
