import { FFFSType } from '@ffmpeg/ffmpeg';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import coreUrl from '@ffmpeg/core?url';
import wasmUrl from '@ffmpeg/core/wasm?url';
import type { Mp4VideoTrack } from './mp4';
import { decodeFirstFrameFromMp4Track, type DecodedFrameProbe } from './webcodecs';

export type DecoderAdapterName = 'webcodecs' | 'ffmpeg.wasm';
export type DecoderAdapterStatus = 'not-run' | 'success' | 'fallback-needed' | 'fallback-available' | 'failed';

export interface FfmpegRawFrameProbe {
  attempted: boolean;
  ok: boolean;
  elapsedMs: number;
  seekSeconds: number;
  inputMode: 'workerfs' | 'memfs' | null;
  format: 'I420P10' | null;
  bytes: number | null;
  expectedBytes: number | null;
  data: Uint8Array | null;
  error: string | null;
}

export interface FfmpegHevcPacketProbe {
  attempted: boolean;
  ok: boolean;
  elapsedMs: number;
  seekSeconds: number;
  inputMode: 'workerfs' | 'memfs' | null;
  bytes: number | null;
  data: Uint8Array | null;
  error: string | null;
}

export interface FfmpegWasmProbe {
  available: boolean;
  elapsedMs: number;
  loaded: boolean;
  mounted: boolean;
  version: string | null;
  rawFrame: FfmpegRawFrameProbe;
  error: string | null;
  logs: string[];
}

export interface DecoderAdapterProbe {
  selected: DecoderAdapterName | null;
  status: DecoderAdapterStatus;
  webCodecs: DecodedFrameProbe | null;
  ffmpegWasm: FfmpegWasmProbe | null;
  fallbackReason: string | null;
}

let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoadPromise: Promise<FFmpeg> | null = null;
let ffmpegLogs: string[] = [];
const MEMFS_COPY_LIMIT_BYTES = 128 * 1024 * 1024;
const FFMPEG_FAST_SEEK_LEAD_SECONDS = 2;

function shouldFallbackFromWebCodecs(probe: DecodedFrameProbe): string | null {
  if (!probe.supported) return probe.error ?? 'WebCodecs did not support the HEVC decoder config.';
  if (probe.error) return probe.error;
  if (probe.decodedFrames < 1) return 'WebCodecs decoded no frames.';
  if (probe.format !== 'I420P10') return `WebCodecs returned ${probe.format ?? 'unknown'} instead of I420P10.`;
  if (!probe.copyTo?.ok) return probe.copyTo?.error ?? 'VideoFrame.copyTo() did not produce an I420P10 layout.';
  return null;
}

