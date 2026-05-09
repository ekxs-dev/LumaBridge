import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseMp4 } from '../../src/core/mp4';
import { findSampleForSeconds, inspectRpuAnnexBPacket, inspectRpuForSeconds } from '../../src/core/rpu-alignment';

describe('RPU frame alignment', () => {
  const bytes = new Uint8Array(readFileSync('tests/fixtures/dv_p5_short.mp4'));
  const track = parseMp4(bytes).tracks[0];

  it('maps a selected time to the display sample carrying the RPU NAL', () => {
    const sample = findSampleForSeconds(track, 0.04);
    expect(sample?.index).toBe(4);

    const selection = inspectRpuForSeconds(bytes, track, 0.04);
    expect(selection.status).toBe('present');
    expect(selection.sampleIndex).toBe(4);
    expect(selection.timestampUs).toBe(40_000);
    expect(selection.durationUs).toBe(40_000);
    expect(selection.rpuNalUnits).toBe(1);
    expect(selection.firstRpuNalHex).toMatch(/^7c /);
    expect(selection.firstRpuPayload?.byteLength).toBe(selection.firstRpuNalSize);
  });

  it('reports when a requested time is beyond parsed samples', () => {
    const selection = inspectRpuForSeconds(bytes, track, 999);
    expect(selection.status).toBe('outside-parsed-samples');
    expect(selection.sampleIndex).toBeNull();
    expect(selection.rpuNalUnits).toBe(0);
  });

  it('maps ffmpeg-extracted Annex-B packets to RPU diagnostics without parsed sample tables', () => {
    const selection = inspectRpuAnnexBPacket(new Uint8Array([
      0, 0, 0, 1, 0x46, 0x01, 0xaa,
      0, 0, 1, 0x7c, 0x01, 0xbb,
    ]), 120);

    expect(selection.status).toBe('present');
    expect(selection.sampleIndex).toBeNull();
    expect(selection.timestampUs).toBe(120_000_000);
    expect(selection.rpuNalUnits).toBe(1);
    expect(selection.firstRpuNalHex).toMatch(/^7c /);
    expect(selection.firstRpuPayload?.byteLength).toBe(selection.firstRpuNalSize);
  });
});
