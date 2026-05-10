import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseLengthPrefixedHevcSample } from '../../src/core/hevc';
import { COMPACT_DOVI_FLOAT32_COUNT, COMPACT_DOVI_LAYOUT } from '../../src/core/metadata';
import { parseMp4 } from '../../src/core/mp4';
import { initRpuMetadataWasmSync, parseRpuMetadataForShader } from '../../src/core/rpu-metadata';

const fixture = path.resolve(__dirname, '../fixtures/dv_p5_short.mp4');
const wasmFixture = path.resolve(__dirname, '../../src/wasm/lumabridge_wasm/lumabridge_wasm_bg.wasm');

const FIRST_FRAME_FFPROBE_DOVI = {
  sourceMinPq: 7,
  sourceMaxPq: 3079,
  nonlinearOffset: [0, 134_217_728, 134_217_728],
  nonlinearMatrix: [
    8192, 799, 1681,
    8192, -933, 1091,
    8192, 267, -5545,
  ],
  linearMatrix: [
    17081, -349, -349,
    -349, 17081, -349,
    -349, -349, 17081,
  ],
  components: [
    {
      pivots: [0, 23, 114, 208, 439, 695, 951, 1012, 1021],
      method: 0,
      poly: [
        [9133, 17_647_044, -210_443_856],
        [92_181, 9_726_402, -14_114_748],
        [169_486, 8_149_535, -6_050_981],
      ],
    },
    {
      pivots: [0, 1023],
      method: 0,
      poly: [[-533_889, 10_408_705, 0]],
    },
    {
      pivots: [0, 1023],
      method: 0,
      poly: [[-1_094_095, 10_410_708, 0]],
    },
  ],
} as const;

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

  it('matches FFmpeg Dolby Vision side-data fields in compact metadata slots', async () => {
    initRpuMetadataWasmSync(fs.readFileSync(wasmFixture));
    const result = await parseRpuMetadataForShader(firstFixtureRpu());
    const packed = result.packed;

    expect(packed[COMPACT_DOVI_LAYOUT.sourcePq]).toBeCloseTo(FIRST_FRAME_FFPROBE_DOVI.sourceMinPq / 4095, 6);
    expect(packed[COMPACT_DOVI_LAYOUT.sourcePq + 1]).toBeCloseTo(FIRST_FRAME_FFPROBE_DOVI.sourceMaxPq / 4095, 6);
    for (const [index, value] of FIRST_FRAME_FFPROBE_DOVI.nonlinearOffset.entries()) {
      expect(packed[COMPACT_DOVI_LAYOUT.nonlinearOffset + index]).toBeCloseTo(value / 268_435_456, 6);
    }
    for (const [index, value] of FIRST_FRAME_FFPROBE_DOVI.nonlinearMatrix.entries()) {
      const row = Math.floor(index / 3);
      const column = index % 3;
      expect(packed[COMPACT_DOVI_LAYOUT.nonlinearMatrix + row * 4 + column]).toBeCloseTo(value / 8192, 6);
    }
    for (const [index, value] of FIRST_FRAME_FFPROBE_DOVI.linearMatrix.entries()) {
      const row = Math.floor(index / 3);
      const column = index % 3;
      expect(packed[COMPACT_DOVI_LAYOUT.linearMatrix + row * 4 + column]).toBeCloseTo(value / 16384, 6);
    }
    for (const [componentIndex, component] of FIRST_FRAME_FFPROBE_DOVI.components.entries()) {
      expect(packed[COMPACT_DOVI_LAYOUT.reshapeHeader + componentIndex]).toBe(component.pivots.length);
      const pivotBase = COMPACT_DOVI_LAYOUT.pivots + componentIndex * 12;
      for (const [pivotIndex, pivot] of component.pivots.entries()) {
        expect(packed[pivotBase + pivotIndex]).toBeCloseTo(pivot / 1023, 6);
      }
      const pieceBase = COMPACT_DOVI_LAYOUT.pieceMeta + componentIndex * 8 * 4;
      expect(packed[pieceBase]).toBe(component.method);
      for (const [pieceIndex, poly] of component.poly.entries()) {
        const coeffBase = COMPACT_DOVI_LAYOUT.polyCoeffs + (componentIndex * 8 + pieceIndex) * 4;
        expect(packed[coeffBase]).toBeCloseTo(poly[0] / 8_388_608, 6);
        expect(packed[coeffBase + 1]).toBeCloseTo(poly[1] / 8_388_608, 6);
        expect(packed[coeffBase + 2]).toBeCloseTo(poly[2] / 8_388_608, 6);
      }
    }
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
