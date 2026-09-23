declare module 'gifenc' {
  export interface GifPalette {
    [key: string]: unknown;
  }

  export interface GIFEncoderInstance {
    writeFrame(
      indexed: Uint8Array,
      width: number,
      height: number,
      options: { palette: GifPalette; delay: number },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  }

  export function GIFEncoder(): GIFEncoderInstance;
  export function quantize(
    data: Uint8ClampedArray | Uint8Array,
    maxColors: number,
  ): GifPalette;
  export function applyPalette(
    data: Uint8ClampedArray | Uint8Array,
    palette: GifPalette,
  ): Uint8Array;
}
