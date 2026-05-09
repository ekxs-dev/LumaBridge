import { describe, expect, it } from 'vitest';
import {
  bt2020ToBt709,
  doviIptToLms,
  doviLmsToBt2020,
  normalizeYuv10Sample,
  pqEotf,
  reinhardToneMap,
  reshapeMmr,
  reshapePolynomial,
  yuvBt2020ToRgb,
} from '../../src/core/color';

describe('color math references', () => {
  it('normalizes YUV10 full and limited range', () => {
    expect(normalizeYuv10Sample(1023, 'full', 'y')).toBeCloseTo(1);
    expect(normalizeYuv10Sample(64, 'limited', 'y')).toBeCloseTo(0);
    expect(normalizeYuv10Sample(940, 'limited', 'y')).toBeCloseTo(1);
    expect(normalizeYuv10Sample(960, 'limited', 'uv')).toBeCloseTo(1);
  });

  it('computes PQ EOTF anchor points', () => {
    expect(pqEotf(0)).toBeCloseTo(0);
    expect(pqEotf(1)).toBeCloseTo(10000, 0);
  });

  it('converts BT.2020 YUV to RGB and then BT.709', () => {
    const rgb = yuvBt2020ToRgb(0.5, 0.5, 0.5);
    expect(rgb[0]).toBeCloseTo(0.5);
    expect(rgb[1]).toBeCloseTo(0.5);
    expect(rgb[2]).toBeCloseTo(0.5);
    const mapped = bt2020ToBt709(rgb);
    expect(mapped[0]).toBeGreaterThan(0.49);
    expect(mapped[1]).toBeGreaterThan(0.49);
    expect(mapped[2]).toBeGreaterThan(0.49);
  });

  it('keeps neutral Dolby Vision IPT/LMS values neutral', () => {
    const lms = doviIptToLms([0.5, 0, 0]);
    expect(lms[0]).toBeCloseTo(0.5);
    expect(lms[1]).toBeCloseTo(0.5);
    expect(lms[2]).toBeCloseTo(0.5);

    const rgb2020 = doviLmsToBt2020(lms);
    expect(rgb2020[0]).toBeCloseTo(rgb2020[1], 3);
    expect(rgb2020[1]).toBeCloseTo(rgb2020[2], 3);
  });

  it('evaluates polynomial and MMR reshape references', () => {
    expect(reshapePolynomial(0.5, [0.1, 0.8, 0.2])).toBeCloseTo(0.55);
    expect(reshapeMmr([0.2, 0.3, 0.4], 0.1, [1, 1, 1, 0, 0, 0, 0])).toBeCloseTo(1.0);
  });

  it('keeps fixed tone mapping deterministic', () => {
    expect(reinhardToneMap(100)).toBeCloseTo(0.5);
    expect(reinhardToneMap(0)).toBe(0);
  });
});
