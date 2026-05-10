import type { SdrPreviewImage } from './raw-frame';

export interface ReferenceImage {
  name: string;
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface PixelErrorStats {
  referenceName: string;
  width: number;
  height: number;
  comparedPixels: number;
  meanAbsError: number;
  meanRgbAbsError: [number, number, number];
  meanRgbSignedError: [number, number, number];
  outputAverageRgb: [number, number, number];
  referenceAverageRgb: [number, number, number];
  maxAbsError: number;
  maxAbsPixel: {
    x: number;
    y: number;
    channel: 'r' | 'g' | 'b';
    output: number;
    reference: number;
  };
  outlierThreshold: number;
  outlierPixels: number;
}

export interface ReferenceCompareContext {
  previewMode?: string | null;
  renderer?: string | null;
  metadataSource?: string | null;
  rpuAlignment?: 'parsed-sample' | 'ffmpeg-packet-probe' | 'unresolved' | null;
}

export interface ReferenceGapDiagnosis {
  severity: 'matched' | 'small' | 'visible' | 'large';
  summary: string;
  likelyCauses: string[];
  nextChecks: string[];
}

const CHANNELS = ['r', 'g', 'b'] as const;

function gapSeverity(meanAbsError: number): ReferenceGapDiagnosis['severity'] {
  if (meanAbsError < 2) return 'matched';
  if (meanAbsError < 6) return 'small';
  if (meanAbsError < 12) return 'visible';
  return 'large';
}

function formatBias(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
}

export function diagnoseReferenceGap(
  stats: PixelErrorStats,
  context: ReferenceCompareContext = {},
): ReferenceGapDiagnosis {
  const severity = gapSeverity(stats.meanAbsError);
  const [biasR, biasG, biasB] = stats.meanRgbSignedError;
  const likelyCauses: string[] = [];
  const nextChecks: string[] = [];

  if (context.previewMode && context.previewMode !== 'sdr-approx') {
    likelyCauses.push(`Preview mode is ${context.previewMode}; only the RPU SDR mode should be compared to libplacebo.`);
  }
  if (context.renderer === 'cpu') {
    likelyCauses.push('CPU fallback preview does not apply packed RPU metadata and is only a structural diagnostic.');
  }
  if (context.metadataSource !== 'rpu-packed') {
    likelyCauses.push('RPU metadata was not applied to the current WebGPU render.');
  }
  if (context.rpuAlignment === 'ffmpeg-packet-probe') {
    likelyCauses.push('Selected-time RPU came from an ffmpeg packet probe, so frame/RPU PTS alignment is still approximate for prefix-miss MKV seeks.');
    nextChecks.push('Implement streaming MKV demux so the decoded raw frame and RPU are selected from the same access unit.');
  }

  if (biasR < -3 && biasG > 3 && biasB > 3) {
    likelyCauses.push('Output is biased cyan/blue-green relative to the reference, which points at DV reshape, matrix order, gamut mapping, or chroma siting rather than a simple exposure error.');
    nextChecks.push('Compare intermediate images after reshape and after DV matrix/PQ decode against a CPU/libplacebo reference.');
  } else if (biasR > 3 && biasG < -3 && biasB < -3) {
    likelyCauses.push('Output is biased red relative to the reference, which usually means a channel matrix or chroma interpretation mismatch.');
    nextChecks.push('Verify nonlinear matrix rows, chroma plane order, and chroma siting.');
  } else if (biasR > 3 && biasG > 3 && biasB > 3) {
    likelyCauses.push('Output is brighter than the reference across channels, which points at tone-map peak/source metadata mismatch.');
    nextChecks.push('Check source max PQ, Level 1 max PQ, and libplacebo tone-map parameters.');
  } else if (biasR < -3 && biasG < -3 && biasB < -3) {
    likelyCauses.push('Output is darker than the reference across channels, which points at tone-map peak/source metadata mismatch.');
    nextChecks.push('Check source max PQ, Level 1 max PQ, and target 100 nit scaling.');
  }

  if (stats.meanAbsError >= 6) {
    likelyCauses.push('WGSL tone/gamut mapping is still a simplified diagnostic path, not a full libplacebo color-map implementation.');
    nextChecks.push('Port libplacebo-style IPT tone/gamut mapping and validate it with fixed numeric vectors.');
  }
  if (stats.outlierPixels / Math.max(1, stats.comparedPixels) > 0.05) {
    likelyCauses.push('Many pixels exceed the outlier threshold; chroma siting, spatial scaling, or frame mismatch may be contributing.');
    nextChecks.push('Compare at native size or use the same scaler/chroma location as the reference command.');
  }
  if (likelyCauses.length === 0) {
    likelyCauses.push('Difference is within the current diagnostic tolerance; remaining error is likely rounding, scaling, or reference encode differences.');
  }
  if (nextChecks.length === 0) {
    nextChecks.push('Keep this reference as a golden sample and verify several timestamps before tightening thresholds.');
  }

  return {
    severity,
    summary: `${severity} gap: MAE ${stats.meanAbsError.toFixed(2)}, bias RGB ${formatBias(biasR)}, ${formatBias(biasG)}, ${formatBias(biasB)}.`,
    likelyCauses,
    nextChecks,
  };
}

export function comparePreviewToReference(
  preview: SdrPreviewImage,
  reference: ReferenceImage,
  outlierThreshold = 12,
): PixelErrorStats {
  if (preview.width !== reference.width || preview.height !== reference.height) {
    throw new Error(`Reference dimensions ${reference.width}x${reference.height} do not match preview ${preview.width}x${preview.height}.`);
  }

  let total = 0;
  const channelTotals: [number, number, number] = [0, 0, 0];
  const signedTotals: [number, number, number] = [0, 0, 0];
  const outputTotals: [number, number, number] = [0, 0, 0];
  const referenceTotals: [number, number, number] = [0, 0, 0];
  let maxAbsError = -1;
  let maxAbsPixel: PixelErrorStats['maxAbsPixel'] = {
    x: 0,
    y: 0,
    channel: 'r',
    output: 0,
    reference: 0,
  };
  let outlierPixels = 0;
  const comparedPixels = preview.width * preview.height;

  for (let pixel = 0; pixel < comparedPixels; pixel += 1) {
    const offset = pixel * 4;
    let pixelIsOutlier = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const output = preview.data[offset + channel];
      const expected = reference.data[offset + channel];
      const signedError = output - expected;
      const error = Math.abs(signedError);
      total += error;
      channelTotals[channel] += error;
      signedTotals[channel] += signedError;
      outputTotals[channel] += output;
      referenceTotals[channel] += expected;
      if (error > outlierThreshold) pixelIsOutlier = true;
      if (error > maxAbsError) {
        maxAbsError = error;
        maxAbsPixel = {
          x: pixel % preview.width,
          y: Math.floor(pixel / preview.width),
          channel: CHANNELS[channel],
          output,
          reference: expected,
        };
      }
    }
    if (pixelIsOutlier) outlierPixels += 1;
  }

  return {
    referenceName: reference.name,
    width: preview.width,
    height: preview.height,
    comparedPixels,
    meanAbsError: total / (comparedPixels * 3),
    meanRgbAbsError: [
      channelTotals[0] / comparedPixels,
      channelTotals[1] / comparedPixels,
      channelTotals[2] / comparedPixels,
    ],
    meanRgbSignedError: [
      signedTotals[0] / comparedPixels,
      signedTotals[1] / comparedPixels,
      signedTotals[2] / comparedPixels,
    ],
    outputAverageRgb: [
      outputTotals[0] / comparedPixels,
      outputTotals[1] / comparedPixels,
      outputTotals[2] / comparedPixels,
    ],
    referenceAverageRgb: [
      referenceTotals[0] / comparedPixels,
      referenceTotals[1] / comparedPixels,
      referenceTotals[2] / comparedPixels,
    ],
    maxAbsError,
    maxAbsPixel,
    outlierThreshold,
    outlierPixels,
  };
}
