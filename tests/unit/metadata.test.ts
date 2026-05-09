import { describe, expect, it } from 'vitest';
import {
  COMPACT_DOVI_FLOAT32_COUNT,
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
    expect(floats[0]).toBe(0);
    expect(floats[4]).toBe(1);
    expect(floats[16]).toBe(1);
    expect(floats[28]).toBe(0);
    expect(floats[29]).toBe(1);
  });
});
