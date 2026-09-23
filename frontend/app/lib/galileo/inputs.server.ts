import { MAX_FILE_SIZE_BYTES } from '../fileValidation';
import type { GalileoModelOption } from '../stepModels';
import type { GalileoInput, GalileoProtocol } from './inference.server';
import { GalileoGatewayError } from './errors.server';

const textExtensions = new Set(['txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'html', 'htm', 'tex', 'log', 'srt', 'vtt']);
const imageMimes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export interface GalileoAttachment {
  file: File;
  kind: 'image' | 'document';
}

export async function prepareGalileoInputs(model: GalileoModelOption, input: GalileoInput, protocol: GalileoProtocol, signal?: AbortSignal) {
  const files = input.attachments ?? [];
  if (files.length > 5 || files.some(file => file.size > MAX_FILE_SIZE_BYTES) ||
      files.reduce((total, file) => total + file.size, 0) > MAX_FILE_SIZE_BYTES) throw new GalileoGatewayError('INPUT_TOO_LARGE');
  if (files.length && !model.supportsAttachments) throw new GalileoGatewayError('UNSUPPORTED_INPUT');

  const attachments: GalileoAttachment[] = [];
  const textParts: string[] = [];
  for (const file of files) {
    signal?.throwIfAborted();
    if (!file.size) throw new GalileoGatewayError('UNREADABLE_DOCUMENT');
    const extension = file.name.toLowerCase().split('.').pop() ?? '';
    const imageMime = imageMimes[extension];
    if (imageMime) {
      if (!model.inputModalities.includes('image') || (file.type && file.type !== imageMime)) throw new GalileoGatewayError('UNSUPPORTED_INPUT');
      if (protocol === 'chat' && file.size > 3.75 * 1024 * 1024) throw new GalileoGatewayError('INPUT_TOO_LARGE');
      attachments.push({ file: file.type ? file : new File([file], file.name, { type: imageMime }), kind: 'image' });
      continue;
    }
    if (extension === 'pdf') {
      if (protocol === 'responses' && (model.inputModalities.includes('pdf') || model.inputModalities.includes('image'))) {
        attachments.push({ file: file.type ? file : new File([file], file.name, { type: 'application/pdf' }), kind: 'document' });
        continue;
      }
      const { extractPdfText, looksLikeGarbledPdfText } = await import('../rag/pdfClassifier');
      const text = await extractPdfText(Buffer.from(await file.arrayBuffer()));
      if (!text.trim() || looksLikeGarbledPdfText(text)) throw new GalileoGatewayError('UNREADABLE_DOCUMENT');
      textParts.push(`Attached document ${JSON.stringify(file.name)} (extracted text):\n${text}`);
      continue;
    }
    if (textExtensions.has(extension) && (!file.type || file.type.startsWith('text/') ||
        ['application/json', 'application/xml', 'application/yaml', 'application/x-yaml', 'application/octet-stream'].includes(file.type))) {
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); } catch { throw new GalileoGatewayError('UNREADABLE_DOCUMENT'); }
      if (!text.trim() || text.includes('\0')) throw new GalileoGatewayError('UNREADABLE_DOCUMENT');
      textParts.push(`Attached document ${JSON.stringify(file.name)}:\n${text}`);
      continue;
    }
    throw new GalileoGatewayError('UNSUPPORTED_INPUT');
  }
  signal?.throwIfAborted();
  const messages = input.messages.map(message => ({ ...message }));
  const lastUser = messages.map(message => message.role).lastIndexOf('user');
  if (textParts.length) {
    if (lastUser < 0) throw new GalileoGatewayError('INVALID_STEP_REQUEST');
    messages[lastUser].text += `\n\n${textParts.join('\n\n')}`;
  }
  return { input: { ...input, messages }, attachments };
}