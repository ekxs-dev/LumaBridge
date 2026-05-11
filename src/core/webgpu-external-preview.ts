import shaderSource from '../gpu/external-video-to-sdr.wgsl?raw';

import type { Mp4VideoTrack } from './mp4';
import {
  buildVideoDecoderConfig,
  createEncodedVideoChunk,
  findDecodeStartSampleIndex,
  findSupportedVideoDecoderConfig,
  sampleTimestampUs,
  uniqueCodecCandidates,
} from './webcodecs';

export interface WebGpuExternalPreviewStats {
  attempted: boolean;
  ok: boolean;
  codec: string | null;
  decodedFrames: number;
  drawnFrames: number;
  elapsedMs: number;
  averageDecodeMs: number | null;
  effectiveFps: number;
  requestedStartSeconds: number;
  firstDrawnTimestampUs: number | null;
  lastTimestampUs: number | null;
  format: string | null;
  colorSpace: Record<string, unknown> | null;
  width: number | null;
  height: number | null;
  presentationMode: 'realtime' | 'fast';
  error: string | null;
}

interface GpuCanvasContextLike {
  configure(descriptor: {
    device: GpuDeviceLike;
    format: string;
    alphaMode?: 'opaque' | 'premultiplied';
  }): void;
  getCurrentTexture(): { createView(): unknown };
}

interface GpuDeviceLike {
  queue: {
    submit(commands: unknown[]): void;
    onSubmittedWorkDone(): Promise<void>;
  };
  createBindGroup(descriptor: { layout: unknown; entries: Array<{ binding: number; resource: unknown }> }): unknown;
  createCommandEncoder(): GpuCommandEncoderLike;
  createRenderPipeline(descriptor: {
    layout: 'auto';
    vertex: { module: unknown; entryPoint: string };
    fragment: { module: unknown; entryPoint: string; targets: Array<{ format: string }> };
    primitive: { topology: 'triangle-list' };
  }): { getBindGroupLayout(index: number): unknown };
  createSampler(descriptor: { magFilter: 'linear'; minFilter: 'linear' }): unknown;
  createShaderModule(descriptor: { code: string }): unknown;
  importExternalTexture(descriptor: { source: VideoFrame; colorSpace?: PredefinedColorSpace }): unknown;
  destroy(): void;
}

interface GpuCommandEncoderLike {
  beginRenderPass(descriptor: {
    colorAttachments: Array<{
      view: unknown;
      clearValue: { r: number; g: number; b: number; a: number };
      loadOp: 'clear' | 'load';
      storeOp: 'store' | 'discard';
    }>;
  }): GpuRenderPassLike;
  finish(): unknown;
}

interface GpuRenderPassLike {
  draw(vertexCount: number): void;
  end(): void;
  setBindGroup(index: number, bindGroup: unknown): void;
  setPipeline(pipeline: unknown): void;
}

interface GpuAdapterLike {
  requestDevice(): Promise<GpuDeviceLike>;
}

interface GpuNavigatorLike {
  getPreferredCanvasFormat(): string;
  requestAdapter(): Promise<GpuAdapterLike | null>;
}

