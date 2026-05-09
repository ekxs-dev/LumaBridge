import wasmUrl from '../wasm/lumabridge_wasm/lumabridge_wasm_bg.wasm?url';
import initWasm, { initSync, parseRpuMetadataPacked } from '../wasm/lumabridge_wasm/lumabridge_wasm';
import { COMPACT_DOVI_FLOAT32_COUNT, createIdentityDoviMetadata, packCompactDoviMetadata } from './metadata';

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
  wasmReady ??= initWasm(wasmUrl).then(() => undefined);
  return wasmReady;
}

export function initRpuMetadataWasmSync(wasmBytes: BufferSource): void {
  initSync(wasmBytes);
  wasmReady = Promise.resolve();
}

function probeFromPacked(packed: Float32Array, elapsedMs: number, source: RpuMetadataSource, error: string | null): RpuMetadataProbe {
  return {
    attempted: source === 'wasm',
    ok: error == null,
    source,
    elapsedMs,
    float32Count: packed.length,
    sourceMinPq: packed.length > 28 ? packed[28] : null,
    sourceMaxPq: packed.length > 29 ? packed[29] : null,
    nonlinearOffset: packed.length >= 3 ? [packed[0], packed[1], packed[2]] : null,
    firstPolyCoeffs: packed.length > 62 ? [packed[60], packed[61], packed[62]] : null,
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
