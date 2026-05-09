import { expect, test } from '@playwright/test';
import path from 'node:path';

test('home page shows capability and debug contract', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Capability report')).toBeVisible();
  await expect(page.getByText('WebGPU')).toBeVisible();
  await expect(page.getByText('WebCodecs')).toBeVisible();
  await expect(page.getByText('I420P10')).toBeVisible();
  await expect(page.getByText('BT.2020')).toBeVisible();
  await expect(page.getByText('PQ')).toBeVisible();
  await expect(page.getByText('present')).toBeVisible();

  const nonBlank = await page.locator('#preview').evaluate((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.some((value) => value !== 0);
  });
  expect(nonBlank).toBe(true);
});

test('benchmark page emits a JSON timing report', async ({ page }) => {
  await page.goto('/bench');
  await expect(page.getByText('Pipeline timing report')).toBeVisible();
  await expect(page.getByText('Video preview')).toBeVisible();
  await expect(page.locator('#video-file')).toBeAttached();
  await expect(page.locator('#bench-video')).toBeVisible();
  await expect(page.getByRole('rowheader', { name: 'copyTo' })).toBeVisible();
  await expect(page.getByRole('rowheader', { name: 'shaderRender' })).toBeVisible();
  const report = await page.locator('#report-json').textContent();
  const parsed = JSON.parse(report ?? '{}');
  expect(parsed.selectedVideo).toBeNull();
  expect(parsed.summary.frames).toBeGreaterThan(0);
  expect(parsed.summary.stages.copyTo.p95).toBeGreaterThan(0);
});

test('benchmark page parses a selected MP4 fixture', async ({ page }) => {
  await page.goto('/bench');
  await page.locator('#video-file').setInputFiles(path.resolve('tests/fixtures/dv_p5_short.mp4'));
  await expect(page.locator('#selected-name')).toHaveText('dv_p5_short.mp4');
  await expect(page.locator('#track-meta')).toContainText(/hev1\.2\./);
  await expect(page.locator('#track-meta')).toContainText('154 (2 sync)');

  const report = await page.locator('#report-json').textContent();
  const parsed = JSON.parse(report ?? '{}');
  expect(parsed.selectedVideo.name).toBe('dv_p5_short.mp4');
  expect(parsed.mp4.track.sampleCount).toBe(154);
  expect(parsed.mp4.track.codecType).toBe('hev1');
});
