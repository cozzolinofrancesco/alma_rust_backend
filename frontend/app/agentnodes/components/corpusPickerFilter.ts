// Pure filter/category helpers for CorpusPickerDropdown, kept free of React/DOM so the
// matching rules can be unit-tested independently of the component.

import type { CorpusPickerItem } from './CorpusPickerDropdown';

// The three mutually-exclusive ownership buckets, mirroring the picker's sort ranks
// (own → project-linked → the rest). An own corpus that is also project-linked counts
// as 'mine'.
export type CorpusCategory = 'mine' | 'project' | 'others';

export function categoryOf(item: CorpusPickerItem): CorpusCategory {
  if (item.isOwn) return 'mine';
  if (item.isProjectLinked) return 'project';
  return 'others';
}

export interface CorpusFilterOptions {
  /** Free-text query; matches corpus name, author display name, or author email. */
  query: string;
  /** Ownership buckets to keep. Empty set = no category restriction (show all). */
  categories: Set<CorpusCategory>;
  /** Owner email to restrict to (case-insensitive). Empty = no author restriction. */
  authorEmail: string;
}

// Apply the category, author, and text filters (AND-combined) to an already-sorted list.
// `displayName` is injected (pass getDisplayNameFromEmail) so this stays pure.
export function filterCorpusItems(
  items: CorpusPickerItem[],
  opts: CorpusFilterOptions,
  displayName: (email: string) => string,
): CorpusPickerItem[] {
  const q = opts.query.trim().toLowerCase();
  const author = opts.authorEmail.trim().toLowerCase();
  const restrictCategory = opts.categories.size > 0;

  return items.filter((item) => {
    if (restrictCategory && !opts.categories.has(categoryOf(item))) return false;

    if (author) {
      if ((item.ownerEmail || '').toLowerCase() !== author) return false;
    }

    if (q) {
      const email = (item.ownerEmail || '').toLowerCase();
      const name = item.ownerEmail ? displayName(item.ownerEmail).toLowerCase() : '';
      const haystack = `${item.label.toLowerCase()} ${name} ${email}`;
      if (!haystack.includes(q)) return false;
    }

    return true;
  });
}

// Distinct authors present in the list, one entry per email, sorted by display name.
export function distinctAuthors(
  items: CorpusPickerItem[],
  displayName: (email: string) => string,
): Array<{ email: string; name: string }> {
  const byEmail = new Map<string, string>();
  for (const item of items) {
    const email = (item.ownerEmail || '').trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (!byEmail.has(key)) byEmail.set(key, email);
  }
  return Array.from(byEmail.values())
    .map((email) => ({ email, name: displayName(email) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
