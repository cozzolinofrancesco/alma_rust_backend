import { z } from 'zod';

export const SKILL_COLORS = {
  blue: '#2563eb',
  teal: '#0f766e',
  green: '#15803d',
  cyan: '#0e7490',
  red: '#b91c1c',
  rose: '#be123c',
  pink: '#be185d',
  violet: '#7e22ce',
  amber: '#a16207',
  orange: '#c2410c',
  indigo: '#4338ca',
  graphite: '#475569',
} as const;

export const SKILL_ICON_GROUPS = {
  research: ['microscope', 'flask-conical', 'flask-round', 'test-tube', 'test-tubes', 'atom', 'dna', 'brain', 'brain-circuit', 'telescope', 'orbit', 'magnet'],
  writing: ['pen', 'pencil', 'pen-tool', 'notebook', 'notebook-pen', 'book-open', 'book-marked', 'book-text', 'quote', 'highlighter', 'text-cursor-input', 'spell-check'],
  data: ['database', 'database-backup', 'table', 'table-properties', 'chart-bar', 'chart-line', 'chart-pie', 'chart-scatter', 'chart-area', 'chart-column', 'funnel', 'rows-3'],
  code: ['code', 'code-xml', 'terminal', 'braces', 'brackets', 'binary', 'bug', 'git-branch', 'git-merge', 'git-pull-request', 'cpu', 'webhook'],
  communication: ['message-circle', 'message-square', 'messages-square', 'mail', 'mail-open', 'send', 'phone', 'video', 'mic', 'megaphone', 'languages', 'speech'],
  planning: ['calendar', 'calendar-days', 'calendar-check', 'clock', 'timer', 'alarm-clock', 'list-todo', 'list-checks', 'target', 'flag', 'milestone', 'kanban'],
  documents: ['file', 'file-text', 'file-check', 'file-search', 'file-code', 'file-image', 'files', 'folder', 'folder-open', 'folder-check', 'archive', 'clipboard'],
  quality: ['check', 'check-check', 'circle-check', 'shield', 'shield-check', 'shield-alert', 'badge-check', 'scan', 'scan-line', 'search-check', 'scale', 'fingerprint'],
  mathematics: ['calculator', 'sigma', 'pi', 'percent', 'divide', 'plus', 'minus', 'equal', 'radical', 'ruler', 'triangle', 'compass'],
  tools: ['wrench', 'hammer', 'settings', 'sliders-horizontal', 'workflow', 'network', 'layers', 'lightbulb', 'wand-sparkles', 'sparkles', 'rocket', 'puzzle'],
  people: ['user', 'users', 'user-check', 'contact', 'handshake', 'presentation', 'graduation-cap', 'briefcase', 'building', 'landmark', 'globe', 'map'],
  media: ['image', 'images', 'camera', 'film', 'clapperboard', 'music', 'headphones', 'palette', 'paintbrush', 'shapes', 'box', 'monitor'],
} as const;

export type SkillColor = keyof typeof SKILL_COLORS;
export type SkillIconCategory = keyof typeof SKILL_ICON_GROUPS;
export type SkillIconId = (typeof SKILL_ICON_GROUPS)[SkillIconCategory][number];

export const SKILL_ICON_CATALOG = Object.entries(SKILL_ICON_GROUPS).flatMap(([category, ids]) =>
  ids.map((id) => ({ id, category: category as SkillIconCategory, label: id.replaceAll('-', ' ') })),
);

const iconIds = new Set<string>(SKILL_ICON_CATALOG.map((entry) => entry.id));
export const isSkillIconId = (value: string): value is SkillIconId => iconIds.has(value);

export const SkillColorSchema = z.custom<SkillColor>(
  (value) => typeof value === 'string' && Object.prototype.hasOwnProperty.call(SKILL_COLORS, value),
  'Choose a skill color',
);

export const SkillIconSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lucide'), id: z.custom<SkillIconId>((value) => typeof value === 'string' && isSkillIconId(value), 'Choose a skill icon') }).strict(),
  z.object({ kind: z.literal('legacy'), value: z.string().min(1).max(16) }).strict(),
]);

export const SkillAppearanceSchema = z.object({
  color: SkillColorSchema,
  icon: SkillIconSchema,
}).strict();

export type SkillAppearance = z.infer<typeof SkillAppearanceSchema>;

export const filterSkillIcons = (query: string, category?: SkillIconCategory) => {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return SKILL_ICON_CATALOG.filter((entry) =>
    (!category || entry.category === category) &&
    terms.every((term) => `${entry.id} ${entry.category} ${entry.label}`.includes(term)),
  );
};