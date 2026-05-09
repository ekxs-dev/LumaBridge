import { describe, expect, it } from 'vitest';
import {
  convertI420P10ToSdrPreview,
  createI420P10Frame,
  expectedI420P10ByteLength,
} from '../../src/core/raw-frame';

function writeU16LE(data: Uint8Array, sampleIndex: number, value: number): void {
  const offset = sampleIndex * 2;
  data[offset] = value & 0xff;
  data[offset + 1] = value >> 8;
}

describe('raw I420P10 frame preview', () => {
  it('computes tightly packed I420P10 byte length', () => {
    expect(expectedI420P10ByteLength(4, 2)).toBe(24);
    expect(expectedI420P10ByteLength(3840, 1608)).toBe(18_524_160);
  });

  it('builds planar offsets for tightly packed I420P10 data', () => {
    const frame = createI420P10Frame(new Uint8Array(expectedI420P10ByteLength(4, 2)), 4, 2);

    expect(frame.yOffset).toBe(0);
    expect(frame.uOffset).toBe(8);
    expect(frame.vOffset).toBe(10);
    expect(frame.yStride).toBe(4);
    expect(frame.uvStride).toBe(2);
  });

  it('renders a non-black SDR preview from neutral bright samples', () => {
    const data = new Uint8Array(expectedI420P10ByteLength(4, 2));
    const frame = createI420P10Frame(data, 4, 2);
    for (let index = 0; index < 8; index += 1) writeU16LE(data, frame.yOffset + index, 650);
    for (let index = 0; index < 2; index += 1) {
      writeU16LE(data, frame.uOffset + index, 512);
      writeU16LE(data, frame.vOffset + index, 512);
    }

    const preview = convertI420P10ToSdrPreview(frame, 4);

    expect(preview.width).toBe(4);
    expect(preview.height).toBe(2);
    expect(preview.stats.nonBlackPixels).toBe(8);
    expect(preview.stats.averageRgb[0]).toBeGreaterThan(0);
    expect(preview.data[3]).toBe(255);
  });
});
