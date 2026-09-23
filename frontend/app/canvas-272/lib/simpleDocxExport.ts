
import { Document, Packer, Paragraph, TextRun } from 'docx';

import type { StructuredDoc } from './exportFormatter';
import { isKnownEmptyLlmPlaceholderOnlyBody, prepareStructuredDocForExport } from './exportFormatter';

export async function structuredDocToSimpleDocxBuffer(doc: StructuredDoc): Promise<Buffer> {
  const prepared = prepareStructuredDocForExport(doc);
  const children: Paragraph[] = [];

  for (const section of prepared.sections) {
    for (const step of section.steps) {
      const output = step.output.trim();
      if (!output || isKnownEmptyLlmPlaceholderOnlyBody(step.output)) {
        continue;
      }
      for (const line of output.split('\n')) {
        children.push(
          new Paragraph({
            children: [new TextRun(line.length > 0 ? line : ' ')],
          }),
        );
      }
    }
  }

  const file = new Document({
    sections: [{ children }],
  });

  const out = await Packer.toBuffer(file);
  return Buffer.from(out);
}
