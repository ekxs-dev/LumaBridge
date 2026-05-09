import { describe, expect, it } from 'vitest';
import { buildI420P10GpuUpload } from '../../src/core/gpu-upload';
import { createI420P10Frame, expectedI420P10ByteLength } from '../../src/core/raw-frame';

function writeU16LE(data: Uint8Array, sampleIndex: number, value: number): void {
  const offset = sampleIndex * 2;
  data[offset] = value & 0xff;
  data[offset + 1] = value >> 8;
}

describe('I420P10 WebGPU upload planning', () => {
  it('packs 10-bit Y/U/V samples into u32 storage planes', () => {
    const data = new Uint8Array(expectedI420P10ByteLength(4, 2));
    const frame = createI420P10Frame(data, 4, 2, 'limited');
    for (let index = 0; index < 8; index += 1) writeU16LE(data, frame.yOffset + index, 100 + index);
    writeU16LE(data, frame.uOffset, 512);
    writeU16LE(data, frame.uOffset + 1, 513);
    writeU16LE(data, frame.vOffset, 514);
    writeU16LE(data, frame.vOffset + 1, 515);

    const upload = buildI420P10GpuUpload(frame);

    expect([...upload.yPlane]).toEqual([100, 101, 102, 103, 104, 105, 106, 107]);
    expect([...upload.uPlane]).toEqual([512, 513]);
    expect([...upload.vPlane]).toEqual([514, 515]);
    expect(upload.frameParams).toEqual({
      width: 4,
      height: 2,
      yStride: 4,
      uvStride: 2,
      range: 1,
    });
    expect(upload.storageByteLength).toBe((8 + 2 + 2) * 4);
  });

  it('masks uploaded samples to the low 10 bits expected by WGSL', () => {
    const data = new Uint8Array(expectedI420P10ByteLength(2, 2));
    const frame = createI420P10Frame(data, 2, 2);
    writeU16LE(data, frame.yOffset, 0xffff);

    const upload = buildI420P10GpuUpload(frame);

    expect(upload.yPlane[0]).toBe(1023);
    expect(upload.frameParams.range).toBe(0);
  });
});
