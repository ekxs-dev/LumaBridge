import { ToneBridgeError, type ToneBridgeErrorCode } from './errors';

export interface RuntimeFeatureSet {
  hasWebGPU: boolean;
  hasWebCodecs: boolean;
  hevcSupported: boolean;
  outputFormat?: string | null;
  colorSpace?: {
    primaries?: string | null;
    transfer?: string | null;
    matrix?: string | null;
    fullRange?: boolean | null;
  } | null;
  rpuPresent?: boolean;
}

export interface CapabilityReport {
  ok: boolean;
  failures: ToneBridgeErrorCode[];
  warnings: string[];
}

export function evaluateCapabilities(features: RuntimeFeatureSet): CapabilityReport {
  const failures: ToneBridgeErrorCode[] = [];
  const warnings: string[] = [];

  if (!features.hasWebGPU) failures.push('WEBGPU_UNAVAILABLE');
  if (!features.hasWebCodecs) failures.push('WEBCODECS_UNAVAILABLE');
  if (!features.hevcSupported) failures.push('HEVC_UNSUPPORTED');
  if (Object.hasOwn(features, 'outputFormat')) {
    if (features.outputFormat !== 'I420P10') failures.push('I420P10_REQUIRED');
  } else {
    warnings.push('VideoFrame output format has not been observed yet.');
  }

  if (features.outputFormat === null) {
    warnings.push('VideoFrame output is opaque; raw copyTo() planes are unavailable.');
  }

  if (features.colorSpace) {
    const { primaries, transfer, matrix } = features.colorSpace;
    if (primaries !== 'bt2020' || transfer !== 'pq' || matrix !== 'bt2020-ncl') {
      failures.push('COLORSPACE_INCOMPLETE');
    }
  }

  if (features.rpuPresent === false) failures.push('RPU_REQUIRED');
  return {
    ok: failures.length === 0,
    failures,
    warnings,
  };
}

export function assertDvPreviewReady(features: RuntimeFeatureSet): void {
  const report = evaluateCapabilities(features);
  if (!report.ok) {
    throw new ToneBridgeError(report.failures[0], `ToneBridge capability check failed: ${report.failures.join(', ')}`);
  }
}

export async function probeBrowserCapabilities(codec = 'hev1.2.4.L153.B0'): Promise<RuntimeFeatureSet> {
  const hasWebGPU = Boolean(typeof navigator !== 'undefined' && 'gpu' in navigator);
  const hasWebCodecs = typeof globalThis.VideoDecoder !== 'undefined';
  let hevcSupported = false;

  if (hasWebCodecs) {
    try {
      const support = await VideoDecoder.isConfigSupported({
        codec,
        codedWidth: 3840,
        codedHeight: 1608,
        hardwareAcceleration: 'prefer-hardware',
      });
      hevcSupported = Boolean(support.supported);
    } catch {
      hevcSupported = false;
    }
  }

  return {
    hasWebGPU,
    hasWebCodecs,
    hevcSupported,
  };
}
