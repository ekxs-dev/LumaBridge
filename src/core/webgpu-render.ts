import shaderSource from '../gpu/dv-p5-to-sdr.wgsl?raw';
import type { I420P10GpuUpload } from './gpu-upload';
import { createIdentityDoviMetadata, packCompactDoviMetadata } from './metadata';
import type { RawPreviewMode, SdrPreviewImage } from './raw-frame';

interface GpuBufferLike {
  destroy(): void;
  getMappedRange(): ArrayBuffer;
  mapAsync(mode: number): Promise<void>;
  unmap(): void;
}

interface GpuComputePassLike {
  dispatchWorkgroups(x: number, y: number): void;
  end(): void;
  setBindGroup(index: number, bindGroup: unknown): void;
  setPipeline(pipeline: unknown): void;
}

interface GpuCommandEncoderLike {
  beginComputePass(): GpuComputePassLike;
  copyBufferToBuffer(source: GpuBufferLike, sourceOffset: number, destination: GpuBufferLike, destinationOffset: number, size: number): void;
  finish(): unknown;
}

interface GpuDeviceLike {
  queue: {
    submit(commands: unknown[]): void;
    writeBuffer(buffer: GpuBufferLike, offset: number, data: ArrayBufferLike, dataOffset: number, size: number): void;
    onSubmittedWorkDone(): Promise<void>;
  };
  createBindGroup(descriptor: { layout: unknown; entries: Array<{ binding: number; resource: { buffer: GpuBufferLike } }> }): unknown;
  createBuffer(descriptor: { size: number; usage: number }): GpuBufferLike;
  createCommandEncoder(): GpuCommandEncoderLike;
  createComputePipeline(descriptor: { layout: 'auto'; compute: { module: unknown; entryPoint: string } }): { getBindGroupLayout(index: number): unknown };
  createShaderModule(descriptor: { code: string }): unknown;
  destroy(): void;
}

interface GpuAdapterLike {
  requestDevice(): Promise<GpuDeviceLike>;
}

interface GpuNavigatorLike {
  requestAdapter(): Promise<GpuAdapterLike | null>;
}

export interface WebGpuSdrRenderProbe {
  attempted: boolean;
  ok: boolean;
  elapsedMs: number;
  uploadElapsedMs: number;
  shaderElapsedMs: number;
  readbackElapsedMs: number;
  bytes: number;
  width: number | null;
  height: number | null;
  mode: RawPreviewMode | null;
  metadataSource: 'identity' | 'rpu-packed';
  averageRgb: [number, number, number] | null;
  nonBlackPixels: number | null;
  error: string | null;
}

export interface WebGpuSdrRenderResult {
  probe: WebGpuSdrRenderProbe;
  preview: SdrPreviewImage | null;
}

export interface WebGpuSdrRenderOptions {
  doviMetadata?: Float32Array;
}

function emptyProbe(error: string): WebGpuSdrRenderResult {
  return {
    probe: {
      attempted: false,
      ok: false,
      elapsedMs: 0,
      uploadElapsedMs: 0,
      shaderElapsedMs: 0,
      readbackElapsedMs: 0,
      bytes: 0,
      width: null,
      height: null,
      mode: null,
      metadataSource: 'identity',
      averageRgb: null,
      nonBlackPixels: null,
      error,
    },
    preview: null,
  };
}

function writeBuffer(device: GpuDeviceLike, buffer: GpuBufferLike, data: Uint32Array | Uint8Array): void {
  device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
}

function createAndWriteBuffer(device: GpuDeviceLike, usage: number, data: Uint32Array | Uint8Array): GpuBufferLike {
  const buffer = device.createBuffer({ size: data.byteLength, usage });
  writeBuffer(device, buffer, data);
  return buffer;
}

function computeStats(pixels: Uint8ClampedArray): SdrPreviewImage['stats'] {
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  let nonBlackPixels = 0;
  const pixelCount = pixels.byteLength / 4;
  for (let offset = 0; offset < pixels.byteLength; offset += 4) {
    const r = pixels[offset];
    const g = pixels[offset + 1];
    const b = pixels[offset + 2];
    totalR += r;
    totalG += g;
    totalB += b;
    if (r > 2 || g > 2 || b > 2) nonBlackPixels += 1;
  }
  return {
    averageRgb: [totalR / pixelCount, totalG / pixelCount, totalB / pixelCount],
    nonBlackPixels,
  };
}

