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

  /**
   * Convert to browser-native ImageData (RGBA). Gray (1), gray+alpha (2) and
   * RGB (3) are expanded; other channel counts throw.
   */
  toImageData(): ImageData {
    if (this.channels === 4) {
      return new ImageData(this.data, this.width, this.height);
    }
    const c = this.channels;
    if (c < 1 || c > 3) {
      throw new Error(`ProcessingImage: cannot convert ${c} channels to RGBA (expected 1–4).`);
    }
    const rgba = new Uint8ClampedArray(this.width * this.height * 4);
    for (let i = 0; i < this.width * this.height; i++) {
      const src = i * c;
      const dst = i * 4;
      if (c === 3) {
        rgba[dst] = this.data[src];
        rgba[dst + 1] = this.data[src + 1];
        rgba[dst + 2] = this.data[src + 2];
      } else {
        rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = this.data[src];
      }
      rgba[dst + 3] = c === 2 ? this.data[src + 1] : 255;
    }
    return new ImageData(rgba, this.width, this.height);
  }

  /** Convert to Blob for saving/downloading. Rejects when the browser can't encode it. */
  async toBlob(mime: string = 'image/png'): Promise<Blob> {
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('ProcessingImage: no 2D canvas context available.');
    ctx.putImageData(this.toImageData(), 0, 0);
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error(`ProcessingImage: the browser could not encode the image as ${mime}.`));
      }, mime);
    });
  }
}
