import type { InspectionBox } from './types';

type DisplayBox = Pick<InspectionBox, 'x' | 'y' | 'w' | 'h' | 'origin'>;

function isOverlayRed(pixels: Uint8ClampedArray, at: number): boolean {
  return pixels[at] === 255 && pixels[at + 1] === 32 && pixels[at + 2] === 32 && pixels[at + 3] === 255;
}

/**
 * Produces a review-only background for a paired FPGA display screenshot.
 * Only the exact red marker pixels on known device rectangle boundaries are
 * interpolated. This does not recover the sensor image hidden by those pixels.
 * The source screenshot and every unmarked pixel remain unchanged.
 */
export function clearDisplayOverlay(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  boxes: readonly DisplayBox[],
): Uint8ClampedArray {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 1 || width % 2 ||
      width * height > 8_000_000 || pixels.length !== width * height * 4) {
    throw new Error('检测截图像素尺寸不正确');
  }
  const result = new Uint8ClampedArray(pixels);
  const half = width / 2;
  const marked = new Uint8Array(width * height);
  const mark = (x: number, y: number) => {
    if (x >= 0 && x < width && y >= 0 && y < height && isOverlayRed(pixels, (y * width + x) * 4)) {
      marked[y * width + x] = 1;
    }
  };
  for (const box of boxes) {
    if (box.origin !== 'fpga' || ![box.x, box.y, box.w, box.h].every(Number.isFinite) ||
        box.x < 0 || box.y < 0 || box.w <= 0 || box.h <= 0 ||
        box.x + box.w > 0.500001 || box.y + box.h > 1.000001) continue;
    // Display-derived boxes use inclusive pixel extents: width = max-min+1.
    const x0 = Math.round(box.x * width);
    const y0 = Math.round(box.y * height);
    const x1 = Math.round((box.x + box.w) * width) - 1;
    const y1 = Math.round((box.y + box.h) * height) - 1;
    if (x0 < 0 || y0 < 0 || x1 >= half || y1 >= height || x1 < x0 || y1 < y0) continue;
    for (const offset of [0, half]) {
      for (let x = x0 + offset; x <= x1 + offset; x++) {
        mark(x, y0);
        mark(x, y1);
      }
      for (let y = y0; y <= y1; y++) {
        mark(x0 + offset, y);
        mark(x1 + offset, y);
      }
    }
  }
  for (let index = 0; index < marked.length; index++) {
    if (!marked[index]) continue;
    const x = index % width, y = Math.floor(index / width);
    let sum = 0, samples = 0;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      for (let distance = 1; distance <= 4; distance++) {
        const xx = x + dx * distance, yy = y + dy * distance;
        // Do not interpolate across the gray/edge view divider.
        if (xx < 0 || xx >= width || yy < 0 || yy >= height || (xx < half) !== (x < half)) break;
        const at = (yy * width + xx) * 4;
        if (pixels[at + 3] === 255 && pixels[at] === pixels[at + 1] && pixels[at] === pixels[at + 2]) {
          sum += pixels[at];
          samples++;
          break;
        }
      }
    }
    // If there is no suitable sample, preserve the marker rather than invent it.
    if (!samples) continue;
    const value = Math.round(sum / samples), at = index * 4;
    result[at] = result[at + 1] = result[at + 2] = value;
  }
  return result;
}
