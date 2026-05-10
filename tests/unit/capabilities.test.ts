import { describe, expect, it } from 'vitest';
import { evaluateCapabilities } from '../../src/core/capabilities';

describe('capability decision', () => {
  it('accepts the strict DV P5 preview path', () => {
    const report = evaluateCapabilities({
      hasWebGPU: true,
      hasWebCodecs: true,
      hevcSupported: true,
      outputFormat: 'I420P10',
      colorSpace: { primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl' },
      rpuPresent: true,
    });

    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
  });

  it('returns explicit failure codes for missing runtime features', () => {
    const report = evaluateCapabilities({
      hasWebGPU: false,
      hasWebCodecs: false,
      hevcSupported: false,
      outputFormat: 'NV12',
      colorSpace: { primaries: 'bt709', transfer: 'srgb', matrix: 'bt709' },
      rpuPresent: false,
    });

    expect(report.ok).toBe(false);
    expect(report.failures).toEqual([
      'WEBGPU_UNAVAILABLE',
      'WEBCODECS_UNAVAILABLE',
      'HEVC_UNSUPPORTED',
      'I420P10_REQUIRED',
      'COLORSPACE_INCOMPLETE',
      'RPU_REQUIRED',
    ]);
  });

  it('treats an observed null VideoFrame format as opaque preview only', () => {
    const report = evaluateCapabilities({
      hasWebGPU: true,
      hasWebCodecs: true,
      hevcSupported: true,
      outputFormat: null,
      rpuPresent: true,
    });

    expect(report.ok).toBe(false);
    expect(report.failures).toEqual(['I420P10_REQUIRED']);
    expect(report.warnings).toContain('VideoFrame output is opaque; raw copyTo() planes are unavailable.');
    expect(report.warnings).not.toContain('VideoFrame output format has not been observed yet.');
  });

  it('keeps an omitted VideoFrame format as an unobserved warning', () => {
    const report = evaluateCapabilities({
      hasWebGPU: true,
      hasWebCodecs: true,
      hevcSupported: true,
      rpuPresent: true,
    });

    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.warnings).toContain('VideoFrame output format has not been observed yet.');
  });
});
