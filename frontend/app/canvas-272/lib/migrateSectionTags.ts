
import type { Canvas272Layer } from './types';
import { extractActiveSortedLayers, isSectionHeaderName } from './sections';

export function migrateSectionNamesToTags(layers: Canvas272Layer[]): Canvas272Layer[] {
  const sorted = extractActiveSortedLayers(layers);
  const hasAnyTag = sorted.some((l) => typeof l.tag === 'string' && l.tag.trim().length > 0);
  if (hasAnyTag) return layers;

  let currentSyntheticTag: string | null = null;
  const tagByLayerId = new Map<string, string>();

  for (const layer of sorted) {
    if (isSectionHeaderName(layer.name)) {
      currentSyntheticTag = `__sec-${layer.id}`;
      tagByLayerId.set(layer.id, currentSyntheticTag);
    } else if (currentSyntheticTag !== null) {
      tagByLayerId.set(layer.id, currentSyntheticTag);
    }
  }

  if (tagByLayerId.size === 0) return layers;

  return layers.map((l) => {
    const synTag = tagByLayerId.get(l.id);
    if (!synTag) return l;
    return { ...l, tag: synTag };
  });
}
