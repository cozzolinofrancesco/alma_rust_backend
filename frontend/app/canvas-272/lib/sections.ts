
import type { Canvas272Layer, DiagramModel, DiagramSection } from './types';

const SECTION_PREFIX = /^section\b/i;

export function isSectionHeaderName(name: string | undefined): boolean {
  if (!name) return false;
  return SECTION_PREFIX.test(name.trim());
}

export function extractActiveSortedLayers(layers: Canvas272Layer[]): Canvas272Layer[] {
  return layers
    .filter((layer): layer is Canvas272Layer => Boolean(layer?.id) && Boolean(layer?.name))
    .filter((layer) => layer.isActive !== false)
    .slice()
    .sort((a, b) => {
      const ao = typeof a.order === 'number' ? a.order : 0;
      const bo = typeof b.order === 'number' ? b.order : 0;
      return ao - bo;
    });
}

export function buildDiagramModel(rawLayers: Canvas272Layer[]): DiagramModel {
  const layers = extractActiveSortedLayers(rawLayers);
  const mainLane: DiagramModel['mainLane'] = [];
  const sections: DiagramSection[] = [];

  let globalIndex = 0;
  let i = 0;
  while (i < layers.length) {
    const layer = layers[i];
    if (isSectionHeaderName(layer.name)) {
      const children: Canvas272Layer[] = [];
      let j = i + 1;
      while (j < layers.length && !isSectionHeaderName(layers[j].name)) {
        children.push(layers[j]);
        j += 1;
      }
      const section: DiagramSection = {
        id: `section-${layer.id}`,
        label: layer.name.trim(),
        mainLaneIndex: mainLane.length,
        headerLayer: layer,
        children,
      };
      sections.push(section);
      mainLane.push({ kind: 'section', section, globalIndex });
      globalIndex += 1 + children.length;
      i = j;
    } else {
      mainLane.push({ kind: 'step', layer, globalIndex });
      globalIndex += 1;
      i += 1;
    }
  }

  return { mainLane, sections };
}
