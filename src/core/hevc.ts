export const HEVC_NAL_DV_RPU = 62;

export interface HevcNalUnit {
  index: number;
  nalType: number;
  offset: number;
  payloadOffset: number;
  size: number;
}

export interface HevcSampleAnalysis {
  nalUnits: HevcNalUnit[];
  rpuNalUnits: HevcNalUnit[];
  nalUnitCounts: Record<string, number>;
}

function readLength(data: Uint8Array, offset: number, lengthSize: number): number {
  let size = 0;
  for (let i = 0; i < lengthSize; i += 1) {
    size = size * 256 + data[offset + i];
  }
  return size;
}

export function nalTypeFromHeader(headerByte: number): number {
  return (headerByte >> 1) & 0x3f;
}

export function parseLengthPrefixedHevcSample(sample: Uint8Array, lengthSize: number): HevcSampleAnalysis {
  if (lengthSize < 1 || lengthSize > 4) {
    throw new Error(`Unsupported HEVC NAL length size: ${lengthSize}.`);
  }

  const nalUnits: HevcNalUnit[] = [];
  const nalUnitCounts: Record<string, number> = {};
  let offset = 0;
  while (offset + lengthSize <= sample.byteLength) {
    const size = readLength(sample, offset, lengthSize);
    const payloadOffset = offset + lengthSize;
    if (size <= 0 || payloadOffset + size > sample.byteLength) {
      throw new Error(`Invalid HEVC NAL size ${size} at sample offset ${offset}.`);
    }

    const nalType = nalTypeFromHeader(sample[payloadOffset]);
    nalUnits.push({
      index: nalUnits.length,
      nalType,
      offset,
      payloadOffset,
      size,
    });
    nalUnitCounts[nalType] = (nalUnitCounts[nalType] ?? 0) + 1;
    offset = payloadOffset + size;
  }

  if (offset !== sample.byteLength) {
    throw new Error(`HEVC sample ended with ${sample.byteLength - offset} trailing bytes.`);
  }

  return {
    nalUnits,
    rpuNalUnits: nalUnits.filter((unit) => unit.nalType === HEVC_NAL_DV_RPU),
    nalUnitCounts,
  };
}

function findAnnexBStartCodes(data: Uint8Array): { offset: number; length: number }[] {
  const starts: { offset: number; length: number }[] = [];
  let offset = 0;
  while (offset + 3 <= data.byteLength) {
    if (data[offset] === 0 && data[offset + 1] === 0 && data[offset + 2] === 1) {
      starts.push({ offset, length: 3 });
      offset += 3;
      continue;
    }
    if (
      offset + 4 <= data.byteLength
      && data[offset] === 0
      && data[offset + 1] === 0
      && data[offset + 2] === 0
      && data[offset + 3] === 1
    ) {
      starts.push({ offset, length: 4 });
      offset += 4;
      continue;
    }
    offset += 1;
  }
  return starts;
}

export function parseAnnexBHevcStream(data: Uint8Array): HevcSampleAnalysis {
  const starts = findAnnexBStartCodes(data);
  if (starts.length === 0) {
    throw new Error('Annex-B HEVC stream has no start codes.');
  }

  const nalUnits: HevcNalUnit[] = [];
  const nalUnitCounts: Record<string, number> = {};
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const payloadOffset = start.offset + start.length;
    const end = starts[index + 1]?.offset ?? data.byteLength;
    if (payloadOffset + 2 > end) continue;
    const nalType = nalTypeFromHeader(data[payloadOffset]);
    nalUnits.push({
      index: nalUnits.length,
      nalType,
      offset: start.offset,
      payloadOffset,
      size: end - payloadOffset,
    });
    nalUnitCounts[nalType] = (nalUnitCounts[nalType] ?? 0) + 1;
  }

  return {
    nalUnits,
    rpuNalUnits: nalUnits.filter((unit) => unit.nalType === HEVC_NAL_DV_RPU),
    nalUnitCounts,
  };
}

export function analyzeMp4HevcSamples(data: Uint8Array, samples: { offset: number; size: number }[], lengthSize: number): HevcSampleAnalysis {
  const nalUnits: HevcNalUnit[] = [];
  const nalUnitCounts: Record<string, number> = {};

  for (const sample of samples) {
    const analysis = parseLengthPrefixedHevcSample(data.subarray(sample.offset, sample.offset + sample.size), lengthSize);
    for (const unit of analysis.nalUnits) {
      const absoluteUnit = {
        ...unit,
        index: nalUnits.length,
        offset: sample.offset + unit.offset,
        payloadOffset: sample.offset + unit.payloadOffset,
      };
      nalUnits.push(absoluteUnit);
      nalUnitCounts[absoluteUnit.nalType] = (nalUnitCounts[absoluteUnit.nalType] ?? 0) + 1;
    }
  }

  return {
    nalUnits,
    rpuNalUnits: nalUnits.filter((unit) => unit.nalType === HEVC_NAL_DV_RPU),
    nalUnitCounts,
  };
}
