import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseMp4 } from '../../src/core/mp4';

const fixture = path.resolve(__dirname, '../fixtures/dv_p5_short.mp4');

describe('MP4 parser', () => {
  it('extracts HEVC track metadata and sample table from the DV fixture', () => {
    const parsed = parseMp4(new Uint8Array(fs.readFileSync(fixture)));
    const track = parsed.tracks[0];

    expect(parsed.brands).toContain('isom');
    expect(track.codecType).toBe('hev1');
    expect(track.width).toBe(3840);
    expect(track.height).toBe(1608);
    expect(track.timescale).toBe(16000);
    expect(track.sampleCount).toBe(154);
    expect(track.samples).toHaveLength(154);
    expect(track.samples.filter((sample) => sample.isSync)).toHaveLength(2);
    expect(track.samples[0].offset).toBeGreaterThan(0);
    expect(track.samples[0].size).toBeGreaterThan(0);
  });

  it('builds a WebCodecs-style HEVC codec string from hvcC', () => {
    const parsed = parseMp4(new Uint8Array(fs.readFileSync(fixture)));
    const track = parsed.tracks[0];

    expect(track.hevcConfig?.lengthSize).toBe(4);
    expect(track.hevcConfig?.codecString).toMatch(/^hev1\.2\./);
    expect(track.hasDolbyVisionConfig).toBe(false);
  });
});
