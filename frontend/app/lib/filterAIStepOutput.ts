
const NEXT_SECTION_LOOKAHEAD = '(?=\\n#{1,6}\\s|\\n\\*\\*\\*\\s*$|$)';

const UNWANTED_SECTION_TITLES = [
  'Bias Check',
  'References',
  'Reference list',
  'Reference List',
  'Bibliography',
  'Works cited',
  'Work cited',
  'Sources',
  'Did I understand the task',
  'Task understanding',
  'Understanding the task',
  'Restate Bug',
  'Clarify Details',
  'Analyze Affected Code',
  'Map the file',
  'Create a Class Diagram',
  'Create a State Diagram',
  'Create a sequence Diagram',
  'Diagnose Root Cause',
  'Propose Three Fix Options',
  'Assess Error-Risk',
  'Pick One solution',
  'introspection step',
  'Critic the proposed solutions',
  'Critique the proposed solutions',
  'Green Light & Implement Fix',
  'How can I help you',
  'What would you like',
  'Is there anything else',
  'Checklist',
  'Self-check',
  'Verification',
] as const;

const CHECKLIST_LINE_PATTERNS: RegExp[] = [
  /^\[[ x]\]\s*A Bias Check section.*$/gim,
  /^\[[ x]\]\s*Harvard-style references\.?$/gim,
  /^\[[ x]\]\s*An explicit answer to:.*$/gim,
  /^\[[ x]\]\s*Each output must check all:\s*$/gim,
  /^\[[ x]\]\s*Logic:\s*.*$/gim,
  /^\[[ x]\]\s*Bias:\s*.*$/gim,
  /^\[[ x]\]\s*Resist sycophancy:.*$/gim,
];

const CLOSING_PROMPT_PATTERNS: RegExp[] = [
  /^\*\*How can I help you[^*]*\*\*\s*$/gim,
  /^\*\*What would you like[^*]*\*\*\s*$/gim,
  /^\*\*Is there anything else[^*]*\*\*\s*$/gim,
  /^How can I help you[^?]*\?\s*$/gim,
  /^What would you like[^?]*\?\s*$/gim,
  /^Is there anything else[^?]*\?\s*$/gim,
  /^\*{0,2}Did I understand the task\??\*{0,2}\s*$/gim,
  /^Did I understand the task\??\s*$/gim,
  /^\*{0,2}(?:Yes|Y), I (?:understood|have understood) the task\.?\*{0,2}\s*$/gim,
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripTrailingCitationListBlock(text: string): string {
  const lines = text.split('\n');
  let i = lines.length - 1;
  while (i >= 0 && lines[i].trim() === '') i -= 1;
  if (i < 0) return text;

  const citationLine = (line: string): boolean => {
    const t = line.trim();
    if (!t) return false;
    if (/^\[[\d,\s–-]+\]\s+\S/.test(t)) return true;
    if (/^\d+\.\s+\S.+\(\d{4}\)/.test(t)) return true;
    if (/^[A-Z][a-z]+, [A-Z]\. .+\(\d{4}\)/.test(t)) return true;
    if (/^[-*]\s+\S.+\(\d{4}\)/.test(t)) return true;
    return false;
  };

  let count = 0;
  while (i >= 0) {
    const t = lines[i].trim();
    if (t === '') {
      i -= 1;
      continue;
    }
    if (!citationLine(lines[i])) break;
    count += 1;
    i -= 1;
  }

  if (count >= 3) {
    const cut = i + 1;
    return lines.slice(0, cut).join('\n').replace(/\n{3,}$/, '\n\n').trimEnd();
  }
  return text;
}

export function filterAIResponseSections(text: string): string {
  if (text == null) return '';
  if (!text.length) return text;

  let filtered = text;

  for (const title of UNWANTED_SECTION_TITLES) {
    const esc = escapeRegExp(title);
    const patterns = [
      new RegExp(
        `###?\\s*\\*\\*${esc}[^\\n]*\\*\\*[^\\n]*\\n[\\s\\S]*?${NEXT_SECTION_LOOKAHEAD}`,
        'gi'
      ),
      new RegExp(
        `###?\\s*${esc}[^\\n]*\\n[\\s\\S]*?${NEXT_SECTION_LOOKAHEAD}`,
        'gi'
      ),
      new RegExp(`^\\*\\*${esc}[^\\n]*\\*\\*\\s*$`, 'gim'),
      new RegExp(
        `^\\*\\*${esc}[^\\n]*\\*\\*\\s*\\n[\\s\\S]*?${NEXT_SECTION_LOOKAHEAD}`,
        'gim'
      ),
    ];
    for (const p of patterns) {
      filtered = filtered.replace(p, '');
    }
  }

  for (const p of CHECKLIST_LINE_PATTERNS) {
    filtered = filtered.replace(p, '');
  }

  filtered = filtered.replace(
    /(?:^|\n)\s*Each output must check all:\s*\n(?:\s*\[[ x]\][^\n]*\n)+/gim,
    '\n'
  );

  for (const p of CLOSING_PROMPT_PATTERNS) {
    filtered = filtered.replace(p, '');
  }

  filtered = filtered.replace(/^- \[[ x]\].*$/gm, '');
  filtered = filtered.replace(/^\*\*\*\s*$/gm, '');
  filtered = filtered.replace(/^---+$/gm, '');
  filtered = filtered.replace(/\n{4,}/g, '\n\n\n');

  filtered = stripTrailingCitationListBlock(filtered.trim());

  return filtered.trim();
}
