import { spawn } from 'node:child_process';
import type { StructuredDoc } from './exportFormatter';
import { structuredDocToMarkdown } from './exportFormatter';
import { structuredDocToSimpleDocxBuffer } from './simpleDocxExport';

const PANDOC_FROM =
  'markdown+tex_math_dollars+tex_math_single_backslash+pipe_tables';

interface DocxOptions {
  safe?: boolean;
  signal?: AbortSignal;
  onRenderer?: (renderer: 'pandoc' | 'plain-text') => void;
}

function runPandoc(input: string, from: string, to: string, options: DocxOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'pandoc',
      ['-f', from, '-t', to, '-o', '-', ...(options.safe ? ['--sandbox', '--fail-if-warnings'] : [])],
      { stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal, timeout: 30_000, killSignal: 'SIGKILL' }
    );

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;

    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 32 * 1024 * 1024) {
        child.kill('SIGKILL');
        reject(new Error('Document output exceeds 32MB.'));
      } else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes < 32 * 1024) errChunks.push(chunk);
    });
    child.stdin.on('error', reject);

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          Object.assign(
            new Error(
              'Pandoc is not installed on this server. Install pandoc (e.g. brew install pandoc / apt install pandoc) or use the Docker image that includes it.'
            ),
            { code: 'ENOENT' as const },
          ),
        );
        return;
      }
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
        return;
      }
      const stderr = Buffer.concat(errChunks).toString('utf8').trim();
      reject(new Error(stderr || `pandoc exited with code ${code}`));
    });

    child.stdin.end(input, 'utf8');
  });
}

function validateDocumentResources(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(validateDocumentResources);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const value = node as { t?: unknown; c?: unknown };
  if (value.t === 'Image' || value.t === 'Link') {
    const target = Array.isArray(value.c) ? value.c.at(-1) : undefined;
    const url = Array.isArray(target) ? target[0] : undefined;
    if (typeof url !== 'string') throw new Error('Invalid document resource.');
    const allowed = value.t === 'Image'
      ? /^data:image\/(?:png|jpeg|gif|webp);base64,[a-zA-Z0-9+/]+=*$/.test(url)
      : /^(?:https?:\/\/|mailto:|#)/i.test(url);
    if (!allowed) throw Object.assign(new Error('Document resources must use embedded image data; links must be HTTPS/HTTP, mailto or document anchors.'), { code: 'UNSAFE_DOCUMENT_RESOURCE' });
  }
  if (value.t === 'RawBlock' || value.t === 'RawInline') throw Object.assign(new Error('Raw document markup is not supported in API exports.'), { code: 'UNSAFE_DOCUMENT_RESOURCE' });
  Object.values(node).forEach(validateDocumentResources);
}

function isPandocNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'ENOENT';
}

/**
 * Convert a StructuredDoc to a DOCX buffer via Pandoc (renders LaTeX math and
 * pipe tables faithfully). Falls back to the pure-JS `docx` builder when Pandoc
 * is not installed on the server. Server-only: uses `node:child_process`.
 */
export async function structuredDocToDocxBuffer(doc: StructuredDoc, options: DocxOptions = {}): Promise<Buffer> {
  try {
    const markdown = structuredDocToMarkdown(doc);
    let buffer: Buffer;
    if (options.safe) {
      const parsed = await runPandoc(markdown, `${PANDOC_FROM}-raw_html-raw_tex-raw_attribute-yaml_metadata_block`, 'json', options);
      const document: unknown = JSON.parse(parsed.toString('utf8'));
      validateDocumentResources(document);
      buffer = await runPandoc(JSON.stringify(document), 'json', 'docx', options);
    } else buffer = await runPandoc(markdown, PANDOC_FROM, 'docx', options);
    options.onRenderer?.('pandoc');
    return buffer;
  } catch (err) {
    if (isPandocNotFoundError(err)) {
      options.signal?.throwIfAborted();
      options.onRenderer?.('plain-text');
      return structuredDocToSimpleDocxBuffer(doc);
    }
    throw err;
  }
}
