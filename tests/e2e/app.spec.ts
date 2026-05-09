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
  await expect(page.getByText('WebCodecs probe')).toBeVisible();
  await expect(page.locator('#video-file')).toBeAttached();
  await expect(page.locator('#bench-video')).toBeVisible();
  await expect(page.locator('#sdr-preview')).toBeVisible();
  await expect(page.locator('#sdr-preview-meta')).toContainText('SDR debug preview waiting');
  await expect(page.locator('#ffmpeg-raw-probe')).toBeDisabled();
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
  await expect(page.locator('#track-meta')).toContainText('154 total');
  await expect(page.locator('#decode-meta')).not.toContainText('not run');
  await expect(page.locator('#ffmpeg-raw-probe')).toBeEnabled();

  const report = await page.locator('#report-json').textContent();
  const parsed = JSON.parse(report ?? '{}');
  expect(parsed.selectedVideo.name).toBe('dv_p5_short.mp4');
  expect(parsed.mp4.container).toBe('mp4');
  expect(parsed.mp4.track.sampleCount).toBe(154);
  expect(parsed.mp4.track.codecType).toBe('hev1');
  expect(parsed.mp4.track.totalRpuNalUnits).toBe(154);
  expect(parsed.webCodecs).not.toBeNull();
  expect(parsed.webCodecs).toHaveProperty('copyTo');
});

test('benchmark page parses a selected MKV fixture without MP4 moov failure', async ({ page }) => {
  await page.goto('/bench');
  await page.locator('#video-file').setInputFiles(path.resolve('tests/fixtures/dv_p5_short.mkv'));
  await expect(page.locator('#selected-name')).toHaveText('dv_p5_short.mkv');
  await expect(page.locator('#track-meta')).toContainText('matroska');
  await expect(page.locator('#track-meta')).toContainText(/hev1\.2\./);
  await expect(page.locator('#track-meta')).toContainText('154 total');
  await expect(page.locator('#track-meta')).not.toContainText('MP4 moov box not found');
  await expect(page.locator('#decode-meta')).not.toContainText('not run');
  await expect(page.locator('#ffmpeg-raw-probe')).toBeEnabled();

  const report = await page.locator('#report-json').textContent();
  const parsed = JSON.parse(report ?? '{}');
  expect(parsed.selectedVideo.name).toBe('dv_p5_short.mkv');
  expect(parsed.mp4.container).toBe('matroska');
  expect(parsed.mp4.track.codecType).toBe('hev1');
  expect(parsed.mp4.track.totalRpuNalUnits).toBe(154);
  expect(parsed.parseError).toBeNull();
});
