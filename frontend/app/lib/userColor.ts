/**
 * Deterministic per-user colors for corpus attribution in the step editors and
 * corpus manager. There is no user→color mapping stored anywhere; we derive a
 * stable color from the user's email so the same person always renders in the
 * same hue across sessions and surfaces.
 *
 * The palette is brand-adjacent (anchored on #11074A / #4A4453 / #AFA8BA) and
 * chosen for legible dark text on light backgrounds.
 */

export interface UserColor {
  /** Chip / row background. */
  bg: string;
  /** Border color (stronger than bg). */
  border: string;
  /** Text color that stays legible on `bg`. */
  text: string;
}

/** Neutral styling used for the current user's own corpuses (no per-user hue). */
export const OWN_USER_COLOR: UserColor = {
  bg: 'transparent',
  border: '#d8d5e0',
  text: '#2a2340',
};

/** Gold border used to mark a corpus that is linked to the current project. */
export const PROJECT_LINK_BORDER = '#d4af37';

// Distinct, evenly-spread hues; each entry is a soft background + a saturated
// border. Text is a single dark tone that reads on every background here.
const PALETTE: ReadonlyArray<{ bg: string; border: string }> = [
  { bg: '#e8e4f5', border: '#6d5bd0' }, // violet
  { bg: '#ddeefe', border: '#2f6fb0' }, // blue
  { bg: '#dff3ec', border: '#2f9e78' }, // teal-green
  { bg: '#fdeede', border: '#c9772a' }, // amber
  { bg: '#fce1e9', border: '#c53e6a' }, // rose
  { bg: '#e6f0d9', border: '#5f8f2e' }, // olive
  { bg: '#e3ecfb', border: '#3b5bb5' }, // indigo
  { bg: '#f4e4f7', border: '#9b4fb0' }, // magenta
  { bg: '#e0f0f2', border: '#2b8a9a' }, // cyan
  { bg: '#f6e9d6', border: '#a97b2c' }, // ochre
];

const TEXT = '#2a2340';

/** Stable non-negative 32-bit hash of a string (djb2 variant). */
function hashString(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return hash >>> 0;
}

/**
 * Returns a stable color for a user identity (email preferred). Empty/blank
 * input falls back to the first palette entry so callers never get `undefined`.
 */
export function colorForUser(email: string | null | undefined): UserColor {
  const key = (email ?? '').trim().toLowerCase();
  const index = key ? hashString(key) % PALETTE.length : 0;
  const entry = PALETTE[index];
  return { bg: entry.bg, border: entry.border, text: TEXT };
}
