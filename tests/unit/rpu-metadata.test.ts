import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseLengthPrefixedHevcSample } from '../../src/core/hevc';
import { COMPACT_DOVI_FLOAT32_COUNT } from '../../src/core/metadata';
import { parseMp4 } from '../../src/core/mp4';
import { initRpuMetadataWasmSync, parseRpuMetadataForShader } from '../../src/core/rpu-metadata';

const fixture = path.resolve(__dirname, '../fixtures/dv_p5_short.mp4');
const wasmFixture = path.resolve(__dirname, '../../src/wasm/lumabridge_wasm/lumabridge_wasm_bg.wasm');

function firstFixtureRpu(): Uint8Array {
  const bytes = new Uint8Array(fs.readFileSync(fixture));
  const track = parseMp4(bytes).tracks[0];
  const sample = track.samples[0];
  const sampleBytes = bytes.subarray(sample.offset, sample.offset + sample.size);
  const analysis = parseLengthPrefixedHevcSample(sampleBytes, track.hevcConfig?.lengthSize ?? 4);
  const rpu = analysis.rpuNalUnits[0];
  return sampleBytes.slice(rpu.payloadOffset, rpu.payloadOffset + rpu.size);
}

describe('RPU metadata WASM adapter', () => {
  it('parses a real DV P5 RPU into the compact shader ABI', async () => {
    initRpuMetadataWasmSync(fs.readFileSync(wasmFixture));
    const result = await parseRpuMetadataForShader(firstFixtureRpu());

    expect(result.probe.error).toBeNull();
    expect(result.probe.ok).toBe(true);
    expect(result.probe.source).toBe('wasm');
    expect(result.packed).toHaveLength(COMPACT_DOVI_FLOAT32_COUNT);
    expect(result.probe.sourceMinPq).toBeCloseTo(7 / 4095, 5);
    expect(result.probe.sourceMaxPq).toBeCloseTo(3079 / 4095, 5);
    expect(result.probe.level1MaxPq).toBeGreaterThan(0);
    expect(result.probe.level1AvgPq).toBeGreaterThan(0);
    expect(result.probe.level1MaxPq).toBeGreaterThan(result.probe.level1AvgPq ?? 0);
    expect(result.probe.nonlinearOffset?.[1]).toBeCloseTo(0.5, 5);
    expect(result.probe.firstPolyCoeffs?.[0]).toBeCloseTo(9133 / 8_388_608, 5);
    expect(result.probe.firstPolyCoeffs?.[1]).toBeCloseTo(17_647_044 / 8_388_608, 5);
  });

  it('falls back to identity metadata when RPU data is unavailable', async () => {
    const result = await parseRpuMetadataForShader(null);

    expect(result.probe.ok).toBe(false);
    expect(result.probe.source).toBe('identity');
    expect(result.packed).toHaveLength(COMPACT_DOVI_FLOAT32_COUNT);
    expect(result.probe.sourceMinPq).toBe(0);
    expect(result.probe.sourceMaxPq).toBe(1);
    expect(result.probe.level1MaxPq).toBe(0);
    expect(result.probe.level1AvgPq).toBe(0);
  });
});
