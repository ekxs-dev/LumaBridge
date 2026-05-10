import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const shaderPath = path.resolve(__dirname, '../../src/gpu/dv-p5-to-sdr.wgsl');
const externalShaderPath = path.resolve(__dirname, '../../src/gpu/external-video-to-sdr.wgsl');

describe('WGSL shader source', () => {
  it('does not use known Chrome WGSL reserved identifiers as local names', () => {
    const source = fs.readFileSync(shaderPath, 'utf8');

    for (const identifier of ['meta', 'target']) {
      expect(source).not.toMatch(new RegExp(`\\b(?:let|var)\\s+${identifier}\\b`));
      expect(source).not.toMatch(new RegExp(`\\b${identifier}\\s*:`));
    }
  });

  it('uses the BT.2390 diagnostic tone map instead of the old Reinhard path', () => {
    const source = fs.readFileSync(shaderPath, 'utf8');

    expect(source).toContain('fn tone_map_bt2390_pq');
    expect(source).toContain('fn tone_map_bt2390_to_sdr');
    expect(source).toContain('fn bt1886_oetf');
    expect(source).toContain('return bt1886_oetf(libplacebo_softclip_rgb(rgb709Linear))');
    expect(source).toContain('blackPower');
    expect(source).toContain('gainInv');
    expect(source).toContain('let libplaceboSdrWhiteNits = 203.0');
    expect(source).toContain('let libplaceboHdrBlackNits = 0.000001');
    expect(source).toContain('let effectiveInputMinPq = pq_oetf(libplaceboHdrBlackNits)');
    expect(source).toContain('let outputMinPq = pq_oetf(libplaceboSdrWhiteNits / 1000.0)');
    expect(source).not.toContain('tone_map_reinhard');
  });

  it('applies libplacebo-style RGB softclip before BT.1886 output', () => {
    const source = fs.readFileSync(shaderPath, 'utf8');

    expect(source).toContain('fn libplacebo_softclip(');
    expect(source).toContain('let knee = 0.70');
    expect(source).toContain('fn libplacebo_softclip_rgb');
    expect(source).toContain('return bt1886_oetf(libplacebo_softclip_rgb(rgb709Linear))');
  });

  it('uses DV Level 1 max PQ as the tone mapping peak when present', () => {
    const source = fs.readFileSync(shaderPath, 'utf8');

    expect(source).toContain('x/y: source min/max PQ, z/w: DV Level 1 max/avg PQ');
    expect(source).toContain('let inputMinPq = max(doviParams.sourcePq.x, 0.0)');
    expect(source).toContain('select(doviParams.sourcePq.y, doviParams.sourcePq.z, doviParams.sourcePq.z > 0.0)');
    expect(source).toContain('tone_map_bt2390_to_sdr(rgb2020Nits, inputMinPq, inputMaxPq)');
  });

  it('applies the libplacebo DV offset normalization scale', () => {
    const source = fs.readFileSync(shaderPath, 'utf8');

    expect(source).toContain('let doviOffsetScale = 1024.0 / 1023.0');
    expect(source).toContain('doviParams.nonlinearOffset.xyz * vec3<f32>(doviOffsetScale)');
  });

  it('does not clamp Dolby Vision nonlinear matrix output before PQ EOTF', () => {
    const source = fs.readFileSync(shaderPath, 'utf8');

    expect(source).toContain('let lmsCode = max(dovi_matrix3_mul(');
    expect(source).not.toContain('let lmsCode = clamp(dovi_matrix3_mul(');
  });

  it('uses bilinear luma/chroma sampling with left chroma siting', () => {
    const source = fs.readFileSync(shaderPath, 'utf8');

    expect(source).toContain('fn sample_y_linear');
    expect(source).toContain('fn sample_u_linear');
    expect(source).toContain('AVCHROMA_LOC_LEFT');
    expect(source).toContain('let chromaCoord = vec2<f32>(sourceCoord.x * 0.5, (sourceCoord.y - 0.5) * 0.5)');
  });

  it('keeps the external texture preview shader on the WebGPU opaque-frame path', () => {
    const source = fs.readFileSync(externalShaderPath, 'utf8');

    expect(source).toContain('var videoTexture: texture_external');
    expect(source).toContain('textureSampleBaseClampToEdge(videoTexture');
    expect(source).toContain('fn approximate_sdr_from_browser_rgb');
    for (const identifier of ['meta', 'target']) {
      expect(source).not.toMatch(new RegExp(`\\b(?:let|var)\\s+${identifier}\\b`));
      expect(source).not.toMatch(new RegExp(`\\b${identifier}\\s*:`));
    }
  });
});
