import { parseHevcDecoderConfigRecord } from './hevc-config';
import type { Mp4Sample, Mp4VideoTrack } from './mp4';

const IDS = {
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
};

interface ElementInfo {
  id: number;
  start: number;
  dataStart: number;
  dataEnd: number;
  end: number;
  truncated: boolean;
}

export interface MatroskaParseResult {
  brands: string[];
  tracks: Mp4VideoTrack[];
}

class EbmlReader {
  readonly view: DataView;

  constructor(readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  u8(offset: number): number {
    return this.view.getUint8(offset);
  }

  u16(offset: number): number {
    return this.view.getUint16(offset, false);
  }

  i16(offset: number): number {
    return this.view.getInt16(offset, false);
  }

  vintLength(offset: number): number {
    const first = this.u8(offset);
    for (let i = 0; i < 8; i += 1) {
      if (first & (0x80 >> i)) return i + 1;
    }
    throw new Error(`Invalid EBML vint at ${offset}.`);
  }

  readId(offset: number): { value: number; length: number } {
    const length = this.vintLength(offset);
    let value = 0;
    for (let i = 0; i < length; i += 1) value = value * 256 + this.u8(offset + i);
    return { value, length };
  }

  readSize(offset: number): { value: number; length: number; unknown: boolean } {
    const length = this.vintLength(offset);
    let value = this.u8(offset) & (0xff >> length);
    for (let i = 1; i < length; i += 1) value = value * 256 + this.u8(offset + i);
    const unknown = value === 2 ** (7 * length) - 1;
    return { value, length, unknown };
  }

  element(offset: number, parentEnd: number): ElementInfo | null {
    if (offset + 2 > parentEnd) return null;
    const id = this.readId(offset);
    const size = this.readSize(offset + id.length);
    const dataStart = offset + id.length + size.length;
    const declaredDataEnd = size.unknown ? parentEnd : dataStart + size.value;
    if (dataStart > parentEnd) return null;
    const dataEnd = Math.min(declaredDataEnd, parentEnd);
    return {
      id: id.value,
      start: offset,
      dataStart,
      dataEnd,
      end: dataEnd,
      truncated: declaredDataEnd > parentEnd,
    };
  }

  children(start: number, end: number): ElementInfo[] {
    const elements: ElementInfo[] = [];
    let offset = start;
    while (offset + 2 <= end) {
      const element = this.element(offset, end);
      if (!element) break;
      elements.push(element);
      if (element.end <= offset) break;
      offset = element.end;
    }
    return elements;
  }

  uint(element: ElementInfo): number {
    let value = 0;
    for (let offset = element.dataStart; offset < element.dataEnd; offset += 1) value = value * 256 + this.u8(offset);
    return value;
  }

  ascii(element: ElementInfo): string {
    return new TextDecoder().decode(this.data.subarray(element.dataStart, element.dataEnd));
  }
}

function child(reader: EbmlReader, parent: ElementInfo, id: number): ElementInfo | null {
  return reader.children(parent.dataStart, parent.dataEnd).find((element) => element.id === id) ?? null;
}

function parseSimpleBlock(reader: EbmlReader, element: ElementInfo, clusterTimecode: number, trackNumber: number, sampleIndex: number): Mp4Sample | null {
  if (element.truncated) return null;
  const track = reader.readSize(element.dataStart);
  if (track.value !== trackNumber) return null;
  const timecodeOffset = element.dataStart + track.length;
  if (timecodeOffset + 3 > element.dataEnd) return null;
  const relativeTimecode = reader.i16(timecodeOffset);
  const flags = reader.u8(timecodeOffset + 2);
  const payloadOffset = timecodeOffset + 3;
  return {
    index: sampleIndex,
    offset: payloadOffset,
    size: element.dataEnd - payloadOffset,
    dts: clusterTimecode + relativeTimecode,
    cts: clusterTimecode + relativeTimecode,
    duration: 40,
    isSync: Boolean(flags & 0x80),
  };
}

function parseBlockGroup(reader: EbmlReader, element: ElementInfo, clusterTimecode: number, trackNumber: number, sampleIndex: number): Mp4Sample | null {
  const block = child(reader, element, IDS.Block);
  if (!block) return null;
  return parseSimpleBlock(reader, block, clusterTimecode, trackNumber, sampleIndex);
}

export function parseMatroska(data: Uint8Array, maxSamples = 240): MatroskaParseResult {
  const reader = new EbmlReader(data);
  const top = reader.children(0, data.byteLength);
  const segment = top.find((element) => element.id === IDS.Segment);
  if (!segment) throw new Error('Matroska Segment element not found.');

  let timecodeScale = 1_000_000;
  const info = child(reader, segment, IDS.Info);
  const scale = info ? child(reader, info, IDS.TimecodeScale) : null;
  if (scale) timecodeScale = reader.uint(scale);

  const tracksElement = child(reader, segment, IDS.Tracks);
  if (!tracksElement) throw new Error('Matroska Tracks element not found.');

  let videoTrackNumber = 0;
  let codecId = '';
  let codecPrivate: Uint8Array | null = null;
  let width = 0;
  let height = 0;

  for (const entry of reader.children(tracksElement.dataStart, tracksElement.dataEnd).filter((element) => element.id === IDS.TrackEntry)) {
    const trackType = child(reader, entry, IDS.TrackType);
    if (!trackType || reader.uint(trackType) !== 1) continue;
    const trackNumber = child(reader, entry, IDS.TrackNumber);
    const codec = child(reader, entry, IDS.CodecID);
    const video = child(reader, entry, IDS.Video);
    if (!trackNumber || !codec || !video) continue;
    const privateElement = child(reader, entry, IDS.CodecPrivate);
    videoTrackNumber = reader.uint(trackNumber);
    codecId = reader.ascii(codec).trim();
    codecPrivate = privateElement ? data.slice(privateElement.dataStart, privateElement.dataEnd) : null;
    const pixelWidth = child(reader, video, IDS.PixelWidth);
    const pixelHeight = child(reader, video, IDS.PixelHeight);
    width = pixelWidth ? reader.uint(pixelWidth) : 0;
    height = pixelHeight ? reader.uint(pixelHeight) : 0;
    break;
  }

  if (!codecId) {
    throw new Error('Matroska video track not found.');
  }

  const samples: Mp4Sample[] = [];
  for (const cluster of reader.children(segment.dataStart, segment.dataEnd).filter((element) => element.id === IDS.Cluster)) {
    const timecodeElement = child(reader, cluster, IDS.Timecode);
    const clusterTimecode = timecodeElement ? reader.uint(timecodeElement) : 0;
    for (const element of reader.children(cluster.dataStart, cluster.dataEnd)) {
      let sample: Mp4Sample | null = null;
      if (element.id === IDS.SimpleBlock) sample = parseSimpleBlock(reader, element, clusterTimecode, videoTrackNumber, samples.length);
      if (element.id === IDS.BlockGroup) sample = parseBlockGroup(reader, element, clusterTimecode, videoTrackNumber, samples.length);
      if (sample) samples.push(sample);
      if (samples.length >= maxSamples) break;
    }
    if (samples.length >= maxSamples) break;
  }

  if (samples.length === 0) throw new Error('No Matroska video blocks found in the loaded prefix.');

  const isHevc = codecId === 'V_MPEGH/ISO/HEVC';
  const hevcConfig = isHevc && codecPrivate ? parseHevcDecoderConfigRecord(codecPrivate, 'hev1') : null;
  return {
    brands: ['matroska'],
    tracks: [{
      id: videoTrackNumber,
      handlerType: 'vide',
      timescale: Math.round(1_000_000_000 / timecodeScale),
      duration: samples[samples.length - 1].dts + samples[samples.length - 1].duration,
      width,
      height,
      codecType: isHevc ? 'hev1' : codecId,
      hevcConfig,
      hasDolbyVisionConfig: Boolean(hevcConfig),
      sampleCount: samples.length,
      samples,
    }],
  };
}
