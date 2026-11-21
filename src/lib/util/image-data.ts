/**
 * `new ImageData(rgba, width, height)` for pixels in any `Uint8ClampedArray`.
 *
 * `ImageData` only takes pixels in an `ArrayBuffer` (since TypeScript 5.7 the types say
 * so too), while a plain `Uint8ClampedArray` may sit on a `SharedArrayBuffer`. Those are
 * copied; the usual `ArrayBuffer`-backed ones are used as they are.
 */
export function newImageData(rgba: Uint8ClampedArray, width: number, height: number): ImageData {
  const pixels =
    rgba.buffer instanceof ArrayBuffer ? (rgba as Uint8ClampedArray<ArrayBuffer>) : new Uint8ClampedArray(rgba);
  return new ImageData(pixels, width, height);
}
