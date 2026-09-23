
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeSanitize from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import rehypeStringify from 'rehype-stringify';
import { imageDataSanitizeSchema } from './sanitizeSchema';

// rehypeKatex must run AFTER rehypeSanitize: sanitize strips the class/style
// attributes KaTeX emits, so rendering math last keeps its markup intact.
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkBreaks)
  .use(remarkMath)
  .use(remarkRehype, { allowDangerousHtml: false })
  .use(rehypeSanitize, imageDataSanitizeSchema)
  .use(rehypeKatex)
  .use(rehypeStringify);

export function markdownToCleanHtmlSync(markdown: string): string {
  const file = processor.processSync(markdown || '');
  return String(file);
}
