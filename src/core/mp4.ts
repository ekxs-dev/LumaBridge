import { parseHevcDecoderConfigRecord } from './hevc-config';

export interface Mp4BoxInfo {
  type: string;
  start: number;
  size: number;
  headerSize: number;
  end: number;
}

export interface Mp4Sample {
  index: number;
  offset: number;
  size: number;
  dts: number;
  cts: number;
  duration: number;
  isSync: boolean;
}

export interface HevcConfigSummary {
  configurationVersion: number;
  profileSpace: number;
  tierFlag: boolean;
  profileIdc: number;
  profileCompatibilityFlags: number;
  constraintIndicatorFlags: number;
  levelIdc: number;
  lengthSize: number;
  codecString: string;
  description: Uint8Array;
}

export interface Mp4VideoTrack {
  id: number;
  handlerType: string;
  timescale: number;
  duration: number;
  width: number;
  height: number;
  codecType: string;
  hevcConfig: HevcConfigSummary | null;
  hasDolbyVisionConfig: boolean;
  sampleCount: number;
  samples: Mp4Sample[];
}

export interface Mp4ParseResult {
  brands: string[];
  tracks: Mp4VideoTrack[];
}

class Reader {
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

  u32(offset: number): number {
    return this.view.getUint32(offset, false);
  }

  i32(offset: number): number {
    return this.view.getInt32(offset, false);
  }

  u64(offset: number): number {
    return Number(this.view.getBigUint64(offset, false));
  }

  fixed16_16(offset: number): number {
    return this.u32(offset) / 65536;
  }

  ascii(offset: number, length: number): string {
    let out = '';
    for (let i = 0; i < length; i += 1) out += String.fromCharCode(this.u8(offset + i));
    return out;
  }
}

function readBox(reader: Reader, offset: number, parentEnd: number): Mp4BoxInfo | null {
  if (offset + 8 > parentEnd) return null;
  const smallSize = reader.u32(offset);
  const type = reader.ascii(offset + 4, 4);
  let size = smallSize;
  let headerSize = 8;
  if (smallSize === 1) {
    if (offset + 16 > parentEnd) return null;
    size = reader.u64(offset + 8);
    headerSize = 16;
  } else if (smallSize === 0) {
    size = parentEnd - offset;
  }
  if (size < headerSize || offset + size > parentEnd) return null;
  return { type, start: offset, size, headerSize, end: offset + size };
}

function children(reader: Reader, start: number, end: number): Mp4BoxInfo[] {
  const result: Mp4BoxInfo[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBox(reader, offset, end);
    if (!box) break;
    result.push(box);
    offset = box.end;
  }
  return result;
}

function child(reader: Reader, box: Mp4BoxInfo, type: string): Mp4BoxInfo | null {
  return children(reader, box.start + box.headerSize, box.end).find((candidate) => candidate.type === type) ?? null;
}

function parseFtyp(reader: Reader, box: Mp4BoxInfo): string[] {
  const brands = [reader.ascii(box.start + box.headerSize, 4)];
  const compatibleStart = box.start + box.headerSize + 8;
  for (let offset = compatibleStart; offset + 4 <= box.end; offset += 4) {
    brands.push(reader.ascii(offset, 4));
  }
  return brands;
}

function parseTkhd(reader: Reader, box: Mp4BoxInfo): { id: number; width: number; height: number } {
  const version = reader.u8(box.start + box.headerSize);
  const base = box.start + box.headerSize + 4;
  const idOffset = version === 1 ? base + 16 : base + 8;
  const widthOffset = box.end - 8;
  return {
    id: reader.u32(idOffset),
    width: reader.fixed16_16(widthOffset),
    height: reader.fixed16_16(widthOffset + 4),
  };
}

function parseMdhd(reader: Reader, box: Mp4BoxInfo): { timescale: number; duration: number } {
  const version = reader.u8(box.start + box.headerSize);
  const base = box.start + box.headerSize + 4;
  if (version === 1) {
    return {
      timescale: reader.u32(base + 16),
      duration: reader.u64(base + 20),
    };
  }
  return {
    timescale: reader.u32(base + 8),
    duration: reader.u32(base + 12),
  };
}

function parseHdlr(reader: Reader, box: Mp4BoxInfo): string {
  return reader.ascii(box.start + box.headerSize + 8, 4);
}

function parseHvcC(reader: Reader, box: Mp4BoxInfo, brand: 'hvc1' | 'hev1'): HevcConfigSummary {
  return parseHevcDecoderConfigRecord(reader.data.slice(box.start + box.headerSize, box.end), brand);
}

