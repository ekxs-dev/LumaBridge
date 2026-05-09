import { describe, expect, it, vi } from 'vitest';
import { probeDecoderAdapters } from '../../src/core/decoder-adapter';
import type { Mp4VideoTrack } from '../../src/core/mp4';
import { parseMp4 } from '../../src/core/mp4';

vi.mock('../../src/core/webcodecs', () => ({
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
    async exec() {
      return 0;
    }
    async readFile() {
      return new Uint8Array(1920 * 1080 * 3);
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
});
