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

const CHANNELS = ['r', 'g', 'b'] as const;

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
      const error = Math.abs(preview.data[offset + channel] - reference.data[offset + channel]);
      total += error;
      channelTotals[channel] += error;
      if (error > outlierThreshold) pixelIsOutlier = true;
      if (error > maxAbsError) {
        maxAbsError = error;
        maxAbsPixel = {
          x: pixel % preview.width,
          y: Math.floor(pixel / preview.width),
          channel: CHANNELS[channel],
          output: preview.data[offset + channel],
          reference: reference.data[offset + channel],
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
    maxAbsError,
    maxAbsPixel,
    outlierThreshold,
    outlierPixels,
  };
}
