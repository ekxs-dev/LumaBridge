import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { hasEbmlHeader, isLikelyMatroskaFile, isLikelyMp4File, parseMediaFile } from '../../src/core/media-source';

const mkvFixture = path.resolve(__dirname, '../fixtures/dv_p5_short.mkv');
const mp4Fixture = path.resolve(__dirname, '../fixtures/dv_p5_short.mp4');

function fixtureFile(filePath: string, type: string): File {
  const bytes = fs.readFileSync(filePath);
  return new File([bytes], path.basename(filePath), { type });
}

describe('media source parser', () => {
  it('detects likely containers from MIME type and extension', () => {
    expect(isLikelyMatroskaFile({ name: 'input.mkv', type: 'video/matroska' })).toBe(true);
    expect(isLikelyMp4File({ name: 'input.mp4', type: 'video/mp4' })).toBe(true);
  });

  it('detects EBML headers', () => {
    expect(hasEbmlHeader(new Uint8Array(fs.readFileSync(mkvFixture)).subarray(0, 8))).toBe(true);
    expect(hasEbmlHeader(new Uint8Array(fs.readFileSync(mp4Fixture)).subarray(0, 8))).toBe(false);
  });

  it('parses MP4 files as complete media sources', async () => {
    const parsed = await parseMediaFile(fixtureFile(mp4Fixture, 'video/mp4'));

    expect(parsed.container).toBe('mp4');
    expect(parsed.isPartial).toBe(false);
    expect(parsed.tracks[0].sampleCount).toBe(154);
  });

  it('parses MKV files from a prefix media source', async () => {
    const parsed = await parseMediaFile(fixtureFile(mkvFixture, 'video/matroska'), 512 * 1024);

    expect(parsed.container).toBe('matroska');
    expect(parsed.isPartial).toBe(true);
    expect(parsed.warning).toContain('prefix');
    expect(parsed.tracks[0].codecType).toBe('hev1');
    expect(parsed.tracks[0].samples.length).toBeGreaterThan(0);
  });
});
