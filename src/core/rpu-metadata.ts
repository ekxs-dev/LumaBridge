import wasmUrl from '../wasm/tonebridge_wasm/tonebridge_wasm_bg.wasm?url';
import initWasm, { initSync, parseRpuMetadataPacked } from '../wasm/tonebridge_wasm/tonebridge_wasm';
import { COMPACT_DOVI_FLOAT32_COUNT, COMPACT_DOVI_LAYOUT, createIdentityDoviMetadata, packCompactDoviMetadata } from './metadata';

let wasmReady: Promise<void> | null = null;

export type RpuMetadataSource = 'wasm' | 'identity';

export interface RpuMetadataProbe {
  attempted: boolean;
  ok: boolean;
  source: RpuMetadataSource;
  elapsedMs: number;
  float32Count: number;
  sourceMinPq: number | null;
  sourceMaxPq: number | null;
  level1MaxPq: number | null;
  level1AvgPq: number | null;
  nonlinearOffset: [number, number, number] | null;
  firstPolyCoeffs: [number, number, number] | null;
  error: string | null;
}

export interface RpuMetadataParseResult {
  probe: RpuMetadataProbe;
  packed: Float32Array;
}

function identityPacked(): Float32Array {
  return new Float32Array(packCompactDoviMetadata(createIdentityDoviMetadata()));
}

function ensureWasm(): Promise<void> {
  wasmReady ??= initWasm({ module_or_path: wasmUrl }).then(() => undefined);
  return wasmReady;
}

export function initRpuMetadataWasmSync(wasmBytes: BufferSource): void {
  initSync({ module: wasmBytes });
  wasmReady = Promise.resolve();
}

function probeFromPacked(packed: Float32Array, elapsedMs: number, source: RpuMetadataSource, error: string | null): RpuMetadataProbe {
  return {
    attempted: source === 'wasm',
    ok: error == null,
    source,
    elapsedMs,
    float32Count: packed.length,
    sourceMinPq: packed.length > COMPACT_DOVI_LAYOUT.sourcePq ? packed[COMPACT_DOVI_LAYOUT.sourcePq] : null,
    sourceMaxPq: packed.length > COMPACT_DOVI_LAYOUT.sourcePq + 1 ? packed[COMPACT_DOVI_LAYOUT.sourcePq + 1] : null,
    level1MaxPq: packed.length > COMPACT_DOVI_LAYOUT.sourcePq + 2 ? packed[COMPACT_DOVI_LAYOUT.sourcePq + 2] : null,
    level1AvgPq: packed.length > COMPACT_DOVI_LAYOUT.sourcePq + 3 ? packed[COMPACT_DOVI_LAYOUT.sourcePq + 3] : null,
    nonlinearOffset: packed.length >= 3 ? [packed[0], packed[1], packed[2]] : null,
    firstPolyCoeffs: packed.length > COMPACT_DOVI_LAYOUT.polyCoeffs + 2
      ? [
        packed[COMPACT_DOVI_LAYOUT.polyCoeffs],
        packed[COMPACT_DOVI_LAYOUT.polyCoeffs + 1],
        packed[COMPACT_DOVI_LAYOUT.polyCoeffs + 2],
      ]
      : null,
    error,
  };
}

export async function parseRpuMetadataForShader(rpuPayload: Uint8Array | null): Promise<RpuMetadataParseResult> {
  const startedAt = performance.now();
  const fallback = identityPacked();

  if (!rpuPayload) {
    return {
      packed: fallback,
      probe: probeFromPacked(fallback, 0, 'identity', 'No RPU payload is available for the selected frame.'),
    };
  }

  try {
    await ensureWasm();
    const packed = parseRpuMetadataPacked(rpuPayload);
    if (packed.length !== COMPACT_DOVI_FLOAT32_COUNT) {
      throw new Error(`RPU metadata ABI mismatch: expected ${COMPACT_DOVI_FLOAT32_COUNT} f32 values, got ${packed.length}.`);
    }
    return {
      packed,
      probe: probeFromPacked(packed, performance.now() - startedAt, 'wasm', null),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      packed: fallback,
      probe: probeFromPacked(fallback, performance.now() - startedAt, 'identity', message),
    };
  }
}
