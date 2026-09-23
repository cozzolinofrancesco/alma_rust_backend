import type { StructuredDocStep } from '../../canvas-272/lib/exportFormatter';

/**
 * Reorder a section's steps to match `order` (a list of step `number`s).
 * Steps whose number is absent from `order` keep their original relative order
 * and are appended after the explicitly ordered ones. Unknown numbers in
 * `order` are ignored. Returns the original array when `order` is empty.
 */
export function applyStepOrder(
  steps: StructuredDocStep[],
  order: string[] | undefined,
): StructuredDocStep[] {
  if (!order || order.length === 0) return steps;
  const byNumber = new Map(steps.map((s) => [s.number, s]));
  const used = new Set<string>();
  const ordered: StructuredDocStep[] = [];
  for (const num of order) {
    const step = byNumber.get(num);
    if (step && !used.has(num)) {
      ordered.push(step);
      used.add(num);
    }
  }
  for (const step of steps) {
    if (!used.has(step.number)) ordered.push(step);
  }
  return ordered;
}
