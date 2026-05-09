import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('fixture files remain small enough for repository smoke tests', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const files = [
    'tests/fixtures/dv_p5_short.mp4',
    'tests/fixtures/dv_p5_single_frame.mp4',
    'tests/fixtures/hdr10_short.mp4',
    'tests/fixtures/bad_codec.mp4',
  ];

  for (const file of files) {
    const stat = fs.statSync(path.join(root, file));
    expect(stat.size, file).toBeGreaterThan(0);
    expect(stat.size, file).toBeLessThan(3 * 1024 * 1024);
  }
});
