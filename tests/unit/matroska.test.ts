import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeMp4HevcSamples, parseLengthPrefixedHevcSample } from '../../src/core/hevc';
import { parseMatroska } from '../../src/core/matroska';
import rpuReference from '../references/rpu_reference.json';

const fixture = path.resolve(__dirname, '../fixtures/dv_p5_short.mkv');

describe('Matroska parser', () => {
  it('extracts HEVC track metadata and blocks from a DV MKV fixture', () => {
    const bytes = new Uint8Array(fs.readFileSync(fixture));
    const parsed = parseMatroska(bytes, 200);
    const track = parsed.tracks[0];

    expect(parsed.brands).toEqual(['matroska']);
    expect(track.codecType).toBe('hev1');
    expect(track.width).toBe(3840);
    expect(track.height).toBe(1608);
    expect(track.timescale).toBe(1000);
    expect(track.sampleCount).toBeGreaterThan(20);
    expect(track.samples[0].offset).toBeGreaterThan(0);
    expect(track.samples[0].size).toBeGreaterThan(0);
    expect(track.hevcConfig?.lengthSize).toBe(4);
    expect(track.hevcConfig?.codecString).toMatch(/^hev1\.2\./);
  });

  it('parses RPU NAL units from Matroska length-prefixed HEVC blocks', () => {
    const bytes = new Uint8Array(fs.readFileSync(fixture));
    const parsed = parseMatroska(bytes, 200);
    const track = parsed.tracks[0];
    const firstSample = track.samples[0];
    const firstSampleAnalysis = parseLengthPrefixedHevcSample(
      bytes.subarray(firstSample.offset, firstSample.offset + firstSample.size),
      track.hevcConfig?.lengthSize ?? 4,
    );
    const fullAnalysis = analyzeMp4HevcSamples(bytes, track.samples, track.hevcConfig?.lengthSize ?? 4);

    expect(firstSampleAnalysis.rpuNalUnits.length).toBeGreaterThan(0);
    expect(fullAnalysis.rpuNalUnits.length).toBe(rpuReference.rpuCount);
    expect(fullAnalysis.nalUnitCounts['62']).toBe(rpuReference.rpuCount);
  });

  it('can parse a prefix window when the Segment size extends beyond loaded bytes', () => {
    const bytes = new Uint8Array(fs.readFileSync(fixture)).subarray(0, 512 * 1024);
    const parsed = parseMatroska(bytes);
    const track = parsed.tracks[0];

    expect(track.width).toBe(3840);
    expect(track.height).toBe(1608);
    expect(track.samples.length).toBeGreaterThan(0);
  });
});
