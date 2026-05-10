import type { Mp4Sample, Mp4VideoTrack } from './mp4';
import { validateI420P10CopyLayout, type PlaneLayoutLike } from './video-frame-layout';

export interface EncodedChunkPlan {
  type: EncodedVideoChunkType;
  timestamp: number;
  duration: number;
  byteLength: number;
}

export interface DecodedFrameProbe {
  supported: boolean;
  codec: string | null;
  decodedFrames: number;
  elapsedMs: number;
  format: string | null;
  timestamp: number | null;
  codedWidth: number | null;
  codedHeight: number | null;
  displayWidth: number | null;
  displayHeight: number | null;
  colorSpace: Record<string, unknown> | null;
  copyTo: FrameCopyProbe | null;
  error: string | null;
}

export interface FrameCopyProbe {
  attempted: boolean;
  ok: boolean;
  elapsedMs: number;
  allocationSize: number | null;
  layout: PlaneLayoutLike[];
  error: string | null;
}

export interface WebCodecsCanvasPreviewStats {
  attempted: boolean;
  ok: boolean;
  codec: string | null;
  decodedFrames: number;
  drawnFrames: number;
  elapsedMs: number;
  averageDecodeMs: number | null;
  effectiveFps: number;
  lastTimestampUs: number | null;
  format: string | null;
  colorSpace: Record<string, unknown> | null;
  error: string | null;
}

export function sampleTimestampUs(sample: Mp4Sample, timescale: number): number {
  return Math.round((sample.cts / timescale) * 1_000_000);
}

export function sampleDurationUs(sample: Mp4Sample, timescale: number): number {
  return Math.round((sample.duration / timescale) * 1_000_000);
}

export function buildVideoDecoderConfig(track: Mp4VideoTrack): VideoDecoderConfig {
  if (!track.hevcConfig) {
    throw new Error('HEVC decoder configuration is missing hvcC.');
  }

  return {
    codec: track.hevcConfig.codecString,
    codedWidth: track.width,
    codedHeight: track.height,
    description: track.hevcConfig.description,
    hardwareAcceleration: 'prefer-hardware',
    optimizeForLatency: true,
  };
}

export function uniqueCodecCandidates(codec: string): string[] {
  const candidates = [codec];
  const relaxedConstraint = codec.replace(/\.B[0-9A-Fa-f]+$/, '.B0');
  candidates.push(relaxedConstraint);

  if (codec.startsWith('hev1.')) {
    candidates.push(codec.replace(/^hev1\./, 'hvc1.'));
    candidates.push(relaxedConstraint.replace(/^hev1\./, 'hvc1.'));
  } else if (codec.startsWith('hvc1.')) {
    candidates.push(codec.replace(/^hvc1\./, 'hev1.'));
    candidates.push(relaxedConstraint.replace(/^hvc1\./, 'hev1.'));
  }

  return [...new Set(candidates)];
}

export async function findSupportedVideoDecoderConfig(config: VideoDecoderConfig): Promise<VideoDecoderConfig | null> {
  const codecs = uniqueCodecCandidates(config.codec);
  for (const codec of codecs) {
    const candidate = { ...config, codec };
    const support = await VideoDecoder.isConfigSupported(candidate);
    if (support.supported) return support.config ?? candidate;
  }
  return null;
}

export function planEncodedChunk(sample: Mp4Sample, track: Mp4VideoTrack): EncodedChunkPlan {
  return {
    type: sample.isSync ? 'key' : 'delta',
    timestamp: sampleTimestampUs(sample, track.timescale),
    duration: sampleDurationUs(sample, track.timescale),
    byteLength: sample.size,
  };
}

export function createEncodedVideoChunk(fileBytes: Uint8Array, sample: Mp4Sample, track: Mp4VideoTrack): EncodedVideoChunk {
  const plan = planEncodedChunk(sample, track);
  return new EncodedVideoChunk({
    type: plan.type,
    timestamp: plan.timestamp,
    duration: plan.duration,
    data: fileBytes.slice(sample.offset, sample.offset + sample.size),
  });
}

export const __webcodecsTestHooks = {
  uniqueCodecCandidates,
};