function parseStsd(reader: Reader, box: Mp4BoxInfo): Pick<Mp4VideoTrack, 'codecType' | 'hevcConfig' | 'hasDolbyVisionConfig'> {
  const entryCount = reader.u32(box.start + box.headerSize + 4);
  if (entryCount < 1) return { codecType: 'unknown', hevcConfig: null, hasDolbyVisionConfig: false };
  const entryStart = box.start + box.headerSize + 8;
  const entry = readBox(reader, entryStart, box.end);
  if (!entry) return { codecType: 'unknown', hevcConfig: null, hasDolbyVisionConfig: false };
  const codecType = entry.type;
  const sampleEntryChildren = children(reader, entry.start + entry.headerSize + 78, entry.end);
  const hvcC = sampleEntryChildren.find((candidate) => candidate.type === 'hvcC');
  const hasDolbyVisionConfig = sampleEntryChildren.some((candidate) => candidate.type === 'dvcC' || candidate.type === 'dvvC');
  return {
    codecType,
    hevcConfig: hvcC && (codecType === 'hev1' || codecType === 'hvc1') ? parseHvcC(reader, hvcC, codecType) : null,
    hasDolbyVisionConfig,
  };
}

function parseStts(reader: Reader, box: Mp4BoxInfo): number[] {
  const durations: number[] = [];
  const entryCount = reader.u32(box.start + box.headerSize + 4);
  let offset = box.start + box.headerSize + 8;
  for (let i = 0; i < entryCount; i += 1) {
    const count = reader.u32(offset);
    const delta = reader.u32(offset + 4);
    for (let sample = 0; sample < count; sample += 1) durations.push(delta);
    offset += 8;
  }
  return durations;
}

function parseCtts(reader: Reader, box: Mp4BoxInfo, sampleCount: number): number[] {
  const offsets: number[] = [];
  if (!box) return Array(sampleCount).fill(0);
  const version = reader.u8(box.start + box.headerSize);
  const entryCount = reader.u32(box.start + box.headerSize + 4);
  let offset = box.start + box.headerSize + 8;
  for (let i = 0; i < entryCount; i += 1) {
    const count = reader.u32(offset);
    const compositionOffset = version === 1 ? reader.i32(offset + 4) : reader.u32(offset + 4);
    for (let sample = 0; sample < count; sample += 1) offsets.push(compositionOffset);
    offset += 8;
  }
  while (offsets.length < sampleCount) offsets.push(0);
  return offsets;
}

function parseStsz(reader: Reader, box: Mp4BoxInfo): number[] {
  const sampleSize = reader.u32(box.start + box.headerSize + 4);
  const sampleCount = reader.u32(box.start + box.headerSize + 8);
  if (sampleSize > 0) return Array(sampleCount).fill(sampleSize);
  const sizes: number[] = [];
  let offset = box.start + box.headerSize + 12;
  for (let i = 0; i < sampleCount; i += 1) {
    sizes.push(reader.u32(offset));
    offset += 4;
  }
  return sizes;
}

function parseStco(reader: Reader, box: Mp4BoxInfo): number[] {
  const entryCount = reader.u32(box.start + box.headerSize + 4);
  const offsets: number[] = [];
  let offset = box.start + box.headerSize + 8;
  for (let i = 0; i < entryCount; i += 1) {
    offsets.push(box.type === 'co64' ? reader.u64(offset) : reader.u32(offset));
    offset += box.type === 'co64' ? 8 : 4;
  }
  return offsets;
}

function parseStsc(reader: Reader, box: Mp4BoxInfo): { firstChunk: number; samplesPerChunk: number }[] {
  const entryCount = reader.u32(box.start + box.headerSize + 4);
  const entries: { firstChunk: number; samplesPerChunk: number }[] = [];
  let offset = box.start + box.headerSize + 8;
  for (let i = 0; i < entryCount; i += 1) {
    entries.push({
      firstChunk: reader.u32(offset),
      samplesPerChunk: reader.u32(offset + 4),
    });
    offset += 12;
  }
  return entries;
}

function parseStss(reader: Reader, box: Mp4BoxInfo | null, sampleCount: number): Set<number> {
  if (!box) return new Set(Array.from({ length: sampleCount }, (_, index) => index + 1));
  const sync = new Set<number>();
  const entryCount = reader.u32(box.start + box.headerSize + 4);
  let offset = box.start + box.headerSize + 8;
  for (let i = 0; i < entryCount; i += 1) {
    sync.add(reader.u32(offset));
    offset += 4;
  }
  return sync;
}

