export interface FrameMetadata {
  timestamp: number;
  poc: number;
  rpuIndex: number;
}

export function metadataForTimestamp(frames: FrameMetadata[], timestamp: number): FrameMetadata | null {
  return frames.find((frame) => frame.timestamp === timestamp) ?? null;
}

export function sortByDisplayTimestamp(frames: FrameMetadata[]): FrameMetadata[] {
  return [...frames].sort((a, b) => a.timestamp - b.timestamp);
}

export function sortByPoc(frames: FrameMetadata[]): FrameMetadata[] {
  return [...frames].sort((a, b) => a.poc - b.poc);
}

export interface DoviCompactMetadata {
  nonlinearOffset: [number, number, number];
  nonlinearMatrix: number[];
  linearMatrix: number[];
  sourceMinPq: number;
  sourceMaxPq: number;
  pivots: number[];
  polyCoeffs: number[];
  mmrCoeffs: number[];
}

export const COMPACT_DOVI_FLOAT32_COUNT = 256;

export function packCompactDoviMetadata(metadata: DoviCompactMetadata): ArrayBuffer {
  const floats = new Float32Array(COMPACT_DOVI_FLOAT32_COUNT);
  let offset = 0;
  floats.set(metadata.nonlinearOffset, offset);
  offset += 4;
  floats.set(metadata.nonlinearMatrix.slice(0, 9), offset);
  offset += 12;
  floats.set(metadata.linearMatrix.slice(0, 9), offset);
  offset += 12;
  floats[offset++] = metadata.sourceMinPq;
  floats[offset++] = metadata.sourceMaxPq;
  offset += 2;
  floats.set(metadata.pivots.slice(0, 27), offset);
  offset += 28;
  floats.set(metadata.polyCoeffs.slice(0, 72), offset);
  offset += 72;
  floats.set(metadata.mmrCoeffs.slice(0, COMPACT_DOVI_FLOAT32_COUNT - offset), offset);
  return floats.buffer;
}

export function createIdentityDoviMetadata(): DoviCompactMetadata {
  return {
    nonlinearOffset: [0, 0, 0],
    nonlinearMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    linearMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    sourceMinPq: 0,
    sourceMaxPq: 1,
    pivots: [0, 1],
    polyCoeffs: [0, 1, 0],
    mmrCoeffs: [],
  };
}
