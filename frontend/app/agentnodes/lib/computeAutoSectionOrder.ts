
import type { StructuredDoc } from '../../canvas-272/lib/exportFormatter';

const SECTION_HEADING = /^\[\s*SECTION\s*(\d+)\s*\]/i;
const META_HEADING = /^\[\s*META\b/i;

type SectionKind = 0 | 1 | 2 | 3;

function sectionKind(heading: string | null | undefined): SectionKind {
  if (heading == null || heading === '') return 0;
  const t = heading.trim();
  if (SECTION_HEADING.test(t)) return 1;
  if (META_HEADING.test(t)) return 2;
  return 3;
}

function sectionNumber(heading: string | null | undefined): number | null {
  if (heading == null || heading === '') return null;
  const m = SECTION_HEADING.exec(heading.trim());
  if (!m) return null;
  return parseInt(m[1], 10);
}

export function structuredDocHasSectionNumberHeadings(doc: StructuredDoc): boolean {
  return doc.sections.some((s) => {
    const h = s.heading;
    if (h == null || h === '') return false;
    return SECTION_HEADING.test(h.trim());
  });
}

export function computeAutoSectionOrder(doc: StructuredDoc): number[] {
  const n = doc.sections.length;
  const indices = Array.from({ length: n }, (_, i) => i);
  indices.sort((a, b) => {
    const ha = doc.sections[a].heading;
    const hb = doc.sections[b].heading;
    const ka = sectionKind(ha);
    const kb = sectionKind(hb);
    if (ka !== kb) return ka - kb;
    if (ka === 1) {
      const na = sectionNumber(ha) ?? 0;
      const nb = sectionNumber(hb) ?? 0;
      if (na !== nb) return na - nb;
    }
    return a - b;
  });
  return indices;
}
