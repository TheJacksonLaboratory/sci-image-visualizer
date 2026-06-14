import { Injectable } from '@angular/core';
import { ProcessingImage } from './processing-image';

/**
 * Converts between various image representations. Bridges image-js, browser
 * canvas/image elements, and the neutral {@link ProcessingImage}. Generic image
 * plumbing — no app/pipeline coupling.
 */
@Injectable({ providedIn: 'root' })
export class ImageConverterService {
  /**
   * Convert an image-js Image instance to ProcessingImage.
   * image-js stores pixel data in a typed array with shape (width*height*channels).
   */
  fromImageJs(image: any): ProcessingImage {
    const width = image.width as number;
    const height = image.height as number;
    const channels = image.channels as number;

    // image-js data is Uint8Array or Uint16Array; normalize to Uint8ClampedArray
    let data: Uint8ClampedArray;
    if (image.bitDepth > 8) {
      // Normalize 16-bit to 8-bit
      const src = image.data as Uint16Array;
      const max = (1 << image.bitDepth) - 1;
      data = new Uint8ClampedArray(src.length);
      for (let i = 0; i < src.length; i++) {
        data[i] = Math.round((src[i] / max) * 255);
      }
    } else {
      data = new Uint8ClampedArray(image.data);
    }

    return new ProcessingImage(width, height, channels, data);
  }

  /** Convert from an HTMLCanvasElement. */
  fromCanvas(canvas: HTMLCanvasElement): ProcessingImage {
    const ctx = canvas.getContext('2d')!;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return ProcessingImage.fromImageData(imageData);
  }

  /** Convert from an HTMLImageElement. */
  fromHtmlImage(img: HTMLImageElement): ProcessingImage {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    return this.fromCanvas(canvas);
  }

  /** Convert ProcessingImage to a 2D array suitable for Plotly heatmap (grayscale). */
  toPlotlyHeatmapZ(image: ProcessingImage): number[][] {
    const z: number[][] = [];
    for (let y = 0; y < image.height; y++) {
      const row: number[] = [];
      for (let x = 0; x < image.width; x++) {
        const idx = (y * image.width + x) * image.channels;
        row.push(image.data[idx]);
      }
      z.push(row);
    }
    return z;
  }

  /** Convert ProcessingImage to Plotly RGB arrays [r[][], g[][], b[][]]. */
  toPlotlyRgbArrays(image: ProcessingImage): { r: number[][]; g: number[][]; b: number[][] } {
    const r: number[][] = [];
    const g: number[][] = [];
    const b: number[][] = [];
    for (let y = 0; y < image.height; y++) {
      const rRow: number[] = [];
      const gRow: number[] = [];
      const bRow: number[] = [];
      for (let x = 0; x < image.width; x++) {
        const idx = (y * image.width + x) * image.channels;
        rRow.push(image.data[idx]);
        gRow.push(image.data[idx + 1]);
        bRow.push(image.data[idx + 2]);
      }
      r.push(rRow);
      g.push(gRow);
      b.push(bRow);
    }
    return { r, g, b };
  }
}
