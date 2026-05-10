import { describe, expect, it } from 'vitest';
import { comparePreviewToReference } from '../../src/core/reference-compare';
import type { SdrPreviewImage } from '../../src/core/raw-frame';

function image(data: number[]): SdrPreviewImage {
  return {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray(data),
    stats: {
      averageRgb: [0, 0, 0],
      nonBlackPixels: 0,
    },
  };
}

describe('reference image comparison', () => {
  it('computes channel MAE, max error, and outlier pixels', () => {
    const preview = image([
      10, 20, 30, 255,
      40, 50, 60, 255,
    ]);
    const stats = comparePreviewToReference(preview, {
      name: 'ref.png',
      width: 2,
      height: 1,
      data: new Uint8ClampedArray([
        12, 18, 30, 255,
        30, 50, 80, 255,
      ]),
    }, 9);

    expect(stats.meanRgbAbsError).toEqual([6, 1, 10]);
    expect(stats.meanAbsError).toBeCloseTo(17 / 3);
    expect(stats.maxAbsError).toBe(20);
    expect(stats.maxAbsPixel).toEqual({ x: 1, y: 0, channel: 'b', output: 60, reference: 80 });
    expect(stats.outlierPixels).toBe(1);
  });

  it('rejects mismatched reference dimensions', () => {
    const preview = image([0, 0, 0, 255, 0, 0, 0, 255]);
    expect(() => comparePreviewToReference(preview, {
      name: 'wrong.png',
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([0, 0, 0, 255]),
    })).toThrow(/do not match/);
  });
});
