import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  __webcodecsTestHooks,
  buildVideoDecoderConfig,
  planEncodedChunk,
  sampleDurationUs,
  sampleTimestampUs,
} from '../../src/core/webcodecs';
import { parseMp4 } from '../../src/core/mp4';

const fixture = path.resolve(__dirname, '../fixtures/dv_p5_short.mp4');

describe('WebCodecs planning', () => {
  it('converts MP4 sample timing to microseconds', () => {
    const track = parseMp4(new Uint8Array(fs.readFileSync(fixture))).tracks[0];
    const first = track.samples[0];

    expect(sampleTimestampUs(first, track.timescale)).toBe(160_000);
    expect(sampleDurationUs(first, track.timescale)).toBe(40_000);
  });

  it('plans EncodedVideoChunk init values from the MP4 sample table', () => {
    const track = parseMp4(new Uint8Array(fs.readFileSync(fixture))).tracks[0];
    const plan = planEncodedChunk(track.samples[0], track);

    expect(plan.type).toBe('key');
    expect(plan.timestamp).toBe(160_000);
    expect(plan.duration).toBe(40_000);
    expect(plan.byteLength).toBe(track.samples[0].size);
  });

  it('builds a VideoDecoderConfig with hvcC description bytes', () => {
    const track = parseMp4(new Uint8Array(fs.readFileSync(fixture))).tracks[0];
    const config = buildVideoDecoderConfig(track);

    expect(config.codec).toMatch(/^hev1\.2\./);
    expect(config.codedWidth).toBe(3840);
    expect(config.codedHeight).toBe(1608);
    expect(config.description).toBeInstanceOf(Uint8Array);
    expect((config.description as Uint8Array).byteLength).toBeGreaterThan(20);
  });

  it('plans strict and relaxed HEVC codec candidates for browser probing', () => {
    expect(__webcodecsTestHooks.uniqueCodecCandidates('hev1.2.6.L150.B900000000000')).toEqual([
      'hev1.2.6.L150.B900000000000',
      'hev1.2.6.L150.B0',
      'hvc1.2.6.L150.B900000000000',
      'hvc1.2.6.L150.B0',
    ]);
  });

  it('starts selected-time previews from the nearest previous sync sample', () => {
    const track = {
      id: 1,
      handlerType: 'vide',
      timescale: 1000,
      duration: 1000,
      width: 1920,
      height: 1080,
      codecType: 'hev1',
      hevcConfig: null,
      hasDolbyVisionConfig: true,
      sampleCount: 6,
      samples: [
        { index: 0, offset: 0, size: 10, dts: 0, cts: 0, duration: 40, isSync: true },
        { index: 1, offset: 10, size: 10, dts: 40, cts: 40, duration: 40, isSync: false },
        { index: 2, offset: 20, size: 10, dts: 80, cts: 80, duration: 40, isSync: false },
        { index: 3, offset: 30, size: 10, dts: 120, cts: 120, duration: 40, isSync: true },
        { index: 4, offset: 40, size: 10, dts: 160, cts: 160, duration: 40, isSync: false },
        { index: 5, offset: 50, size: 10, dts: 200, cts: 200, duration: 40, isSync: false },
      ],
    };

    expect(__webcodecsTestHooks.findDecodeStartSampleIndex(track, 1)).toBe(0);
    expect(__webcodecsTestHooks.findDecodeStartSampleIndex(track, 119_000)).toBe(0);
    expect(__webcodecsTestHooks.findDecodeStartSampleIndex(track, 120_000)).toBe(3);
    expect(__webcodecsTestHooks.findDecodeStartSampleIndex(track, 199_000)).toBe(3);
  });
});
