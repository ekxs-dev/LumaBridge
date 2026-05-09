import { describe, expect, it } from 'vitest';
import { validateI420P10CopyLayout } from '../../src/core/video-frame-layout';

describe('VideoFrame.copyTo layout', () => {
  it('validates planar I420P10 offsets and strides', () => {
    const result = validateI420P10CopyLayout(
      [
        { offset: 0, stride: 8 },
        { offset: 16, stride: 4 },
        { offset: 20, stride: 4 },
      ],
      { width: 4, height: 2 },
      24,
    );

    expect(result.ySamples).toBe(8);
    expect(result.chromaSamples).toBe(2);
    expect(result.bytesPerSample).toBe(2);
  });

  it('rejects layouts that exceed the destination buffer', () => {
    expect(() => validateI420P10CopyLayout(
      [
        { offset: 0, stride: 8 },
        { offset: 16, stride: 4 },
        { offset: 24, stride: 4 },
      ],
      { width: 4, height: 2 },
      24,
    )).toThrow(/exceeds/);
  });
});
