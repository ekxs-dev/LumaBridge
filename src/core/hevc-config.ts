import { buildHevcCodecString } from './codec';
import type { HevcConfigSummary } from './mp4';

export function parseHevcDecoderConfigRecord(description: Uint8Array, brand: 'hvc1' | 'hev1' = 'hev1'): HevcConfigSummary {
  if (description.byteLength < 23) {
    throw new Error('HEVC decoder configuration record is too short.');
  }

  const view = new DataView(description.buffer, description.byteOffset, description.byteLength);
  const profileByte = view.getUint8(1);
  const profileSpace = profileByte >> 6;
  const tierFlag = Boolean(profileByte & 0x20);
  const profileIdc = profileByte & 0x1f;
  const profileCompatibilityFlags = view.getUint32(2, false);
  let constraintIndicatorFlags = 0;
  for (let i = 0; i < 6; i += 1) {
    constraintIndicatorFlags = constraintIndicatorFlags * 256 + view.getUint8(6 + i);
  }
  const levelIdc = view.getUint8(12);
  const lengthSize = (view.getUint8(21) & 0x03) + 1;

  return {
    configurationVersion: view.getUint8(0),
    profileSpace,
    tierFlag,
    profileIdc,
    profileCompatibilityFlags,
    constraintIndicatorFlags,
    levelIdc,
    lengthSize,
    codecString: buildHevcCodecString({
      brand,
      profileSpace,
      profileIdc,
      profileCompatibilityFlags,
      tierFlag,
      levelIdc,
      constraintIndicatorFlags,
    }),
    description,
  };
}
