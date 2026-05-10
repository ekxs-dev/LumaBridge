import { beforeEach, describe, expect, it, vi } from 'vitest';
import { probeDecoderAdapters } from '../../src/core/decoder-adapter';
import type { Mp4VideoTrack } from '../../src/core/mp4';

const ffmpegMock = vi.hoisted(() => ({
  execCalls: [] as string[][],
  rawReadBytes: 1920 * 1080 * 3,
}));

vi.mock('../../src/core/webcodecs', () => ({
  evaluateWebCodecsRawAccess: vi.fn((probe) => ({
    mode: probe.format === 'I420P10' ? 'strict-i420p10' : 'known-non-strict-format',
    canPreview: true,
    canExposeRawPlanes: probe.format != null,
    canCopyI420P10: probe.format === 'I420P10' && Boolean(probe.copyTo?.ok),
    canCorrectDv: probe.format === 'I420P10' && Boolean(probe.copyTo?.ok),
    label: probe.format === 'I420P10' ? 'strict I420P10 raw path' : `raw format ${probe.format}, not strict DV`,
    reasons: [`format ${probe.format}`],
  })),
  decodeFirstFrameFromMp4Track: vi.fn(async () => ({
    supported: true,
    codec: 'hev1.2.4.L153.B0',
    decodedFrames: 1,
    elapsedMs: 3,
    format: 'NV12',
    timestamp: 0,
    codedWidth: 1920,
    codedHeight: 1080,
    displayWidth: 1920,
    displayHeight: 1080,
    colorSpace: { primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl' },
    copyTo: {
      attempted: false,
      ok: false,
      elapsedMs: 0,
      allocationSize: null,
      layout: [],
      error: 'copyTo raw path requires I420P10, got NV12.',
    },
    error: null,
  })),
}));

vi.mock('@ffmpeg/ffmpeg', () => ({
  FFFSType: { WORKERFS: 'WORKERFS' },
  FFmpeg: class {
    loaded = true;
    on() {}
    async load() {
      return true;
    }
    async createDir() {
      return true;
    }
    async mount() {
      return true;
    }
    async unmount() {
      return true;
    }
    async exec(args: string[]) {
      ffmpegMock.execCalls.push(args);
      return 0;
    }
    async readFile(path: string) {
      if (path.endsWith('.hevc')) {
        return new Uint8Array([0, 0, 0, 1, 0x7c, 0x01, 0xaa]);
      }
      return new Uint8Array(ffmpegMock.rawReadBytes);
    }
    async deleteFile() {
      return true;
    }
  },
}));

vi.mock('@ffmpeg/util', () => ({
  toBlobURL: vi.fn(async (url: string) => `blob:${url}`),
  fetchFile: vi.fn(),
}));

vi.mock('@ffmpeg/core?url', () => ({ default: '/mock/ffmpeg-core.js' }));
vi.mock('@ffmpeg/core/wasm?url', () => ({ default: '/mock/ffmpeg-core.wasm' }));

describe('decoder adapter', () => {
  beforeEach(() => {
    ffmpegMock.execCalls.length = 0;
    ffmpegMock.rawReadBytes = 1920 * 1080 * 3;
  });

  it('falls back to ffmpeg.wasm availability when WebCodecs cannot produce I420P10', async () => {
    const track: Mp4VideoTrack = {
      id: 1,
      handlerType: 'vide',
      timescale: 1000,
      duration: 40,
      width: 1920,
      height: 1080,
      codecType: 'hev1',
      hevcConfig: {
        configurationVersion: 1,
        profileSpace: 0,
        tierFlag: false,
        profileIdc: 2,
        profileCompatibilityFlags: 0,
        constraintIndicatorFlags: 0,
        levelIdc: 153,
        lengthSize: 4,
        codecString: 'hev1.2.4.L153.B0',
        description: new Uint8Array([1]),
      },
      hasDolbyVisionConfig: true,
      sampleCount: 1,
      samples: [{
        index: 0,
        offset: 0,
        size: 0,
        dts: 0,
        cts: 0,
        duration: 40,
        isSync: true,
      }],
    };
    const file = new File([new Uint8Array([1, 2, 3])], 'input.mkv', { type: 'video/matroska' });

    const probe = await probeDecoderAdapters(new Uint8Array(), track, file);

    expect(probe.selected).toBe('ffmpeg.wasm');
    expect(probe.status).toBe('fallback-available');
    expect(probe.fallbackReason).toContain('I420P10');
    expect(probe.ffmpegWasm?.available).toBe(true);
  });

  it('passes a selected seek time to the ffmpeg.wasm raw-frame probe', async () => {
    const { probeFfmpegWasmAdapter } = await import('../../src/core/decoder-adapter');
    const track: Mp4VideoTrack = {
      id: 1,
      handlerType: 'vide',
      timescale: 1000,
      duration: 40_000,
      width: 1920,
      height: 1080,
      codecType: 'hev1',
      hevcConfig: {
        configurationVersion: 1,
        profileSpace: 0,
        tierFlag: false,
        profileIdc: 2,
        profileCompatibilityFlags: 0,
        constraintIndicatorFlags: 0,
        levelIdc: 153,
        lengthSize: 4,
        codecString: 'hev1.2.4.L153.B0',
        description: new Uint8Array([1]),
      },
      hasDolbyVisionConfig: true,
      sampleCount: 1,
      samples: [{
        index: 0,
        offset: 0,
        size: 0,
        dts: 0,
        cts: 0,
        duration: 40,
        isSync: true,
      }],
    };
    const file = new File([new Uint8Array([1, 2, 3])], 'input.mkv', { type: 'video/matroska' });

    const probe = await probeFfmpegWasmAdapter(file, track, { decodeRawFrame: true, seekSeconds: 12.5 });

    expect(probe.rawFrame.ok).toBe(true);
    expect(probe.rawFrame.seekSeconds).toBe(12.5);
    const lastCall = ffmpegMock.execCalls.at(-1) ?? [];
    expect(lastCall.filter((arg) => arg === '-ss')).toHaveLength(2);
    expect(lastCall).toEqual(expect.arrayContaining(['-ss', '10.500']));
    expect(lastCall).toEqual(expect.arrayContaining(['-ss', '2.000']));
    expect(ffmpegMock.execCalls.at(-1)).toEqual(expect.arrayContaining(['-pix_fmt', 'yuv420p10le']));
  });

  it('extracts a selected HEVC packet through ffmpeg.wasm for RPU probing', async () => {
    const { probeFfmpegHevcPacket } = await import('../../src/core/decoder-adapter');
    const file = new File([new Uint8Array([1, 2, 3])], 'input.mkv', { type: 'video/matroska' });

    const probe = await probeFfmpegHevcPacket(file, { seekSeconds: 45.25 });

    expect(probe.ok).toBe(true);
    expect(probe.seekSeconds).toBe(45.25);
    expect(probe.bytes).toBe(7);
    const lastCall = ffmpegMock.execCalls.at(-1) ?? [];
    expect(lastCall.filter((arg) => arg === '-ss')).toHaveLength(2);
    expect(lastCall).toEqual(expect.arrayContaining(['-ss', '43.250']));
    expect(lastCall).toEqual(expect.arrayContaining(['-ss', '2.000']));
    expect(ffmpegMock.execCalls.at(-1)).toEqual(expect.arrayContaining(['-c:v', 'copy']));
    expect(ffmpegMock.execCalls.at(-1)).toEqual(expect.arrayContaining(['-bsf:v', 'hevc_mp4toannexb']));
    expect(ffmpegMock.execCalls.at(-1)).toEqual(expect.arrayContaining(['-f', 'hevc']));
  });

  it('decodes a short raw segment with one ffmpeg seek instead of seek-per-frame', async () => {
    const { probeFfmpegRawSegment } = await import('../../src/core/decoder-adapter');
    const track: Mp4VideoTrack = {
      id: 1,
      handlerType: 'vide',
      timescale: 1000,
      duration: 40_000,
      width: 1920,
      height: 1080,
      codecType: 'hev1',
      hevcConfig: {
        configurationVersion: 1,
        profileSpace: 0,
        tierFlag: false,
        profileIdc: 2,
        profileCompatibilityFlags: 0,
        constraintIndicatorFlags: 0,
        levelIdc: 153,
        lengthSize: 4,
        codecString: 'hev1.2.4.L153.B0',
        description: new Uint8Array([1]),
      },
      hasDolbyVisionConfig: true,
      sampleCount: 1,
      samples: [{
        index: 0,
        offset: 0,
        size: 0,
        dts: 0,
        cts: 0,
        duration: 40,
        isSync: true,
      }],
    };
    const frameBytes = 1920 * 1080 * 3;
    ffmpegMock.rawReadBytes = frameBytes * 4;
    const file = new File([new Uint8Array([1, 2, 3])], 'input.mkv', { type: 'video/matroska' });

    const probe = await probeFfmpegRawSegment(file, track, {
      seekSeconds: 12.5,
      frameCount: 4,
      outputFps: 2,
    });

    expect(probe.ok).toBe(true);
    expect(probe.frameBytes).toBe(frameBytes);
    expect(probe.frameCount).toBe(4);
    expect(probe.bytes).toBe(frameBytes * 4);
    expect(probe.outputFps).toBe(2);
    const lastCall = ffmpegMock.execCalls.at(-1) ?? [];
    expect(lastCall.filter((arg) => arg === '-ss')).toHaveLength(2);
    expect(lastCall).toEqual(expect.arrayContaining(['-frames:v', '4']));
    expect(lastCall).toEqual(expect.arrayContaining(['-vf', 'fps=2']));
    expect(lastCall).toEqual(expect.arrayContaining(['-pix_fmt', 'yuv420p10le']));
  });
});