function buildSamples(
  sizes: number[],
  durations: number[],
  compositionOffsets: number[],
  chunkOffsets: number[],
  stsc: { firstChunk: number; samplesPerChunk: number }[],
  syncSamples: Set<number>,
): Mp4Sample[] {
  const samples: Mp4Sample[] = [];
  let sampleIndex = 0;
  let dts = 0;
  for (let chunkIndex = 0; chunkIndex < chunkOffsets.length; chunkIndex += 1) {
    const chunkNumber = chunkIndex + 1;
    const entryIndex = stsc.findIndex((entry, index) => {
      const next = stsc[index + 1];
      return chunkNumber >= entry.firstChunk && (!next || chunkNumber < next.firstChunk);
    });
    const samplesPerChunk = stsc[Math.max(entryIndex, 0)]?.samplesPerChunk ?? 1;
    let offset = chunkOffsets[chunkIndex];
    for (let i = 0; i < samplesPerChunk && sampleIndex < sizes.length; i += 1) {
      const duration = durations[sampleIndex] ?? durations[durations.length - 1] ?? 0;
      const cts = dts + (compositionOffsets[sampleIndex] ?? 0);
      samples.push({
        index: sampleIndex,
        offset,
        size: sizes[sampleIndex],
        dts,
        cts,
        duration,
        isSync: syncSamples.has(sampleIndex + 1),
      });
      offset += sizes[sampleIndex];
      dts += duration;
      sampleIndex += 1;
    }
  }
  return samples;
}

function parseVideoTrack(reader: Reader, trak: Mp4BoxInfo): Mp4VideoTrack | null {
  const tkhd = child(reader, trak, 'tkhd');
  const mdia = child(reader, trak, 'mdia');
  if (!tkhd || !mdia) return null;
  const mdhd = child(reader, mdia, 'mdhd');
  const hdlr = child(reader, mdia, 'hdlr');
  const minf = child(reader, mdia, 'minf');
  if (!mdhd || !hdlr || !minf) return null;
  const handlerType = parseHdlr(reader, hdlr);
  if (handlerType !== 'vide') return null;
  const stbl = child(reader, minf, 'stbl');
  if (!stbl) return null;
  const stsd = child(reader, stbl, 'stsd');
  const stts = child(reader, stbl, 'stts');
  const stsz = child(reader, stbl, 'stsz');
  const stco = child(reader, stbl, 'stco') ?? child(reader, stbl, 'co64');
  const stsc = child(reader, stbl, 'stsc');
  if (!stsd || !stts || !stsz || !stco || !stsc) return null;

  const trackHeader = parseTkhd(reader, tkhd);
  const mediaHeader = parseMdhd(reader, mdhd);
  const sampleDescription = parseStsd(reader, stsd);
  const sizes = parseStsz(reader, stsz);
  const durations = parseStts(reader, stts);
  const cttsBox = child(reader, stbl, 'ctts');
  const compositionOffsets = cttsBox ? parseCtts(reader, cttsBox, sizes.length) : Array(sizes.length).fill(0);
  const samples = buildSamples(
    sizes,
    durations,
    compositionOffsets,
    parseStco(reader, stco),
    parseStsc(reader, stsc),
    parseStss(reader, child(reader, stbl, 'stss'), sizes.length),
  );

  return {
    id: trackHeader.id,
    handlerType,
    timescale: mediaHeader.timescale,
    duration: mediaHeader.duration,
    width: trackHeader.width,
    height: trackHeader.height,
    codecType: sampleDescription.codecType,
    hevcConfig: sampleDescription.hevcConfig,
    hasDolbyVisionConfig: sampleDescription.hasDolbyVisionConfig,
    sampleCount: sizes.length,
    samples,
  };
}

export function parseMp4(data: Uint8Array): Mp4ParseResult {
  const reader = new Reader(data);
  const topLevel = children(reader, 0, data.byteLength);
  const ftyp = topLevel.find((box) => box.type === 'ftyp');
  const moov = topLevel.find((box) => box.type === 'moov');
  if (!moov) throw new Error('MP4 moov box not found.');

  const tracks = children(reader, moov.start + moov.headerSize, moov.end)
    .filter((box) => box.type === 'trak')
    .map((trak) => parseVideoTrack(reader, trak))
    .filter((track): track is Mp4VideoTrack => Boolean(track));

  return {
    brands: ftyp ? parseFtyp(reader, ftyp) : [],
    tracks,
  };
}
