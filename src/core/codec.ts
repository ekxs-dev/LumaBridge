export interface HevcCodecConfig {
  brand: 'hvc1' | 'hev1';
  profileSpace?: number;
  profileIdc: number;
  profileCompatibilityFlags?: number;
  tierFlag?: boolean;
  levelIdc: number;
  constraintIndicatorFlags?: number;
}

export function buildHevcCodecString(config: HevcCodecConfig): string {
  const profileSpacePrefix = ['', 'A', 'B', 'C'][config.profileSpace ?? 0] ?? '';
  const profile = `${profileSpacePrefix}${config.profileIdc}`;
  const compatibility = (config.profileCompatibilityFlags ?? 0).toString(16).toUpperCase();
  const tier = config.tierFlag ? 'H' : 'L';
  const level = `${tier}${config.levelIdc}`;
  const constraint = (config.constraintIndicatorFlags ?? 0).toString(16).toUpperCase();
  return `${config.brand}.${profile}.${compatibility}.${level}.B${constraint}`;
}

export function inferCodecFamily(codecName: string): 'hevc' | 'h264' | 'unknown' {
  const normalized = codecName.toLowerCase();
  if (normalized === 'hevc' || normalized === 'h265' || normalized.startsWith('hev1') || normalized.startsWith('hvc1')) {
    return 'hevc';
  }
  if (normalized === 'h264' || normalized === 'avc' || normalized.startsWith('avc1')) {
    return 'h264';
  }
  return 'unknown';
}

export function requireHevc(codecName: string): void {
  if (inferCodecFamily(codecName) !== 'hevc') {
    throw new Error(`Unsupported codec for DV P5 path: ${codecName}`);
  }
}
