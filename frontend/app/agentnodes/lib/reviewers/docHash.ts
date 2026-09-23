
import type { StructuredDoc } from '../../../canvas-272/lib/exportFormatter';

function canonicalize(doc: Pick<StructuredDoc, 'sections'>): string {
  return JSON.stringify(doc.sections);
}

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function djb2(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = (((h << 5) + h) ^ input.charCodeAt(i)) >>> 0;
  }
  return `djb2-${h.toString(16)}`;
}

export async function computeDocHash(doc: Pick<StructuredDoc, 'sections'>): Promise<string> {
  const canonical = canonicalize(doc);
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      return await sha256Hex(canonical);
    }
  } catch {
  }
  return djb2(canonical);
}

export function computeDocHashSync(doc: Pick<StructuredDoc, 'sections'>): string {
  return djb2(canonicalize(doc));
}
