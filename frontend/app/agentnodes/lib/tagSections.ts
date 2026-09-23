
import type { Canvas272Agent } from '../../canvas-272/lib/types';
import type { StructuredDoc, StructuredDocSection, StructuredDocStep } from '../../canvas-272/lib/exportFormatter';
import { extractActiveSortedLayers } from '../../canvas-272/lib/sections';
import { migrateSectionNamesToTags } from '../../canvas-272/lib/migrateSectionTags';
import { getLayerOutputText, appendLayerImagesMarkdown } from '../../canvas-272/lib/layerOutput';
import { formatAgentDisplayName } from '../../canvas-272/lib/agentDisplayName';

export { migrateSectionNamesToTags } from '../../canvas-272/lib/migrateSectionTags';

export function buildStructuredDocByTag(
  agent: Canvas272Agent,
  sidecarOutputs: Record<string, string>,
): StructuredDoc {
  const migratedLayers = migrateSectionNamesToTags(agent.layers);
  const layers = extractActiveSortedLayers(migratedLayers);

  const resolveOutput = (id: string, fallback: string | undefined): string => {
    const edited = sidecarOutputs[id];
    if (typeof edited === 'string' && edited.trim()) return edited;
    return fallback && fallback.trim() ? fallback : '';
  };

  const sections: StructuredDocSection[] = [];
  let prelude: StructuredDocStep[] = [];
  let stepNumber = 1;

  let currentTag: string | null = null;
  let currentHeaderName: string | null = null;
  let currentHeaderNumber: string | null = null;
  let currentSteps: StructuredDocStep[] = [];
  let currentChildIndex = 0;

  const flushSection = () => {
    if (currentTag !== null && currentSteps.length > 0 && currentHeaderName !== null) {
      sections.push({ heading: currentHeaderName, steps: currentSteps, tag: currentTag });
    }
    currentTag = null;
    currentHeaderName = null;
    currentHeaderNumber = null;
    currentSteps = [];
    currentChildIndex = 0;
  };

  for (const layer of layers) {
    const tag = (typeof layer.tag === 'string' ? layer.tag.trim() : '') || null;

    if (tag === null) {
      if (currentTag !== null) flushSection();
      prelude.push({
        number: String(stepNumber),
        name: layer.name,
        output: appendLayerImagesMarkdown(resolveOutput(layer.id, getLayerOutputText(layer)), layer),
      });
      stepNumber += 1;
      continue;
    }

    if (tag !== currentTag) {
      if (prelude.length > 0) {
        sections.push({ heading: null, steps: prelude });
        prelude = [];
      }
      flushSection();

      currentTag = tag;
      currentHeaderName = layer.name;
      currentHeaderNumber = String(stepNumber);
      currentChildIndex = 0;
      currentSteps = [
        {
          number: currentHeaderNumber,
          name: layer.name,
          output: appendLayerImagesMarkdown(resolveOutput(layer.id, getLayerOutputText(layer)), layer),
        },
      ];
      stepNumber += 1;
    } else {
      currentChildIndex += 1;
      currentSteps.push({
        number: `${currentHeaderNumber}.${currentChildIndex}`,
        name: layer.name,
        output: appendLayerImagesMarkdown(resolveOutput(layer.id, getLayerOutputText(layer)), layer),
      });
      stepNumber += 1;
    }
  }

  if (currentTag !== null) flushSection();
  if (prelude.length > 0) {
    sections.push({ heading: null, steps: prelude });
  }

  const displayName = formatAgentDisplayName(agent.name);
  return {
    title: displayName,
    agentName: displayName,
    exportedAt: new Date().toISOString(),
    sections,
  };
}
