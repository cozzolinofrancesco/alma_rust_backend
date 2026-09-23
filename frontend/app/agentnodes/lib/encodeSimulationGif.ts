'use client';

const MAX_GIF_WIDTH = 900;

const PLAYBACK_SLOWDOWN = 4.0;

function sanitiseFilename(name: string): string {
  return name.trim().replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, '-').slice(0, 80) || 'simulation';
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function dataUrlToImageData(dataUrl: string): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = img.width > MAX_GIF_WIDTH ? MAX_GIF_WIDTH / img.width : 1;
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('No 2d context')); return; }
      ctx.drawImage(img, 0, 0, w, h);
      resolve(ctx.getImageData(0, 0, w, h));
    };
    img.onerror = () => reject(new Error('Failed to load frame image'));
    img.src = dataUrl;
  });
}

export async function encodeSimulationGif(
  frames: string[],
  frameDelayMs: number,
  agentName: string,
  onProgress?: (progress: number) => void,
): Promise<void> {
  if (!frames.length) return;

  const { GIFEncoder, quantize, applyPalette } = await import('gifenc');

  const imageDataFrames = await Promise.all(frames.map(dataUrlToImageData));
  const { width, height } = imageDataFrames[0];
  const delayCentiseconds = Math.round((frameDelayMs * PLAYBACK_SLOWDOWN) / 10);

  const encoder = GIFEncoder();

  for (let i = 0; i < imageDataFrames.length; i++) {
    const { data } = imageDataFrames[i];
    const palette = quantize(data, 256);
    const indexed = applyPalette(data, palette);
    encoder.writeFrame(indexed, width, height, {
      palette,
      delay: delayCentiseconds,
    });
    onProgress?.((i + 1) / imageDataFrames.length);
  }

  encoder.finish();
  const bytes = encoder.bytes();
  const blob = new Blob([bytes], { type: 'image/gif' });
  const filename = `${sanitiseFilename(agentName)}-simulation-${Date.now()}.gif`;
  downloadBlob(blob, filename);
}