async function loadFfmpegWasm(): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) return ffmpegInstance;
  if (ffmpegLoadPromise) return ffmpegLoadPromise;

  ffmpegLogs = [];
  const ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => {
    ffmpegLogs.push(message);
    if (ffmpegLogs.length > 10) ffmpegLogs.shift();
  });
  ffmpegLoadPromise = (async () => {
    await ffmpeg.load({
      coreURL: await toBlobURL(coreUrl, 'text/javascript'),
      wasmURL: await toBlobURL(wasmUrl, 'application/wasm'),
    });
    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();

  try {
    return await ffmpegLoadPromise;
  } catch (error) {
    ffmpegLoadPromise = null;
    throw error;
  }
}

function rawFrameNotAttempted(): FfmpegRawFrameProbe {
  return {
    attempted: false,
    ok: false,
    elapsedMs: 0,
    seekSeconds: 0,
    inputMode: null,
    format: null,
    bytes: null,
    expectedBytes: null,
    data: null,
    error: null,
  };
}

function expectedI420P10Bytes(track: Mp4VideoTrack): number {
  const y = track.width * track.height * 2;
  const chroma = Math.ceil(track.width / 2) * Math.ceil(track.height / 2) * 2;
  return y + chroma * 2;
}

function safeFileName(name: string): string {
  return name.replace(/[\\/]/g, '_') || 'input.mkv';
}

function formatSeekSeconds(value: number): string {
  return Math.max(0, value).toFixed(3);
}

function hybridSeekArgs(seekSeconds: number): { input: string[]; output: string[] } {
  if (seekSeconds <= 0) return { input: [], output: [] };
  const inputSeekSeconds = Math.max(0, seekSeconds - FFMPEG_FAST_SEEK_LEAD_SECONDS);
  const outputSeekSeconds = seekSeconds - inputSeekSeconds;
  return {
    input: inputSeekSeconds > 0 ? ['-ss', formatSeekSeconds(inputSeekSeconds)] : [],
    output: outputSeekSeconds > 0 ? ['-ss', formatSeekSeconds(outputSeekSeconds)] : [],
  };
}

async function decodeRawFrameWithFfmpeg(
  ffmpeg: FFmpeg,
  file: File,
  track: Mp4VideoTrack,
  seekSeconds: number,
  timeoutMs: number,
): Promise<FfmpegRawFrameProbe> {
  const startedAt = performance.now();
  const safeSeekSeconds = Math.max(0, Number.isFinite(seekSeconds) ? seekSeconds : 0);
  const expectedBytes = expectedI420P10Bytes(track);
  const outputPath = '/frame.yuv';
  const mountPoint = '/input';
  const fileName = safeFileName(file.name);
  let inputPath = `${mountPoint}/${fileName}`;
  let inputMode: FfmpegRawFrameProbe['inputMode'] = 'workerfs';
  let mounted = false;
  let copied = false;

  try {
    try {
      await ffmpeg.createDir(mountPoint);
    } catch {
      // The directory may already exist from a previous probe.
    }

    try {
      await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, mountPoint);
      mounted = true;
    } catch (mountError) {
      if (file.size > MEMFS_COPY_LIMIT_BYTES) throw mountError;
      inputMode = 'memfs';
      inputPath = `/input-${fileName}`;
      await ffmpeg.writeFile(inputPath, await fetchFile(file));
      copied = true;
    }

    const seekArgs = hybridSeekArgs(safeSeekSeconds);
    const exitCode = await ffmpeg.exec([
      '-v',
      'error',
      '-y',
      ...seekArgs.input,
      '-i',
      inputPath,
      ...seekArgs.output,
      '-map',
      '0:v:0',
      '-frames:v',
      '1',
      '-an',
      '-sn',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'yuv420p10le',
      outputPath,
    ], timeoutMs);

    if (exitCode !== 0) {
      return {
        attempted: true,
        ok: false,
        elapsedMs: performance.now() - startedAt,
        seekSeconds: safeSeekSeconds,
        inputMode,
        format: null,
        bytes: null,
        expectedBytes,
        data: null,
        error: `ffmpeg exited with code ${exitCode}.`,
      };
    }

    const raw = await ffmpeg.readFile(outputPath);
    const rawBytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
    const bytes = rawBytes.byteLength;
    return {
      attempted: true,
      ok: bytes === expectedBytes,
      elapsedMs: performance.now() - startedAt,
      seekSeconds: safeSeekSeconds,
      inputMode,
      format: 'I420P10',
      bytes,
      expectedBytes,
      data: rawBytes,
      error: bytes === expectedBytes ? null : `Expected ${expectedBytes} raw bytes, got ${bytes}.`,
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      elapsedMs: performance.now() - startedAt,
      seekSeconds: safeSeekSeconds,
      inputMode,
      format: null,
      bytes: null,
      expectedBytes,
      data: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      await ffmpeg.deleteFile(outputPath);
    } catch {
      // Output may not exist when decode fails.
    }
    if (copied) {
      try {
        await ffmpeg.deleteFile(inputPath);
      } catch {
        // Ignore cleanup errors from the wasm FS.
      }
    }
    if (mounted) {
      try {
        await ffmpeg.unmount(mountPoint);
      } catch {
        // Ignore cleanup errors from WorkerFS.
      }
    }
  }
}

