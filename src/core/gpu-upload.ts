import type { I420P10Frame } from './raw-frame';

export interface GpuFrameParams {
  width: number;
  height: number;
  yStride: number;
  uvStride: number;
  range: 0 | 1;
}

export interface I420P10GpuUpload {
  yPlane: Uint32Array;
  uPlane: Uint32Array;
  vPlane: Uint32Array;
  frameParams: GpuFrameParams;
  storageByteLength: number;
}

function readU16LE(data: Uint8Array, sampleIndex: number): number {
  const byteOffset = sampleIndex * 2;
  return data[byteOffset] | (data[byteOffset + 1] << 8);
}

function copyPlaneToU32(frame: I420P10Frame, sourceOffset: number, stride: number, width: number, height: number): Uint32Array {
  const plane = new Uint32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      plane[y * width + x] = readU16LE(frame.data, sourceOffset + y * stride + x) & 0x03ff;
    }
  }
  return plane;
}

export function buildI420P10GpuUpload(frame: I420P10Frame): I420P10GpuUpload {
  const chromaWidth = Math.ceil(frame.width / 2);
  const chromaHeight = Math.ceil(frame.height / 2);
  const yPlane = copyPlaneToU32(frame, frame.yOffset, frame.yStride, frame.width, frame.height);
  const uPlane = copyPlaneToU32(frame, frame.uOffset, frame.uvStride, chromaWidth, chromaHeight);
  const vPlane = copyPlaneToU32(frame, frame.vOffset, frame.uvStride, chromaWidth, chromaHeight);

  return {
    yPlane,
    uPlane,
    vPlane,
    frameParams: {
      width: frame.width,
      height: frame.height,
      yStride: frame.width,
      uvStride: chromaWidth,
      range: frame.range === 'full' ? 0 : 1,
    },
    storageByteLength: yPlane.byteLength + uPlane.byteLength + vPlane.byteLength,
  };
}
