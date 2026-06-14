/**
 * Unified image container used throughout the processing pipeline.
 * Decouples pipeline logic from any specific library's image format.
 */
export class ProcessingImage {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly data: Uint8ClampedArray;

  /** Create from browser ImageData. */
  static fromImageData(imageData: ImageData): ProcessingImage {
    return new ProcessingImage(imageData.width, imageData.height, 4,
      new Uint8ClampedArray(imageData.data));
  }

  constructor(width: number, height: number, channels: number, data: Uint8ClampedArray) {
    this.width = width;
    this.height = height;
    this.channels = channels;
    this.data = data;
  }

  /** Convert to browser-native ImageData (RGBA). */
  toImageData(): ImageData {
    if (this.channels === 4) {
      return new ImageData(this.data, this.width, this.height);
    }
    // Expand grayscale or RGB to RGBA
    const rgba = new Uint8ClampedArray(this.width * this.height * 4);
    for (let i = 0; i < this.width * this.height; i++) {
      if (this.channels === 1) {
        rgba[i * 4] = this.data[i];
        rgba[i * 4 + 1] = this.data[i];
        rgba[i * 4 + 2] = this.data[i];
      } else if (this.channels === 3) {
        rgba[i * 4] = this.data[i * 3];
        rgba[i * 4 + 1] = this.data[i * 3 + 1];
        rgba[i * 4 + 2] = this.data[i * 3 + 2];
      }
      rgba[i * 4 + 3] = 255;
    }
    return new ImageData(rgba, this.width, this.height);
  }

  /** Convert to Blob for saving/downloading. */
  async toBlob(mime: string = 'image/png'): Promise<Blob> {
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext('2d')!;
    ctx.putImageData(this.toImageData(), 0, 0);
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob!), mime);
    });
  }
}
