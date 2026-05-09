import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import rpuReference from '../references/rpu_reference.json';

const root = path.resolve(__dirname, '../..');

describe('versioned fixtures', () => {
  it('includes the required media and golden files', () => {
    for (const relative of [
      'tests/fixtures/dv_p5_short.mp4',
      'tests/fixtures/dv_p5_single_frame.mp4',
      'tests/fixtures/hdr10_short.mp4',
      'tests/fixtures/no_rpu_hevc.mp4',
      'tests/fixtures/bad_codec.mp4',
      'tests/references/sdr_reference.png',
      'tests/references/rpu_reference.json',
    ]) {
      expect(fs.existsSync(path.join(root, relative)), relative).toBe(true);
    }
  });

  it('pins RPU extraction count for the DV fixture', () => {
    expect(rpuReference.dvProfile).toBe(5);
    expect(rpuReference.rpuCount).toBe(154);
    expect(rpuReference.nalUnitCounts['62']).toBe(154);
  });
});