async function extractHevcPacketWithFfmpeg(ffmpeg: FFmpeg, file: File, seekSeconds: number, timeoutMs: number): Promise<FfmpegHevcPacketProbe> {
  const startedAt = performance.now();
  const safeSeekSeconds = Math.max(0, Number.isFinite(seekSeconds) ? seekSeconds : 0);
  const outputPath = '/packet.hevc';
  const mountPoint = '/input';
  const fileName = safeFileName(file.name);
  let inputPath = `${mountPoint}/${fileName}`;
  let inputMode: FfmpegHevcPacketProbe['inputMode'] = 'workerfs';
  let mounted = false;
  let copied = false;

  try {
    try {
      await ffmpeg.createDir(mountPoint);
    } catch {
      // The directory may already exist from a previous probe.
    }

    try {
      await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, mountPoint);
      mounted = true;
    } catch (mountError) {
      if (file.size > MEMFS_COPY_LIMIT_BYTES) throw mountError;
      inputMode = 'memfs';
      inputPath = `/input-${fileName}`;
      await ffmpeg.writeFile(inputPath, await fetchFile(file));
      copied = true;
    }

    const seekArgs = hybridSeekArgs(safeSeekSeconds);
    const exitCode = await ffmpeg.exec([
      '-v',
      'error',
      '-y',
      ...seekArgs.input,
      '-i',
      inputPath,
      ...seekArgs.output,
      '-map',
      '0:v:0',
      '-frames:v',
      '1',
      '-c:v',
      'copy',
      '-bsf:v',
      'hevc_mp4toannexb',
      '-an',
      '-sn',
      '-f',
      'hevc',
      outputPath,
    ], timeoutMs);

    if (exitCode !== 0) {
      return {
        attempted: true,
        ok: false,
        elapsedMs: performance.now() - startedAt,
        seekSeconds: safeSeekSeconds,
        inputMode,
        bytes: null,
        data: null,
        error: `ffmpeg exited with code ${exitCode}.`,
      };
    }

    const raw = await ffmpeg.readFile(outputPath);
    const data = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
    return {
      attempted: true,
      ok: data.byteLength > 0,
      elapsedMs: performance.now() - startedAt,
      seekSeconds: safeSeekSeconds,
      inputMode,
      bytes: data.byteLength,
      data,
      error: data.byteLength > 0 ? null : 'ffmpeg produced an empty HEVC packet.',
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      elapsedMs: performance.now() - startedAt,
      seekSeconds: safeSeekSeconds,
      inputMode,
      bytes: null,
      data: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      await ffmpeg.deleteFile(outputPath);
    } catch {
      // Output may not exist when extraction fails.
    }
    if (copied) {
      try {
        await ffmpeg.deleteFile(inputPath);
      } catch {
        // Ignore cleanup errors from the wasm FS.
      }
    }
    if (mounted) {
      try {
        await ffmpeg.unmount(mountPoint);
      } catch {
        // Ignore cleanup errors from WorkerFS.
      }
    }
  }
}

export async function probeFfmpegHevcPacket(
  file: File,
  options: { seekSeconds?: number; timeoutMs?: number } = {},
): Promise<FfmpegHevcPacketProbe> {
  try {
    const ffmpeg = await loadFfmpegWasm();
    return await extractHevcPacketWithFfmpeg(ffmpeg, file, options.seekSeconds ?? 0, options.timeoutMs ?? 60_000);
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      elapsedMs: 0,
      seekSeconds: Math.max(0, Number.isFinite(options.seekSeconds) ? options.seekSeconds ?? 0 : 0),
      inputMode: null,
      bytes: null,
      data: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function probeFfmpegWasmAdapter(
  file?: File,
  track?: Mp4VideoTrack,
  options: { decodeRawFrame?: boolean; seekSeconds?: number; timeoutMs?: number } = {},
): Promise<FfmpegWasmProbe> {
  const startedAt = performance.now();
  try {
    const ffmpeg = await loadFfmpegWasm();
    let mounted = false;
    if (file && !options.decodeRawFrame) {
      const mountPoint = '/input';
      try {
        await ffmpeg.createDir(mountPoint);
      } catch {
        // The directory may already exist from a previous probe.
      }
      await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, mountPoint);
      mounted = true;
      await ffmpeg.unmount(mountPoint);
    }
    const rawFrame = options.decodeRawFrame && file && track
      ? await decodeRawFrameWithFfmpeg(ffmpeg, file, track, options.seekSeconds ?? 0, options.timeoutMs ?? 60_000)
      : rawFrameNotAttempted();

    return {
      available: true,
      elapsedMs: performance.now() - startedAt,
      loaded: ffmpeg.loaded,
      mounted,
      version: '0.12',
      rawFrame,
      error: null,
      logs: [...ffmpegLogs],
    };
  } catch (error) {
    return {
      available: false,
      elapsedMs: performance.now() - startedAt,
      loaded: false,
      mounted: false,
      version: null,
      rawFrame: rawFrameNotAttempted(),
      error: error instanceof Error ? error.message : String(error),
      logs: [...ffmpegLogs],
    };
  }
}

export async function probeDecoderAdapters(
  fileBytes: Uint8Array,
  track: Mp4VideoTrack,
  file?: File,
): Promise<DecoderAdapterProbe> {
  const webCodecs = await decodeFirstFrameFromMp4Track(fileBytes, track);
  const fallbackReason = shouldFallbackFromWebCodecs(webCodecs);
  if (!fallbackReason) {
    return {
      selected: 'webcodecs',
      status: 'success',
      webCodecs,
      ffmpegWasm: null,
      fallbackReason: null,
    };
  }

  const ffmpegWasm = await probeFfmpegWasmAdapter(file, track);
  return {
    selected: ffmpegWasm.available ? 'ffmpeg.wasm' : null,
    status: ffmpegWasm.available ? 'fallback-available' : 'failed',
    webCodecs,
    ffmpegWasm,
    fallbackReason,
  };
}
