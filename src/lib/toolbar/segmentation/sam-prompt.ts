import type { CachedImageData } from '../wand/wand-tool.service';
import { frameRegionToRgba } from '../crop/slide-crop';

/**
 * Build an RGBA buffer (the SAM encoder's input image) from a cached image
 * frame: the full-frame case of {@link frameRegionToRgba}. Grayscale frames are
 * replicated across R/G/B; missing pixels become opaque black.
 *
 * The decoder-prompt helpers (`buildDecoderPrompt`, `binarizeMask`,
 * `bestMaskIndex`) live in `sam-onnx-core`, which both inference paths use.
 */
export function frameToRgba(cached: CachedImageData, frameIndex: number): Uint8ClampedArray {
  return frameRegionToRgba(cached, frameIndex, 0, 0, cached.width, cached.height);
}
