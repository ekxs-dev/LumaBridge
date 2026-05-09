import { describe, expect, it } from 'vitest';
import {
  COMPACT_DOVI_FLOAT32_COUNT,
  COMPACT_DOVI_LAYOUT,
  createIdentityDoviMetadata,
  metadataForTimestamp,
  packCompactDoviMetadata,
  sortByDisplayTimestamp,
  sortByPoc,
} from '../../src/core/metadata';

describe('frame metadata alignment', () => {
  const reordered = [
    { timestamp: 80_000, poc: 2, rpuIndex: 2 },
    { timestamp: 0, poc: 0, rpuIndex: 0 },
    { timestamp: 40_000, poc: 1, rpuIndex: 1 },
  ];

  it('maps decoded timestamps to RPU metadata', () => {
    expect(metadataForTimestamp(reordered, 40_000)?.rpuIndex).toBe(1);
    expect(metadataForTimestamp(reordered, 120_000)).toBeNull();
  });

  it('keeps display order and POC order explicit', () => {
    expect(sortByDisplayTimestamp(reordered).map((frame) => frame.timestamp)).toEqual([0, 40_000, 80_000]);
    expect(sortByPoc(reordered).map((frame) => frame.poc)).toEqual([0, 1, 2]);
  });
});

describe('compact metadata packing', () => {
  it('uses a fixed WGSL-compatible Float32 layout', () => {
    const buffer = packCompactDoviMetadata(createIdentityDoviMetadata());
    const floats = new Float32Array(buffer);

    expect(floats).toHaveLength(COMPACT_DOVI_FLOAT32_COUNT);
    expect(COMPACT_DOVI_FLOAT32_COUNT).toBe(840);
    expect(floats[0]).toBe(0);
    expect(floats[4]).toBe(1);
    expect(floats[8 + 1]).toBe(1);
    expect(floats[12 + 2]).toBe(1);
    expect(floats[16]).toBe(1);
    expect(floats[28]).toBe(0);
    expect(floats[29]).toBe(1);
    expect([...floats.slice(COMPACT_DOVI_LAYOUT.reshapeHeader, COMPACT_DOVI_LAYOUT.reshapeHeader + 4)]).toEqual([2, 2, 2, 0]);
    expect([...floats.slice(COMPACT_DOVI_LAYOUT.polyCoeffs, COMPACT_DOVI_LAYOUT.polyCoeffs + 4)]).toEqual([0, 1, 0, 0]);
    expect([...floats.slice(COMPACT_DOVI_LAYOUT.polyCoeffs + 32, COMPACT_DOVI_LAYOUT.polyCoeffs + 36)]).toEqual([0, 1, 0, 0]);
    expect([...floats.slice(COMPACT_DOVI_LAYOUT.polyCoeffs + 64, COMPACT_DOVI_LAYOUT.polyCoeffs + 68)]).toEqual([0, 1, 0, 0]);
  });

  it('packs matrix rows with vec4 padding for WGSL uniform layout', () => {
    const metadata = createIdentityDoviMetadata();
    metadata.nonlinearMatrix = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    metadata.linearMatrix = [11, 12, 13, 14, 15, 16, 17, 18, 19];
    metadata.reshapeHeader = [3, 2, 2, 0];
    metadata.pivots = Array.from({ length: 36 }, (_, index) => 100 + index);
    metadata.pieceMeta = Array.from({ length: 96 }, (_, index) => 700 + index);
    metadata.polyCoeffs = Array.from({ length: 96 }, (_, index) => 200 + index);
    metadata.mmrCoeffs = Array.from({ length: 576 }, (_, index) => 300 + index);

    const floats = new Float32Array(packCompactDoviMetadata(metadata));

    expect([...floats.slice(COMPACT_DOVI_LAYOUT.nonlinearMatrix, COMPACT_DOVI_LAYOUT.nonlinearMatrix + 12)]).toEqual([
      1, 2, 3, 0,
      4, 5, 6, 0,
      7, 8, 9, 0,
    ]);
    expect([...floats.slice(COMPACT_DOVI_LAYOUT.linearMatrix, COMPACT_DOVI_LAYOUT.linearMatrix + 12)]).toEqual([
      11, 12, 13, 0,
      14, 15, 16, 0,
      17, 18, 19, 0,
    ]);
    expect(floats[COMPACT_DOVI_LAYOUT.pivots]).toBe(100);
    expect(floats[COMPACT_DOVI_LAYOUT.pieceMeta]).toBe(700);
    expect(floats[COMPACT_DOVI_LAYOUT.polyCoeffs]).toBe(200);
    expect(floats[COMPACT_DOVI_LAYOUT.mmrCoeffs]).toBe(300);
    expect(floats[COMPACT_DOVI_FLOAT32_COUNT - 1]).toBe(875);
  });
});
