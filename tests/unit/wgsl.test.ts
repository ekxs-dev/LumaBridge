import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const shaderPath = path.resolve(__dirname, '../../src/gpu/dv-p5-to-sdr.wgsl');

describe('WGSL shader source', () => {
  it('does not use known Chrome WGSL reserved identifiers as local names', () => {
    const source = fs.readFileSync(shaderPath, 'utf8');

    expect(source).not.toMatch(/\b(?:let|var)\s+meta\b/);
  });

  it('uses the BT.2390 diagnostic tone map instead of the old Reinhard path', () => {
    const source = fs.readFileSync(shaderPath, 'utf8');

    expect(source).toContain('fn tone_map_bt2390_pq');
    expect(source).toContain('fn tone_map_bt2390_to_sdr');
    expect(source).not.toContain('tone_map_reinhard');
  });

  it('uses DV Level 1 max PQ as the tone mapping peak when present', () => {
    const source = fs.readFileSync(shaderPath, 'utf8');

    expect(source).toContain('x/y: source min/max PQ, z/w: DV Level 1 max/avg PQ');
    expect(source).toContain('select(doviParams.sourcePq.y, doviParams.sourcePq.z, doviParams.sourcePq.z > 0.0)');
  });

  it('applies the libplacebo DV offset normalization scale', () => {
    const source = fs.readFileSync(shaderPath, 'utf8');

    expect(source).toContain('let doviOffsetScale = 1024.0 / 1023.0');
    expect(source).toContain('doviParams.nonlinearOffset.xyz * vec3<f32>(doviOffsetScale)');
  });
});
