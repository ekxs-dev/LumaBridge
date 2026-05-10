export function normalizeYuv10Sample(sample: number, range: 'full' | 'limited', channel: 'y' | 'uv'): number {
  if (range === 'full') {
    return sample / 1023;
  }

  const min = channel === 'y' ? 64 : 64;
  const max = channel === 'y' ? 940 : 960;
  return Math.min(1, Math.max(0, (sample - min) / (max - min)));
}

export function pqEotf(code: number): number {
  const m1 = 2610 / 16384;
  const m2 = (2523 / 4096) * 128;
  const c1 = 3424 / 4096;
  const c2 = (2413 / 4096) * 32;
  const c3 = (2392 / 4096) * 32;
  const v = Math.max(code, 0) ** (1 / m2);
  const numerator = Math.max(v - c1, 0);
  const denominator = c2 - c3 * v;
  return 10_000 * (numerator / denominator) ** (1 / m1);
}

export function pqOetf(nits: number): number {
  const m1 = 2610 / 16384;
  const m2 = (2523 / 4096) * 128;
  const c1 = 3424 / 4096;
  const c2 = (2413 / 4096) * 32;
  const c3 = (2392 / 4096) * 32;
  const normalized = Math.max(0, nits / 10_000) ** m1;
  return ((c1 + c2 * normalized) / (1 + c3 * normalized)) ** m2;
}

export function yuvBt2020ToRgb(y: number, u: number, v: number): [number, number, number] {
  const cb = u - 0.5;
  const cr = v - 0.5;
  return [
    y + 1.4746 * cr,
    y - 0.16455 * cb - 0.57135 * cr,
    y + 1.8814 * cb,
  ];
}

export function bt2020ToBt709(rgb: [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb;
  return [
    1.6605 * r - 0.5876 * g - 0.0728 * b,
    -0.1246 * r + 1.1329 * g - 0.0083 * b,
    -0.0182 * r - 0.1006 * g + 1.1187 * b,
  ];
}

export function doviIptToLms(ipt: [number, number, number]): [number, number, number] {
  const [i, p, t] = ipt;
  return [
    i + 0.0975689 * p + 0.205226 * t,
    i - 0.113876 * p + 0.133217 * t,
    i + 0.0326151 * p - 0.676887 * t,
  ];
}

export function doviLmsToBt2020(lms: [number, number, number]): [number, number, number] {
  const [l, m, s] = lms;
  return [
    3.06441879 * l - 2.16597676 * m + 0.10155818 * s,
    -0.65612108 * l + 1.78554118 * m - 0.12943749 * s,
    0.01736321 * l - 0.04725154 * m + 1.03004253 * s,
  ];
}

export function reshapePolynomial(signal: number, coeffs: [number, number, number]): number {
  return (coeffs[2] * signal + coeffs[1]) * signal + coeffs[0];
}

export function reshapeMmr(sig: [number, number, number], constant: number, coeffs: number[]): number {
  const [x, y, z] = sig;
  const basis = [x, y, z, x * y, x * z, y * z, x * y * z];
  return constant + basis.reduce((sum, value, index) => sum + value * (coeffs[index] ?? 0), 0);
}

export function reinhardToneMap(nits: number, targetNits = 100): number {
  const normalized = Math.max(0, nits / targetNits);
  return normalized / (1 + normalized);
}

export function bt2390ToneMapPq(
  code: number,
  inputMaxPq: number,
  outputMaxPq = pqOetf(100),
  inputMinPq = 0,
  outputMinPq = 0,
): number {
  const inputRange = Math.max(1e-6, inputMaxPq - inputMinPq);
  const minLum = (outputMinPq - inputMinPq) / inputRange;
  const maxLum = (outputMaxPq - inputMinPq) / inputRange;
  const kneeOffset = 1;
  const kneeStart = (1 + kneeOffset) * maxLum - kneeOffset;
  const blackPower = minLum > 0 ? Math.min(1 / minLum, 4) : 4;
  const gainInv = 1 + (minLum / Math.max(maxLum, 1e-6)) * (1 - maxLum) ** blackPower;
  const gain = maxLum < 1 ? 1 / gainInv : 1;

  let x = Math.min(1, Math.max(0, (code - inputMinPq) / inputRange));
  if (kneeStart < 1 && x >= kneeStart) {
    const t = Math.min(1, Math.max(0, (x - kneeStart) / (1 - kneeStart)));
    const t2 = t * t;
    const t3 = t2 * t;
    x = (2 * t3 - 3 * t2 + 1) * kneeStart
      + (t3 - 2 * t2 + t) * (1 - kneeStart)
      + (-2 * t3 + 3 * t2) * maxLum;
  }

  if (x < 1) {
    x += minLum * (1 - x) ** blackPower;
    x = gain * (x - minLum) + minLum;
  }

  return Math.min(outputMaxPq, Math.max(outputMinPq, x * inputRange + inputMinPq));
}

export function bt2390ToneMap(nits: number, sourceMaxNits = 1000, targetNits = 100): number {
  const inputMaxPq = pqOetf(Math.max(targetNits, sourceMaxNits));
  const outputMaxPq = pqOetf(targetNits);
  const mappedPq = bt2390ToneMapPq(pqOetf(nits), inputMaxPq, outputMaxPq);
  return pqEotf(mappedPq) / targetNits;
}
