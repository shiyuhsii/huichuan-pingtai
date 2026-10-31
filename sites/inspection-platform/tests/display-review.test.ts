import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { InspectionBox } from '../app/lib/types';

const { clearDisplayOverlay } = await import(pathToFileURL(resolve('app/lib/display-review.ts')).href) as typeof import('../app/lib/display-review');

const width = 40, height = 20;
const box: InspectionBox = { id: 'overlay-1', x: 3 / width, y: 4 / height, w: 7 / width, h: 6 / height, origin: 'fpga', label: 'pending', note: '' };
function frame(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = x < width / 2 ? 75 + x + y : (x + y) % 2 ? 255 : 0;
    data.set([value, value, value, 255], (y * width + x) * 4);
  }
  return data;
}
function red(data: Uint8ClampedArray, x: number, y: number) {
  data.set([255, 32, 32, 255], (y * width + x) * 4);
}
function rectangle(data: Uint8ClampedArray, offset: number) {
  for (let x = 3; x <= 9; x++) { red(data, x + offset, 4); red(data, x + offset, 9); }
  for (let y = 4; y <= 9; y++) { red(data, 3 + offset, y); red(data, 9 + offset, y); }
}

describe('paired display review background', () => {
  it('only interpolates known device marker boundaries, on both display halves', () => {
    const data = frame(); rectangle(data, 0); rectangle(data, width / 2);
    red(data, 6, 6); // An interior red pixel is not a rectangle boundary.
    red(data, 13, 15); // An unrelated red pixel must remain evidence.
    const before = new Uint8ClampedArray(data);
    const result = clearDisplayOverlay(data, width, height, [box]);
    assert.deepEqual(data, before, 'source pixels remain immutable');
    for (let i = 0; i < data.length; i += 4) {
      const x = (i / 4) % width, y = Math.floor(i / 4 / width), localX = x % (width / 2);
      const boundary = ((localX === 3 || localX === 9) && y >= 4 && y <= 9) || ((y === 4 || y === 9) && localX >= 3 && localX <= 9);
      if (!boundary) assert.deepEqual(result.slice(i, i + 4), data.slice(i, i + 4));
      else { assert.equal(result[i], result[i + 1]); assert.equal(result[i], result[i + 2]); assert.equal(result[i + 3], 255); }
    }
  });

  it('keeps every original gray pixel and cyan HUD pixel unchanged', () => {
    const data = frame(); rectangle(data, 0); rectangle(data, width / 2);
    data.set([0, 255, 255, 255], (4 * width + 5) * 4);
    data.set([11, 11, 11, 255], (4 * width + 6) * 4);
    const result = clearDisplayOverlay(data, width, height, [box]);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== 255 || data[i + 1] !== 32 || data[i + 2] !== 32) assert.deepEqual(result.slice(i, i + 4), data.slice(i, i + 4));
    }
  });

  it('ignores manual or example regions instead of painting over image content', () => {
    const data = frame(); rectangle(data, 0);
    assert.deepEqual(clearDisplayOverlay(data, width, height, [{ ...box, origin: 'manual' }]), data);
    assert.deepEqual(clearDisplayOverlay(data, width, height, [{ ...box, origin: 'example' }]), data);
  });

  it('still clears original marker pixels when a device region is removed', () => {
    const data = frame(); rectangle(data, 0);
    const removed = { ...box, removed: true };
    assert.deepEqual(clearDisplayOverlay(data, width, height, [removed]), clearDisplayOverlay(data, width, height, [box]));
  });

  it('ignores invalid device geometry and never modifies outside known bounds', () => {
    const data = frame(); rectangle(data, 0);
    assert.deepEqual(clearDisplayOverlay(data, width, height, [{ ...box, x: NaN }, { ...box, w: 0 }, { ...box, x: .6 }, { ...box, y: -.01 }]), data);
    assert.throws(() => clearDisplayOverlay(data.subarray(1), width, height, [box]));
    assert.throws(() => clearDisplayOverlay(data, width - 1, height, [box]));
  });

  it('preserves marker pixels when no nearby gray evidence is available', () => {
    const data = frame();
    for (let i = 0; i < data.length; i += 4) data.set([0, 255, 255, 255], i);
    rectangle(data, 0);
    assert.deepEqual(clearDisplayOverlay(data, width, height, [box]), data);
  });
});