function baseStats(startedAt: number, codec: string | null): WebGpuExternalPreviewStats {
  return {
    attempted: true,
    ok: false,
    codec,
    decodedFrames: 0,
    drawnFrames: 0,
    elapsedMs: performance.now() - startedAt,
    averageDecodeMs: null,
    effectiveFps: 0,
    requestedStartSeconds: 0,
    firstDrawnTimestampUs: null,
    lastTimestampUs: null,
    format: null,
    colorSpace: null,
    width: null,
    height: null,
    presentationMode: 'realtime',
    error: null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function renderWebCodecsExternalTexturePreview(
  fileBytes: Uint8Array,
  track: Mp4VideoTrack,
  canvas: HTMLCanvasElement,
  options: {
    maxFrames?: number;
    maxSeconds?: number;
    startSeconds?: number;
    realtime?: boolean;
  } = {},
): Promise<WebGpuExternalPreviewStats> {
  const startedAt = performance.now();
  const codec = track.hevcConfig?.codecString ?? null;
  const requestedStartSeconds = Math.max(0, Number.isFinite(options.startSeconds) ? options.startSeconds ?? 0 : 0);
  const requestedStartTimestampUs = Math.round(requestedStartSeconds * 1_000_000);
  if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') {
    return { ...baseStats(startedAt, codec), requestedStartSeconds, error: 'WebCodecs VideoDecoder is unavailable.' };
  }
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
    return { ...baseStats(startedAt, codec), requestedStartSeconds, error: 'WebGPU is unavailable in this environment.' };
  }
  if (!track.hevcConfig) {
    return { ...baseStats(startedAt, codec), requestedStartSeconds, error: 'Missing hvcC decoder description.' };
  }

  const config = buildVideoDecoderConfig(track);
  let supportedConfig: VideoDecoderConfig | null = null;
  try {
    supportedConfig = await findSupportedVideoDecoderConfig(config);
  } catch (error) {
    return { ...baseStats(startedAt, codec), requestedStartSeconds, error: error instanceof Error ? error.message : String(error) };
  }
  if (!supportedConfig) {
    return {
      ...baseStats(startedAt, codec),
      requestedStartSeconds,
      error: `VideoDecoder does not support any HEVC candidate: ${uniqueCodecCandidates(config.codec).join(', ')}.`,
    };
  }

  const gpu = (navigator as Navigator & { gpu: GpuNavigatorLike }).gpu;
  const adapter = await gpu.requestAdapter();
  if (!adapter) {
    return { ...baseStats(startedAt, supportedConfig.codec), requestedStartSeconds, error: 'WebGPU adapter request returned null.' };
  }

  let device: GpuDeviceLike | null = null;
  try {
    device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu') as GpuCanvasContextLike | null;
    if (!context) {
      return { ...baseStats(startedAt, supportedConfig.codec), requestedStartSeconds, error: 'WebGPU canvas context is unavailable.' };
    }

    const format = gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    const shaderModule = device.createShaderModule({ code: shaderSource });
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: shaderModule, entryPoint: 'vertex_main' },
      fragment: { module: shaderModule, entryPoint: 'fragment_main', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    const realtime = options.realtime ?? true;
    const maxFrames = Math.max(1, Math.floor(options.maxFrames ?? 720));
    const maxDurationUs = Math.max(1, (options.maxSeconds ?? 30) * 1_000_000);
    let decodedFrames = 0;
    let drawnFrames = 0;
    let firstTimestampUs: number | null = null;
    let firstDrawnTimestampUs: number | null = null;
    let lastTimestampUs: number | null = null;
    let firstOutputAt: number | null = null;
    let lastOutputAt: number | null = null;
    let firstPresentationAt: number | null = null;
    let lastPresentationAt: number | null = null;
    let formatLabel: string | null = null;
    let colorSpace: Record<string, unknown> | null = null;
    let width: number | null = null;
    let height: number | null = null;
    let decoderError: string | null = null;
    let stopDecoding = false;
    let pendingPresentation = Promise.resolve();
    let queuedFrames = 0;

    const drawFrame = (frame: VideoFrame) => {
      if (drawnFrames === 0) {
        width = frame.displayWidth || frame.codedWidth;
        height = frame.displayHeight || frame.codedHeight;
        canvas.width = width;
        canvas.height = height;
      }

      const externalTexture = device!.importExternalTexture({ source: frame, colorSpace: 'srgb' });
      const bindGroup = device!.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: externalTexture },
          { binding: 1, resource: sampler },
        ],
      });
      const commandEncoder = device!.createCommandEncoder();
      const pass = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
      device!.queue.submit([commandEncoder.finish()]);
      drawnFrames += 1;
    };

    const presentFrame = async (frame: VideoFrame) => {
      firstPresentationAt ??= performance.now();
      const presentationBaseTimestampUs = firstDrawnTimestampUs ?? firstTimestampUs;
      if (realtime && presentationBaseTimestampUs != null) {
        const relativeMs = Math.max(0, (frame.timestamp - presentationBaseTimestampUs) / 1000);
        const dueAt = firstPresentationAt + relativeMs;
        const delayMs = dueAt - performance.now();
        if (delayMs > 1) await sleep(delayMs);
      }

      try {
        drawFrame(frame);
        lastPresentationAt = performance.now();
      } catch (error) {
        decoderError = error instanceof Error ? error.message : String(error);
        stopDecoding = true;
      } finally {
        frame.close();
        queuedFrames = Math.max(0, queuedFrames - 1);
      }
    };

    const decoder = new VideoDecoder({
      output: (frame) => {
        decodedFrames += 1;
        const outputAt = performance.now();
        firstOutputAt ??= outputAt;
        lastOutputAt = outputAt;
        firstTimestampUs ??= frame.timestamp;
        lastTimestampUs = frame.timestamp;
        formatLabel ??= frame.format;
        colorSpace ??= (frame.colorSpace?.toJSON?.() as Record<string, unknown> | undefined) ?? null;

        if (frame.timestamp < requestedStartTimestampUs) {
          frame.close();
          return;
        }
        firstDrawnTimestampUs ??= frame.timestamp;

        queuedFrames += 1;
        pendingPresentation = pendingPresentation.then(() => presentFrame(frame));

        if (
          drawnFrames + queuedFrames >= maxFrames
          || (firstDrawnTimestampUs != null && frame.timestamp - firstDrawnTimestampUs >= maxDurationUs)
        ) {
          stopDecoding = true;
        }
      },
      error: (error) => {
        decoderError = error.message;
      },
    });

    try {
      decoder.configure(supportedConfig);
      const startSampleIndex = findDecodeStartSampleIndex(track, requestedStartTimestampUs);
      for (const sample of track.samples.slice(startSampleIndex)) {
        if (stopDecoding) break;
        const sampleTimestamp = sampleTimestampUs(sample, track.timescale);
        if (sampleTimestamp >= requestedStartTimestampUs + maxDurationUs && decodedFrames > 0) {
          break;
        }
        decoder.decode(createEncodedVideoChunk(fileBytes, sample, track));
        while (!stopDecoding && (decoder.decodeQueueSize > 16 || queuedFrames > 4)) {
          await sleep(4);
        }
      }
      await decoder.flush();
      await pendingPresentation;
      await device.queue.onSubmittedWorkDone();
    } catch (error) {
      decoderError = error instanceof Error ? error.message : String(error);
    } finally {
      decoder.close();
    }

    const elapsedMs = performance.now() - startedAt;
    const outputElapsedMs = firstPresentationAt != null && lastPresentationAt != null
      ? Math.max(1, lastPresentationAt - firstPresentationAt)
      : firstOutputAt != null && lastOutputAt != null
        ? Math.max(1, lastOutputAt - firstOutputAt)
      : elapsedMs;
    return {
      attempted: true,
      ok: drawnFrames > 0 && !decoderError,
      codec: supportedConfig.codec,
      decodedFrames,
      drawnFrames,
      elapsedMs,
      averageDecodeMs: decodedFrames > 0 ? elapsedMs / decodedFrames : null,
      effectiveFps: drawnFrames > 1 ? ((drawnFrames - 1) * 1000) / outputElapsedMs : 0,
      requestedStartSeconds,
      firstDrawnTimestampUs,
      lastTimestampUs,
      format: formatLabel,
      colorSpace,
      width,
      height,
      presentationMode: realtime ? 'realtime' : 'fast',
      error: decoderError,
    };
  } catch (error) {
    return { ...baseStats(startedAt, supportedConfig.codec), requestedStartSeconds, error: error instanceof Error ? error.message : String(error) };
  } finally {
    device?.destroy();
  }
}
