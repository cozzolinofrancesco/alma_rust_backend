// Client helpers for step image generation (Nano Banana). Central so every run
// path — both step editors and both Run-All flows — behaves identically.
//
// Images are exchanged as raw base64 with /api/generate-image, and stored on a
// layer as `data:<mime>;base64,<data>` URLs (see Canvas272Layer.imageUrls).

export interface InlineImage {
  /** Raw base64, no `data:` prefix. */
  data: string;
  mimeType: string;
}

interface GenerateImageApiResponse {
  images?: Array<{ mimeType: string; data: string }>;
  text?: string;
  model?: string;
  error?: string;
}

/** Read a File as `{ data: base64, mimeType }`, stripping the data-URL prefix. */
export function fileToBase64(file: File): Promise<InlineImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file.'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      const data = comma >= 0 ? result.slice(comma + 1) : result;
      resolve({ data, mimeType: file.type || 'image/png' });
    };
    reader.readAsDataURL(file);
  });
}

/** Parse a `data:<mime>;base64,<data>` URL into inline base64 for image-to-image input. */
export function dataUrlToInlineData(dataUrl: string): InlineImage | null {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(dataUrl.trim());
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

/** Turn API `{ mimeType, data }` images into `data:` URLs for storage/rendering. */
function toDataUrl(image: { mimeType: string; data: string }): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

/**
 * Generate image(s) for a step via /api/generate-image. Returns data URLs plus
 * any text the model emitted. Throws on error (caller shows a toast).
 */
export async function generateStepImages(args: {
  prompt: string;
  model: string;
  base?: InlineImage | null;
}): Promise<{ imageUrls: string[]; text?: string }> {
  const { prompt, model, base } = args;
  const res = await fetch('/api/generate-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      prompt,
      model,
      ...(base ? { imageData: base.data, imageMimeType: base.mimeType } : {}),
    }),
  });

  const data = (await res.json().catch(() => ({}))) as GenerateImageApiResponse;
  if (!res.ok) {
    throw new Error(data.error || `Image generation failed (HTTP ${res.status}).`);
  }

  const imageUrls = (data.images ?? []).map(toDataUrl);
  return { imageUrls, text: data.text };
}