export async function renderWebCodecsCanvasPreview(
  fileBytes: Uint8Array,
  track: Mp4VideoTrack,
  canvas: HTMLCanvasElement,
  options: { maxFrames?: number; maxSeconds?: number } = {},
): Promise<WebCodecsCanvasPreviewStats> {
  const startedAt = performance.now();
  const codec = track.hevcConfig?.codecString ?? null;
  const base = (): WebCodecsCanvasPreviewStats => ({
    attempted: true,
    ok: false,
    codec,
    decodedFrames: 0,
    drawnFrames: 0,
    elapsedMs: performance.now() - startedAt,
    averageDecodeMs: null,
    effectiveFps: 0,
    lastTimestampUs: null,
    format: null,
    colorSpace: null,
    error: null,
  });

  if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') {
    return { ...base(), error: 'WebCodecs VideoDecoder is unavailable.' };
  }
  if (!track.hevcConfig) {
    return { ...base(), error: 'Missing hvcC decoder description.' };
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return { ...base(), error: '2D canvas context is unavailable.' };

  const config = buildVideoDecoderConfig(track);
  let supportedConfig: VideoDecoderConfig | null = null;
  try {
    supportedConfig = await findSupportedVideoDecoderConfig(config);
  } catch (error) {
    return { ...base(), error: error instanceof Error ? error.message : String(error) };
  }
  if (!supportedConfig) {
    return {
      ...base(),
      error: `VideoDecoder does not support any HEVC candidate: ${uniqueCodecCandidates(config.codec).join(', ')}.`,
    };
  }

  const maxFrames = Math.max(1, Math.floor(options.maxFrames ?? 120));
  const maxDurationUs = Math.max(1, (options.maxSeconds ?? 5) * 1_000_000);
  let decodedFrames = 0;
  let drawnFrames = 0;
  let firstTimestampUs: number | null = null;
  let lastTimestampUs: number | null = null;
  let firstOutputAt: number | null = null;
  let lastOutputAt: number | null = null;
  let format: string | null = null;
  let colorSpace: Record<string, unknown> | null = null;
  let decoderError: string | null = null;
  let stopDecoding = false;

  const decoder = new VideoDecoder({
    output: (frame) => {
      decodedFrames += 1;
      firstOutputAt ??= performance.now();
      lastOutputAt = performance.now();
      firstTimestampUs ??= frame.timestamp;
      lastTimestampUs = frame.timestamp;
      format ??= frame.format;
      colorSpace ??= (frame.colorSpace?.toJSON?.() as Record<string, unknown> | undefined) ?? null;
      if (drawnFrames === 0) {
        canvas.width = frame.displayWidth || frame.codedWidth;
        canvas.height = frame.displayHeight || frame.codedHeight;
      }
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      drawnFrames += 1;
      if (
        drawnFrames >= maxFrames
        || (firstTimestampUs != null && frame.timestamp - firstTimestampUs >= maxDurationUs)
      ) {
        stopDecoding = true;
      }
      frame.close();
    },
    error: (error) => {
      decoderError = error.message;
    },
  });

  try {
    decoder.configure(supportedConfig);
    for (const sample of track.samples) {
      if (stopDecoding) break;
      decoder.decode(createEncodedVideoChunk(fileBytes, sample, track));
      if (decoder.decodeQueueSize > 24) {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }
    await decoder.flush();
  } catch (error) {
    decoderError = error instanceof Error ? error.message : String(error);
  } finally {
    decoder.close();
  }

  const elapsedMs = performance.now() - startedAt;
  const outputElapsedMs = firstOutputAt != null && lastOutputAt != null ? Math.max(1, lastOutputAt - firstOutputAt) : elapsedMs;
  return {
    attempted: true,
    ok: drawnFrames > 0 && !decoderError,
    codec: supportedConfig.codec,
    decodedFrames,
    drawnFrames,
    elapsedMs,
    averageDecodeMs: decodedFrames > 0 ? elapsedMs / decodedFrames : null,
    effectiveFps: drawnFrames > 1 ? ((drawnFrames - 1) * 1000) / outputElapsedMs : 0,
    lastTimestampUs,
    format,
    colorSpace,
    error: decoderError,
  };
}

export async function decodeFirstFrameFromMp4Track(
  fileBytes: Uint8Array,
  track: Mp4VideoTrack,
  maxSamples = 12,
): Promise<DecodedFrameProbe> {
  const startedAt = performance.now();
  const codec = track.hevcConfig?.codecString ?? null;
  const baseResult = (): DecodedFrameProbe => ({
    supported: false,
    codec,
    decodedFrames: 0,
    elapsedMs: performance.now() - startedAt,
    format: null,
    timestamp: null,
    codedWidth: null,
    codedHeight: null,
    displayWidth: null,
    displayHeight: null,
    colorSpace: null,
    copyTo: null,
    error: null,
  });

  if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') {
    return { ...baseResult(), error: 'WebCodecs VideoDecoder is unavailable.' };
  }

  if (!track.hevcConfig) {
    return { ...baseResult(), error: 'Missing hvcC decoder description.' };
  }

  const config = buildVideoDecoderConfig(track);
  let supportedConfig: VideoDecoderConfig;
  try {
    const supported = await findSupportedVideoDecoderConfig(config);
    if (!supported) {
      return {
        ...baseResult(),
        codec: config.codec,
        error: `VideoDecoder does not support any HEVC candidate: ${uniqueCodecCandidates(config.codec).join(', ')}.`,
      };
    }
    supportedConfig = supported;
  } catch (error) {
    return { ...baseResult(), codec: config.codec, error: error instanceof Error ? error.message : String(error) };
  }

  let decodedFrames = 0;
  const frameProbes: Pick<
    DecodedFrameProbe,
    'format' | 'timestamp' | 'codedWidth' | 'codedHeight' | 'displayWidth' | 'displayHeight' | 'colorSpace' | 'copyTo'
  >[] = [];
  const copyTasks: Promise<void>[] = [];
  let decoderError: string | null = null;
  const decoder = new VideoDecoder({
    output: (frame) => {
      decodedFrames += 1;
      if (frameProbes.length === 0) {
        const colorSpace = frame.colorSpace?.toJSON?.() as Record<string, unknown> | undefined;
        const probe: Pick<
          DecodedFrameProbe,
          'format' | 'timestamp' | 'codedWidth' | 'codedHeight' | 'displayWidth' | 'displayHeight' | 'colorSpace' | 'copyTo'
        > = {
          format: frame.format,
          timestamp: frame.timestamp,
          codedWidth: frame.codedWidth,
          codedHeight: frame.codedHeight,
          displayWidth: frame.displayWidth,
          displayHeight: frame.displayHeight,
          colorSpace: colorSpace ?? null,
          copyTo: null,
        };
        frameProbes.push(probe);
        copyTasks.push(probeFrameCopyTo(frame).then((copyTo) => {
          probe.copyTo = copyTo;
        }).finally(() => {
          frame.close();
        }));
        return;
      }
      frame.close();
    },
    error: (error) => {
      decoderError = error.message;
    },
  });

  try {
    decoder.configure(supportedConfig);
    for (const sample of track.samples.slice(0, maxSamples)) {
      decoder.decode(createEncodedVideoChunk(fileBytes, sample, track));
    }
    await decoder.flush();
    await Promise.all(copyTasks);
  } catch (error) {
    decoderError = error instanceof Error ? error.message : String(error);
  } finally {
    decoder.close();
  }

  const elapsedMs = performance.now() - startedAt;
  const firstFrame = frameProbes[0];
  if (!firstFrame) {
    return {
      ...baseResult(),
      supported: true,
      codec: supportedConfig.codec,
      decodedFrames,
      elapsedMs,
      error: decoderError ?? 'Decoder produced no frames.',
    };
  }

  return {
    supported: true,
    codec: supportedConfig.codec,
    decodedFrames,
    elapsedMs,
    format: firstFrame.format,
    timestamp: firstFrame.timestamp,
    codedWidth: firstFrame.codedWidth,
    codedHeight: firstFrame.codedHeight,
    displayWidth: firstFrame.displayWidth,
    displayHeight: firstFrame.displayHeight,
    colorSpace: firstFrame.colorSpace,
    copyTo: firstFrame.copyTo,
    error: decoderError,
  };
}

async function probeFrameCopyTo(frame: VideoFrame): Promise<FrameCopyProbe> {
  const startedAt = performance.now();
  if (String(frame.format) !== 'I420P10') {
    return {
      attempted: false,
      ok: false,
      elapsedMs: performance.now() - startedAt,
      allocationSize: null,
      layout: [],
      error: `copyTo raw path requires I420P10, got ${frame.format ?? 'null'}.`,
    };
  }

  try {
    const allocationSize = frame.allocationSize();
    const buffer = new ArrayBuffer(allocationSize);
    const layout = await frame.copyTo(buffer);
    const normalizedLayout = layout.map((plane) => ({ offset: plane.offset, stride: plane.stride }));
    validateI420P10CopyLayout(normalizedLayout, {
      width: frame.visibleRect?.width ?? frame.codedWidth,
      height: frame.visibleRect?.height ?? frame.codedHeight,
    }, allocationSize);

    return {
      attempted: true,
      ok: true,
      elapsedMs: performance.now() - startedAt,
      allocationSize,
      layout: normalizedLayout,
      error: null,
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      elapsedMs: performance.now() - startedAt,
      allocationSize: null,
      layout: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
