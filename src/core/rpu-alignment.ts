import { parseLengthPrefixedHevcSample } from './hevc';
import type { Mp4Sample, Mp4VideoTrack } from './mp4';

export type RpuFrameStatus =
  | 'not-selected'
  | 'present'
  | 'missing'
  | 'outside-parsed-samples'
  | 'invalid-sample';

export interface RpuFrameSelection {
  requestedSeconds: number;
  status: RpuFrameStatus;
  sampleIndex: number | null;
  timestampUs: number | null;
  durationUs: number | null;
  isSync: boolean | null;
  rpuNalUnits: number;
  firstRpuNalOffset: number | null;
  firstRpuNalSize: number | null;
  firstRpuNalHex: string | null;
  error: string | null;
}

function displayOrigin(track: Mp4VideoTrack): number {
  return track.samples.length > 0 ? Math.min(...track.samples.map((sample) => sample.cts)) : 0;
}

function sampleStartSeconds(sample: Mp4Sample, track: Mp4VideoTrack): number {
  return track.timescale > 0 ? (sample.cts - displayOrigin(track)) / track.timescale : 0;
}

function sampleEndSeconds(sample: Mp4Sample, track: Mp4VideoTrack): number {
  return sampleStartSeconds(sample, track) + (track.timescale > 0 ? sample.duration / track.timescale : 0);
}

function sampleTimestampUs(sample: Mp4Sample, track: Mp4VideoTrack): number {
  return Math.round(sampleStartSeconds(sample, track) * 1_000_000);
}

function sampleDurationUs(sample: Mp4Sample, track: Mp4VideoTrack): number {
  return Math.round((track.timescale > 0 ? sample.duration / track.timescale : 0) * 1_000_000);
}

function hexPreview(bytes: Uint8Array, maxBytes = 12): string {
  return [...bytes.slice(0, maxBytes)].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

export function findSampleForSeconds(track: Mp4VideoTrack, seconds: number): Mp4Sample | null {
  const requested = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const displaySamples = [...track.samples].sort((a, b) => a.cts - b.cts || a.index - b.index);
  for (const sample of displaySamples) {
    const start = sampleStartSeconds(sample, track);
    const end = sampleEndSeconds(sample, track);
    if (requested >= start && requested < end) return sample;
  }

  const last = displaySamples.at(-1);
  if (!last) return null;
  const lastEnd = sampleEndSeconds(last, track);
  return requested === lastEnd ? last : null;
}

export function inspectRpuForSeconds(data: Uint8Array, track: Mp4VideoTrack, seconds: number): RpuFrameSelection {
  const requestedSeconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const sample = findSampleForSeconds(track, requestedSeconds);
  if (!sample) {
    return {
      requestedSeconds,
      status: 'outside-parsed-samples',
      sampleIndex: null,
      timestampUs: null,
      durationUs: null,
      isSync: null,
      rpuNalUnits: 0,
      firstRpuNalOffset: null,
      firstRpuNalSize: null,
      firstRpuNalHex: null,
      error: null,
    };
  }

  const lengthSize = track.hevcConfig?.lengthSize;
  if (!lengthSize) {
    return {
      requestedSeconds,
      status: 'invalid-sample',
      sampleIndex: sample.index,
      timestampUs: sampleTimestampUs(sample, track),
      durationUs: sampleDurationUs(sample, track),
      isSync: sample.isSync,
      rpuNalUnits: 0,
      firstRpuNalOffset: null,
      firstRpuNalSize: null,
      firstRpuNalHex: null,
      error: 'HEVC length size is missing.',
    };
  }

  if (sample.offset + sample.size > data.byteLength) {
    return {
      requestedSeconds,
      status: 'outside-parsed-samples',
      sampleIndex: sample.index,
      timestampUs: sampleTimestampUs(sample, track),
      durationUs: sampleDurationUs(sample, track),
      isSync: sample.isSync,
      rpuNalUnits: 0,
      firstRpuNalOffset: null,
      firstRpuNalSize: null,
      firstRpuNalHex: null,
      error: 'Sample bytes are outside the parsed prefix window.',
    };
  }

  try {
    const sampleBytes = data.subarray(sample.offset, sample.offset + sample.size);
    const analysis = parseLengthPrefixedHevcSample(sampleBytes, lengthSize);
    const firstRpu = analysis.rpuNalUnits[0] ?? null;
    const firstRpuNalOffset = firstRpu ? sample.offset + firstRpu.payloadOffset : null;
    const firstRpuNalSize = firstRpu?.size ?? null;
    const firstRpuNalHex = firstRpu && firstRpuNalOffset != null
      ? hexPreview(data.subarray(firstRpuNalOffset, firstRpuNalOffset + firstRpu.size))
      : null;
    return {
      requestedSeconds,
      status: analysis.rpuNalUnits.length > 0 ? 'present' : 'missing',
      sampleIndex: sample.index,
      timestampUs: sampleTimestampUs(sample, track),
      durationUs: sampleDurationUs(sample, track),
      isSync: sample.isSync,
      rpuNalUnits: analysis.rpuNalUnits.length,
      firstRpuNalOffset,
      firstRpuNalSize,
      firstRpuNalHex,
      error: null,
    };
  } catch (error) {
    return {
      requestedSeconds,
      status: 'invalid-sample',
      sampleIndex: sample.index,
      timestampUs: sampleTimestampUs(sample, track),
      durationUs: sampleDurationUs(sample, track),
      isSync: sample.isSync,
      rpuNalUnits: 0,
      firstRpuNalOffset: null,
      firstRpuNalSize: null,
      firstRpuNalHex: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
