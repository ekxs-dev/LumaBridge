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
  level1MaxPq: number;
  level1AvgPq: number;
  reshapeHeader: [number, number, number, number];
  pivots: number[];
  pieceMeta: number[];
  polyCoeffs: number[];
  mmrCoeffs: number[];
}

export const COMPACT_DOVI_LAYOUT = {
  nonlinearOffset: 0,
  nonlinearMatrix: 4,
  linearMatrix: 16,
  sourcePq: 28,
  reshapeHeader: 32,
  pivots: 36,
  pieceMeta: 72,
  polyCoeffs: 168,
  mmrCoeffs: 264,
  float32Count: 840,
} as const;

export const COMPACT_DOVI_FLOAT32_COUNT = COMPACT_DOVI_LAYOUT.float32Count;

function packVec4Rows(floats: Float32Array, offset: number, values: number[], rowCount: number, rowWidth: number): void {
  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < rowWidth; column += 1) {
      floats[offset + row * 4 + column] = values[row * rowWidth + column] ?? 0;
    }
  }
}

export function packCompactDoviMetadata(metadata: DoviCompactMetadata): ArrayBuffer {
  const floats = new Float32Array(COMPACT_DOVI_FLOAT32_COUNT);
  floats.set(metadata.nonlinearOffset, COMPACT_DOVI_LAYOUT.nonlinearOffset);
  packVec4Rows(floats, COMPACT_DOVI_LAYOUT.nonlinearMatrix, metadata.nonlinearMatrix, 3, 3);
  packVec4Rows(floats, COMPACT_DOVI_LAYOUT.linearMatrix, metadata.linearMatrix, 3, 3);
  floats[COMPACT_DOVI_LAYOUT.sourcePq] = metadata.sourceMinPq;
  floats[COMPACT_DOVI_LAYOUT.sourcePq + 1] = metadata.sourceMaxPq;
  floats[COMPACT_DOVI_LAYOUT.sourcePq + 2] = metadata.level1MaxPq;
  floats[COMPACT_DOVI_LAYOUT.sourcePq + 3] = metadata.level1AvgPq;
  floats.set(metadata.reshapeHeader, COMPACT_DOVI_LAYOUT.reshapeHeader);
  floats.set(metadata.pivots.slice(0, 36), COMPACT_DOVI_LAYOUT.pivots);
  floats.set(metadata.pieceMeta.slice(0, 96), COMPACT_DOVI_LAYOUT.pieceMeta);
  floats.set(metadata.polyCoeffs.slice(0, 96), COMPACT_DOVI_LAYOUT.polyCoeffs);
  floats.set(metadata.mmrCoeffs.slice(0, 576), COMPACT_DOVI_LAYOUT.mmrCoeffs);
  return floats.buffer;
}

export function createIdentityDoviMetadata(): DoviCompactMetadata {
  const pivots = new Array(36).fill(0);
  const pieceMeta = new Array(96).fill(0);
  const polyCoeffs = new Array(96).fill(0);
  for (let component = 0; component < 3; component += 1) {
    const pivotBase = component * 12;
    pivots[pivotBase] = 0;
    pivots[pivotBase + 1] = 1;
    const pieceBase = component * 8 * 4;
    pieceMeta[pieceBase] = 0;
    pieceMeta[pieceBase + 3] = 1;
    polyCoeffs[pieceBase] = 0;
    polyCoeffs[pieceBase + 1] = 1;
    polyCoeffs[pieceBase + 2] = 0;
  }

  return {
    nonlinearOffset: [0, 0, 0],
    nonlinearMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    linearMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    sourceMinPq: 0,
    sourceMaxPq: 1,
    level1MaxPq: 0,
    level1AvgPq: 0,
    reshapeHeader: [0, 0, 0, 0],
    pivots,
    pieceMeta,
    polyCoeffs,
    mmrCoeffs: new Array(576).fill(0),
  };
}
