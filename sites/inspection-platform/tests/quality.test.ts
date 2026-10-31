import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Node 22 runs the source directly; the application bundler uses extensionless imports.
const { analyzeRgbaPixels, QUALITY_THRESHOLDS } = await import(
  pathToFileURL(resolve('app/lib/quality.ts')).href
) as typeof import('../app/lib/quality');

function pixels(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  }
  return data;
}

describe('image quality based on actual RGBA pixels', () => {
  it('flags a fully black exposure as retake without calling it a defect', () => {
    const result = analyzeRgbaPixels(pixels(8, 8, () => [0, 0, 0, 255]), 8, 8);
    assert.equal(result.brightness, 0);
    assert.equal(result.darkRatio, 1);
    assert.equal(result.brightRatio, 0);
    assert.equal(result.verdict, 'retake');
    assert.ok(result.warnings.some(warning => warning.includes('采集质量')));
  });

  it('flags a fully white exposure as retake', () => {
    const result = analyzeRgbaPixels(pixels(8, 8, () => [255, 255, 255, 255]), 8, 8);
    assert.equal(result.brightness, 255);
    assert.equal(result.brightRatio, 1);
    assert.equal(result.verdict, 'retake');
  });

  it('composites transparent pixels on white instead of treating them as dark', () => {
    const result = analyzeRgbaPixels(pixels(8, 8, () => [0, 0, 0, 0]), 8, 8);
    assert.equal(result.brightness, 255);
    assert.equal(result.darkRatio, 0);
  });

  it('treats low texture as review, not an automatic reshoot', () => {
    const result = analyzeRgbaPixels(pixels(8, 8, () => [128, 128, 128, 255]), 8, 8);
    assert.equal(result.sharpness, 0);
    assert.equal(result.verdict, 'review');
    assert.ok(result.warnings.some(warning => warning.includes('平滑表面')));
  });

  it('distinguishes textured detail from an equally exposed flat field', () => {
    const textured = analyzeRgbaPixels(pixels(8, 8, (x, y) => (x + y) % 2 ? [90, 90, 90, 255] : [166, 166, 166, 255]), 8, 8);
    const flat = analyzeRgbaPixels(pixels(8, 8, () => [128, 128, 128, 255]), 8, 8);
    assert.equal(textured.brightness, flat.brightness);
    assert.ok(textured.sharpness > QUALITY_THRESHOLDS.laplacianVarianceReviewBelow);
    assert.equal(textured.verdict, 'good');
  });

  it('reports partial highlights for review and says they are not defects', () => {
    const result = analyzeRgbaPixels(pixels(10, 10, (x, y) => x < 3 ? [255, 255, 255, 255] : (x + y) % 2 ? [90, 90, 90, 255] : [166, 166, 166, 255]), 10, 10);
    assert.equal(result.brightRatio, 0.3);
    assert.equal(result.verdict, 'review');
    assert.ok(result.warnings.some(warning => warning.includes('高光本身不代表缺陷')));
  });

  it('handles a one-pixel image without NaN or invented clarity', () => {
    const result = analyzeRgbaPixels(new Uint8ClampedArray([128, 128, 128, 255]), 1, 1);
    assert.equal(result.sharpness, 0);
    assert.equal(result.verdict, 'review');
    assert.ok(result.warnings.some(warning => warning.includes('尺寸过小')));
  });

  it('rejects incomplete, zero-size and fractional pixel layouts', () => {
    assert.throws(() => analyzeRgbaPixels(new Uint8ClampedArray(3), 1, 1));
    assert.throws(() => analyzeRgbaPixels(new Uint8ClampedArray(), 0, 0));
    assert.throws(() => analyzeRgbaPixels(new Uint8ClampedArray(4), 0.5, 2));
  });
});