export async function renderI420P10SdrWithWebGpu(
  upload: I420P10GpuUpload,
  mode: RawPreviewMode,
  options: WebGpuSdrRenderOptions = {},
): Promise<WebGpuSdrRenderResult> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
    return emptyProbe('WebGPU is unavailable in this environment.');
  }
  const bufferUsage = (globalThis as { GPUBufferUsage?: Record<string, number> }).GPUBufferUsage;
  const mapMode = (globalThis as { GPUMapMode?: Record<string, number> }).GPUMapMode;
  if (!bufferUsage || !mapMode) {
    return emptyProbe('GPUBufferUsage or GPUMapMode is unavailable in this environment.');
  }

  const startedAt = performance.now();
  const width = upload.frameParams.outputWidth;
  const height = upload.frameParams.outputHeight;
  const outputByteLength = width * height * 4;
  const gpu = (navigator as Navigator & { gpu: GpuNavigatorLike }).gpu;
  const buffers: GpuBufferLike[] = [];
  let device: GpuDeviceLike | null = null;
  let readbackMapped = false;

  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      const result = emptyProbe('WebGPU adapter request returned null.');
      return {
        ...result,
        probe: {
          ...result.probe,
          attempted: true,
          elapsedMs: performance.now() - startedAt,
          mode,
        },
      };
    }

    device = await adapter.requestDevice();
    const storageUsage = bufferUsage.STORAGE | bufferUsage.COPY_DST;
    const uniformUsage = bufferUsage.UNIFORM | bufferUsage.COPY_DST;
    const outputUsage = bufferUsage.STORAGE | bufferUsage.COPY_SRC;
    const readbackUsage = bufferUsage.MAP_READ | bufferUsage.COPY_DST;
    const doviMetadata = options.doviMetadata ?? new Float32Array(packCompactDoviMetadata(createIdentityDoviMetadata()));
    const doviUniform = new Uint8Array(doviMetadata.buffer, doviMetadata.byteOffset, doviMetadata.byteLength);

    const yBuffer = createAndWriteBuffer(device, storageUsage, upload.yPlane);
    const uBuffer = createAndWriteBuffer(device, storageUsage, upload.uPlane);
    const vBuffer = createAndWriteBuffer(device, storageUsage, upload.vPlane);
    const frameParamsBuffer = createAndWriteBuffer(device, uniformUsage, upload.frameParamsUniform);
    const doviParamsBuffer = createAndWriteBuffer(device, uniformUsage, doviUniform);
    const outputBuffer = device.createBuffer({ size: outputByteLength, usage: outputUsage });
    const readbackBuffer = device.createBuffer({ size: outputByteLength, usage: readbackUsage });
    buffers.push(yBuffer, uBuffer, vBuffer, frameParamsBuffer, doviParamsBuffer, outputBuffer, readbackBuffer);

    const uploadEndedAt = performance.now();
    const shaderModule = device.createShaderModule({ code: shaderSource });
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: shaderModule, entryPoint: 'main' },
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: yBuffer } },
        { binding: 1, resource: { buffer: uBuffer } },
        { binding: 2, resource: { buffer: vBuffer } },
        { binding: 3, resource: { buffer: frameParamsBuffer } },
        { binding: 4, resource: { buffer: doviParamsBuffer } },
        { binding: 5, resource: { buffer: outputBuffer } },
      ],
    });

    const commandEncoder = device.createCommandEncoder();
    const pass = commandEncoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    commandEncoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, outputByteLength);

    const shaderStartedAt = performance.now();
    device.queue.submit([commandEncoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    const shaderEndedAt = performance.now();

    const readbackStartedAt = performance.now();
    await readbackBuffer.mapAsync(mapMode.READ);
    readbackMapped = true;
    const mapped = readbackBuffer.getMappedRange();
    const pixels = new Uint8ClampedArray(outputByteLength);
    pixels.set(new Uint8Array(mapped, 0, outputByteLength));
    readbackBuffer.unmap();
    readbackMapped = false;
    const endedAt = performance.now();
    const stats = computeStats(pixels);

    return {
      probe: {
        attempted: true,
        ok: true,
        elapsedMs: endedAt - startedAt,
        uploadElapsedMs: uploadEndedAt - startedAt,
        shaderElapsedMs: shaderEndedAt - shaderStartedAt,
        readbackElapsedMs: endedAt - readbackStartedAt,
        bytes: upload.totalByteLength + doviUniform.byteLength + outputByteLength * 2,
        width,
        height,
        mode,
        metadataSource: options.doviMetadata ? 'rpu-packed' : 'identity',
        averageRgb: stats.averageRgb,
        nonBlackPixels: stats.nonBlackPixels,
        error: null,
      },
      preview: {
        width,
        height,
        data: pixels,
        stats,
      },
    };
  } catch (error) {
    return {
      probe: {
        attempted: true,
        ok: false,
        elapsedMs: performance.now() - startedAt,
        uploadElapsedMs: 0,
        shaderElapsedMs: 0,
        readbackElapsedMs: 0,
        bytes: 0,
        width,
        height,
        mode,
        metadataSource: options.doviMetadata ? 'rpu-packed' : 'identity',
        averageRgb: null,
        nonBlackPixels: null,
        error: error instanceof Error ? error.message : String(error),
      },
      preview: null,
    };
  } finally {
    if (readbackMapped) buffers.at(-1)?.unmap();
    for (const buffer of buffers) buffer.destroy();
    device?.destroy();
  }
}
