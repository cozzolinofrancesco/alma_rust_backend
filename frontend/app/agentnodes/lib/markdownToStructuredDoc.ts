
import {
  parseExportedStepLeaderLine,
  type StructuredDoc,
  type StructuredDocSection,
  type StructuredDocStep,
} from '../../canvas-272/lib/exportFormatter';

interface PartialStep {
  name: string;
  outputLines: string[];
}
interface PartialSection {
  heading: string | null;
  steps: PartialStep[];
}

export function markdownToStructuredDoc(
  markdown: string,
  base: Pick<StructuredDoc, 'title' | 'agentName' | 'exportedAt'>,
): StructuredDoc {
  const rawLines = markdown.split('\n');
  let start = 0;
  while (start < rawLines.length && rawLines[start].trim() === '') {
    start += 1;
  }
  const lines = rawLines.slice(start);

  const legacyFormat = /^###\s+/m.test(markdown);
  const sections: PartialSection[] = [];

  let currentSection: PartialSection | null = null;
  let currentStep: PartialStep | null = null;

  const ensureSection = (heading: string | null) => {
    currentSection = { heading, steps: [] };
    sections.push(currentSection);
    currentStep = null;
  };

  const ensureStep = (name: string) => {
    if (!currentSection) ensureSection(null);
    currentStep = { name, outputLines: [] };
    currentSection!.steps.push(currentStep);
  };

  for (const line of lines) {
    if (legacyFormat) {
      const h2 = /^##\s+(.+?)\s*$/.exec(line);
      const h3 = /^###\s+(.+?)\s*$/.exec(line);
      if (h2) {
        ensureSection(h2[1].trim());
        continue;
      }
      if (h3) {
        ensureStep(h3[1].trim());
        continue;
      }
    } else {
      const h1 = /^#\s+(.+?)\s*$/.exec(line);
      if (h1) {
        ensureSection(h1[1].trim());
        continue;
      }
      const stepFromLeader = parseExportedStepLeaderLine(line);
      if (stepFromLeader !== null) {
        ensureStep(stepFromLeader);
        continue;
      }
    }
    const sectionSnapshot = currentSection as PartialSection | null;
    const stepsLenInSection =
      sectionSnapshot === null ? -1 : sectionSnapshot.steps.length;
    if (!currentStep && line.trim() === '' && stepsLenInSection === 0) {
      continue;
    }
    if (!currentStep) {
      ensureStep(base.agentName || 'Document');
    }
    currentStep!.outputLines.push(line);
  }

  let stepNumber = 0;
  const finalSections: StructuredDocSection[] = [];

  for (const sec of sections) {
    const finalSteps: StructuredDocStep[] = [];
    for (const step of sec.steps) {
      stepNumber += 1;
      finalSteps.push({
        number: String(stepNumber),
        name: step.name,
        output: step.outputLines.join('\n').trim(),
      });
    }
    if (finalSteps.length > 0 || sec.heading) {
      finalSections.push({ heading: sec.heading, steps: finalSteps, tag: null });
    }
  }

  if (finalSections.length === 0) {
    finalSections.push({
      heading: null,
      steps: [
        {
          number: '1',
          name: base.agentName || 'Document',
          output: markdown.trim(),
        },
      ],
      tag: null,
    });
  }

  return {
    title: base.title,
    agentName: base.agentName,
    exportedAt: base.exportedAt,
    sections: finalSections,
  };
}
