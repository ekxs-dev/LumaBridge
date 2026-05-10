struct FrameParams {
  sourceWidth: u32,
  sourceHeight: u32,
  outputWidth: u32,
  outputHeight: u32,
  yStride: u32,
  uvStride: u32,
  range: u32,
  previewMode: u32,
};

struct DoviParams {
  // ABI: 840 f32 values packed by src/core/metadata.ts and crates/lumabridge_wasm.
  nonlinearOffset: vec4<f32>,
  nonlinearMatrix0: vec4<f32>,
  nonlinearMatrix1: vec4<f32>,
  nonlinearMatrix2: vec4<f32>,
  linearMatrix0: vec4<f32>,
  linearMatrix1: vec4<f32>,
  linearMatrix2: vec4<f32>,
  // x/y: source min/max PQ, z/w: DV Level 1 max/avg PQ.
  sourcePq: vec4<f32>,
  reshapeHeader: vec4<f32>,
  pivots: array<vec4<f32>, 9>,
  pieceMeta: array<vec4<f32>, 24>,
  polyCoeffs: array<vec4<f32>, 24>,
  mmrCoeffs: array<vec4<f32>, 144>,
};

@group(0) @binding(0) var<storage, read> yPlane: array<u32>;
@group(0) @binding(1) var<storage, read> uPlane: array<u32>;
@group(0) @binding(2) var<storage, read> vPlane: array<u32>;
@group(0) @binding(3) var<uniform> frameParams: FrameParams;
@group(0) @binding(4) var<uniform> doviParams: DoviParams;
@group(0) @binding(5) var<storage, read_write> outputPixels: array<u32>;

fn sample_y10(index: u32) -> f32 {
  return f32(yPlane[index] & 0x03ffu);
}

fn sample_u10(index: u32) -> f32 {
  return f32(uPlane[index] & 0x03ffu);
}

fn sample_v10(index: u32) -> f32 {
  return f32(vPlane[index] & 0x03ffu);
}

fn sample_y10_xy(x: u32, y: u32) -> f32 {
  return sample_y10(y * frameParams.yStride + x);
}

fn sample_u10_xy(x: u32, y: u32) -> f32 {
  return sample_u10(y * frameParams.uvStride + x);
}

fn sample_v10_xy(x: u32, y: u32) -> f32 {
  return sample_v10(y * frameParams.uvStride + x);
}

fn normalize_y(sample: f32) -> f32 {
  if (frameParams.range == 0u) {
    return sample / 1023.0;
  }
  return clamp((sample - 64.0) / (940.0 - 64.0), 0.0, 1.0);
}

fn normalize_uv(sample: f32) -> f32 {
  if (frameParams.range == 0u) {
    return sample / 1023.0;
  }
  return clamp((sample - 64.0) / (960.0 - 64.0), 0.0, 1.0);
}

fn sample_y_linear(coord: vec2<f32>) -> f32 {
  let maxX = frameParams.sourceWidth - 1u;
  let maxY = frameParams.sourceHeight - 1u;
  let x = clamp(coord.x, 0.0, f32(maxX));
  let y = clamp(coord.y, 0.0, f32(maxY));
  let x0 = u32(floor(x));
  let y0 = u32(floor(y));
  let x1 = min(maxX, x0 + 1u);
  let y1 = min(maxY, y0 + 1u);
  let fx = fract(x);
  let fy = fract(y);
  let top = mix(normalize_y(sample_y10_xy(x0, y0)), normalize_y(sample_y10_xy(x1, y0)), fx);
  let bottom = mix(normalize_y(sample_y10_xy(x0, y1)), normalize_y(sample_y10_xy(x1, y1)), fx);
  return mix(top, bottom, fy);
}

fn sample_u_linear(coord: vec2<f32>) -> f32 {
  let chromaWidth = (frameParams.sourceWidth + 1u) / 2u;
  let chromaHeight = (frameParams.sourceHeight + 1u) / 2u;
  let maxX = chromaWidth - 1u;
  let maxY = chromaHeight - 1u;
  let x = clamp(coord.x, 0.0, f32(maxX));
  let y = clamp(coord.y, 0.0, f32(maxY));
  let x0 = u32(floor(x));
  let y0 = u32(floor(y));
  let x1 = min(maxX, x0 + 1u);
  let y1 = min(maxY, y0 + 1u);
  let fx = fract(x);
  let fy = fract(y);
  let top = mix(normalize_uv(sample_u10_xy(x0, y0)), normalize_uv(sample_u10_xy(x1, y0)), fx);
  let bottom = mix(normalize_uv(sample_u10_xy(x0, y1)), normalize_uv(sample_u10_xy(x1, y1)), fx);
  return mix(top, bottom, fy);
}

fn sample_v_linear(coord: vec2<f32>) -> f32 {
  let chromaWidth = (frameParams.sourceWidth + 1u) / 2u;
  let chromaHeight = (frameParams.sourceHeight + 1u) / 2u;
  let maxX = chromaWidth - 1u;
  let maxY = chromaHeight - 1u;
  let x = clamp(coord.x, 0.0, f32(maxX));
  let y = clamp(coord.y, 0.0, f32(maxY));
  let x0 = u32(floor(x));
  let y0 = u32(floor(y));
  let x1 = min(maxX, x0 + 1u);
  let y1 = min(maxY, y0 + 1u);
  let fx = fract(x);
  let fy = fract(y);
  let top = mix(normalize_uv(sample_v10_xy(x0, y0)), normalize_uv(sample_v10_xy(x1, y0)), fx);
  let bottom = mix(normalize_uv(sample_v10_xy(x0, y1)), normalize_uv(sample_v10_xy(x1, y1)), fx);
  return mix(top, bottom, fy);
}

fn pq_eotf(code: f32) -> f32 {
  let m1 = 2610.0 / 16384.0;
  let m2 = (2523.0 / 4096.0) * 128.0;
  let c1 = 3424.0 / 4096.0;
  let c2 = (2413.0 / 4096.0) * 32.0;
  let c3 = (2392.0 / 4096.0) * 32.0;
  let v = pow(max(code, 0.0), 1.0 / m2);
  return 10000.0 * pow(max(v - c1, 0.0) / (c2 - c3 * v), 1.0 / m1);
}

fn pq_oetf(nits: f32) -> f32 {
  let m1 = 2610.0 / 16384.0;
  let m2 = (2523.0 / 4096.0) * 128.0;
  let c1 = 3424.0 / 4096.0;
  let c2 = (2413.0 / 4096.0) * 32.0;
  let c3 = (2392.0 / 4096.0) * 32.0;
  let normalized = pow(max(nits / 10000.0, 0.0), m1);
  return pow((c1 + c2 * normalized) / (1.0 + c3 * normalized), m2);
}

fn yuv2020_to_rgb(y: f32, u: f32, v: f32) -> vec3<f32> {
  let cb = u - 0.5;
  let cr = v - 0.5;
  return vec3<f32>(
    y + 1.4746 * cr,
    y - 0.16455 * cb - 0.57135 * cr,
    y + 1.8814 * cb
  );
}

fn bt2020_to_bt709(rgb: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    1.6605 * rgb.r - 0.5876 * rgb.g - 0.0728 * rgb.b,
    -0.1246 * rgb.r + 1.1329 * rgb.g - 0.0083 * rgb.b,
    -0.0182 * rgb.r - 0.1006 * rgb.g + 1.1187 * rgb.b
  );
}

fn bt2020_rgb_to_ipt_lms(rgb: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    0.412036387 * rgb.r + 0.523911912 * rgb.g + 0.064054982 * rgb.b,
    0.166660219 * rgb.r + 0.720395213 * rgb.g + 0.112946123 * rgb.b,
    0.024112359 * rgb.r + 0.075474963 * rgb.g + 0.900407937 * rgb.b
  );
}

fn bt709_ipt_lms_to_rgb(lms: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    6.173532658 * lms.x - 5.320898821 * lms.y + 0.147354885 * lms.z,
    -1.324031910 * lms.x + 2.560269770 * lms.y - 0.236238618 * lms.z,
    -0.011598388 * lms.x - 0.264921447 * lms.y + 1.276526337 * lms.z
  );
}

fn ipt_lms_to_ipt(lms: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    0.4000 * lms.x + 0.4000 * lms.y + 0.2000 * lms.z,
    4.4550 * lms.x - 4.8510 * lms.y + 0.3960 * lms.z,
    0.8056 * lms.x + 0.3572 * lms.y - 1.1628 * lms.z
  );
}

fn dovi_ipt_to_lms(ipt: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    ipt.x + 0.0975689 * ipt.y + 0.205226 * ipt.z,
    ipt.x - 0.113876 * ipt.y + 0.133217 * ipt.z,
    ipt.x + 0.0326151 * ipt.y - 0.676887 * ipt.z
  );
}

fn dovi_lms_to_bt2020(lms: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    3.06441879 * lms.x - 2.16597676 * lms.y + 0.10155818 * lms.z,
    -0.65612108 * lms.x + 1.78554118 * lms.y - 0.12943749 * lms.z,
    0.01736321 * lms.x - 0.04725154 * lms.y + 1.03004253 * lms.z
  );
}

fn dovi_poly(signal: f32, coeffs: vec3<f32>) -> f32 {
  return (coeffs.z * signal + coeffs.y) * signal + coeffs.x;
}

fn dovi_matrix3_mul(row0: vec4<f32>, row1: vec4<f32>, row2: vec4<f32>, value: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(row0.xyz, value),
    dot(row1.xyz, value),
    dot(row2.xyz, value)
  );
}

fn pivot_value(component: u32, pivotIndex: u32) -> f32 {
  let flat = component * 12u + pivotIndex;
  let row = flat / 4u;
  let col = flat % 4u;
  return doviParams.pivots[row][col];
}

fn piece_meta(component: u32, pieceIndex: u32) -> vec4<f32> {
  return doviParams.pieceMeta[component * 8u + pieceIndex];
}

fn poly_coeffs(component: u32, pieceIndex: u32) -> vec4<f32> {
  return doviParams.polyCoeffs[component * 8u + pieceIndex];
}

fn mmr_coeffs(component: u32, pieceIndex: u32, orderIndex: u32, pairIndex: u32) -> vec4<f32> {
  return doviParams.mmrCoeffs[((component * 8u + pieceIndex) * 3u + orderIndex) * 2u + pairIndex];
}

fn reshape_component(component: u32, signal: f32, sig: vec3<f32>) -> f32 {
  let pivotCount = max(2u, min(9u, u32(round(doviParams.reshapeHeader[component]))));
  var pieceIndex = 0u;
  for (var i = 1u; i < 8u; i = i + 1u) {
    if (i < pivotCount - 1u && signal >= pivot_value(component, i)) {
      pieceIndex = i;
    }
  }

  let pieceInfo = piece_meta(component, pieceIndex);
  var outSignal = signal;
  if (pieceInfo.x < 0.5) {
    outSignal = dovi_poly(signal, poly_coeffs(component, pieceIndex).xyz);
  } else {
    let order = max(1u, min(3u, u32(round(pieceInfo.w))));
    let sigX = vec4<f32>(sig.x * sig.y, sig.x * sig.z, sig.y * sig.z, sig.x * sig.y * sig.z);
    outSignal = pieceInfo.y;
    let mmr0a = mmr_coeffs(component, pieceIndex, 0u, 0u);
    let mmr0b = mmr_coeffs(component, pieceIndex, 0u, 1u);
    outSignal = outSignal + dot(mmr0a.xyz, sig);
    outSignal = outSignal + dot(mmr0b, sigX);
    if (order >= 2u) {
      let sig2 = sig * sig;
      let sigX2 = sigX * sigX;
      let mmr1a = mmr_coeffs(component, pieceIndex, 1u, 0u);
      let mmr1b = mmr_coeffs(component, pieceIndex, 1u, 1u);
      outSignal = outSignal + dot(mmr1a.xyz, sig2);
      outSignal = outSignal + dot(mmr1b, sigX2);
      if (order >= 3u) {
        let mmr2a = mmr_coeffs(component, pieceIndex, 2u, 0u);
        let mmr2b = mmr_coeffs(component, pieceIndex, 2u, 1u);
        outSignal = outSignal + dot(mmr2a.xyz, sig2 * sig);
        outSignal = outSignal + dot(mmr2b, sigX2 * sigX);
      }
    }
  }

  let lo = pivot_value(component, 0u);
  let hi = pivot_value(component, pivotCount - 1u);
  return clamp(outSignal, lo, hi);
}

fn tone_map_bt2390_pq(code: f32, inputMaxPq: f32) -> f32 {
  let outputMaxPq = pq_oetf(100.0);
  let safeInputMax = max(inputMaxPq, outputMaxPq + 0.0001);
  let maxLum = clamp(outputMaxPq / safeInputMax, 0.0, 1.0);
  let kneeStart = 2.0 * maxLum - 1.0;
  var x = clamp(code / safeInputMax, 0.0, 1.0);

  if (kneeStart < 1.0 && x >= kneeStart) {
    let t = clamp((x - kneeStart) / (1.0 - kneeStart), 0.0, 1.0);
    let t2 = t * t;
    let t3 = t2 * t;
    x = (2.0 * t3 - 3.0 * t2 + 1.0) * kneeStart
      + (t3 - 2.0 * t2 + t) * (1.0 - kneeStart)
      + (-2.0 * t3 + 3.0 * t2) * maxLum;
  }

  return clamp(x * safeInputMax, 0.0, outputMaxPq);
}

fn tone_map_bt2390_to_sdr(rgb2020Nits: vec3<f32>, inputMaxPq: f32) -> vec3<f32> {
  let targetNits = 100.0;
  let lmsNits = bt2020_rgb_to_ipt_lms(max(rgb2020Nits, vec3<f32>(0.0)));
  let lmsPq = vec3<f32>(
    pq_oetf(lmsNits.x),
    pq_oetf(lmsNits.y),
    pq_oetf(lmsNits.z)
  );
  let ipt = ipt_lms_to_ipt(lmsPq);
  let iOrig = max(ipt.x, 0.000001);
  let mappedI = max(tone_map_bt2390_pq(ipt.x, inputMaxPq), 0.000001);
  let hullOrig = ((iOrig - 6.0) * iOrig + 9.0) * iOrig;
  let hullMapped = ((mappedI - 6.0) * mappedI + 9.0) * mappedI;
  let chromaScale = max(0.0, min(iOrig / mappedI, hullMapped / max(hullOrig, 0.000001)));
  let mappedIpt = vec3<f32>(mappedI, ipt.y * chromaScale, ipt.z * chromaScale);
  let outLmsPq = dovi_ipt_to_lms(mappedIpt);
  let outLmsNits = vec3<f32>(
    pq_eotf(outLmsPq.x),
    pq_eotf(outLmsPq.y),
    pq_eotf(outLmsPq.z)
  );
  let rgb709Linear = bt709_ipt_lms_to_rgb(outLmsNits) / vec3<f32>(targetNits);
  return srgb_encode(rgb709Linear);
}

fn srgb_encode(linear: vec3<f32>) -> vec3<f32> {
  let value = clamp(linear, vec3<f32>(0.0), vec3<f32>(1.0));
  let low = value * vec3<f32>(12.92);
  let high = vec3<f32>(1.055) * pow(value, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055);
  return select(high, low, value <= vec3<f32>(0.0031308));
}

fn pack_rgba8(rgb: vec3<f32>) -> u32 {
  let clamped = clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0));
  let rgba = vec4<u32>(
    u32(round(clamped.r * 255.0)),
    u32(round(clamped.g * 255.0)),
    u32(round(clamped.b * 255.0)),
    255u
  );
  return rgba.r | (rgba.g << 8u) | (rgba.b << 16u) | (rgba.a << 24u);
}

fn render_luma(y: f32) -> vec3<f32> {
  let encoded = srgb_encode(vec3<f32>(y));
  return encoded;
}

fn render_pq_sdr(y: f32, u: f32, v: f32) -> vec3<f32> {
  let rgb2020 = clamp(yuv2020_to_rgb(y, u, v), vec3<f32>(0.0), vec3<f32>(1.0));
  let nits = vec3<f32>(pq_eotf(rgb2020.r), pq_eotf(rgb2020.g), pq_eotf(rgb2020.b));
  return tone_map_bt2390_to_sdr(nits, pq_oetf(1000.0));
}

fn render_dovi_p5_base(y: f32, u: f32, v: f32) -> vec3<f32> {
  let ipt = vec3<f32>(y, u - 0.5, v - 0.5);
  let lmsCode = clamp(dovi_ipt_to_lms(ipt), vec3<f32>(0.0), vec3<f32>(1.0));
  let lmsNits = vec3<f32>(pq_eotf(lmsCode.x), pq_eotf(lmsCode.y), pq_eotf(lmsCode.z));
  let rgb2020 = dovi_lms_to_bt2020(lmsNits);
  return tone_map_bt2390_to_sdr(rgb2020, pq_oetf(1000.0));
}

fn render_dovi_rpu(y: f32, u: f32, v: f32) -> vec3<f32> {
  let encoded = vec3<f32>(y, u, v);
  let reshaped = vec3<f32>(
    reshape_component(0u, encoded.x, encoded),
    reshape_component(1u, encoded.y, encoded),
    reshape_component(2u, encoded.z, encoded)
  );
  let doviOffsetScale = 1024.0 / 1023.0;
  let nonlinearInput = reshaped - doviParams.nonlinearOffset.xyz * vec3<f32>(doviOffsetScale);
  let lmsCode = clamp(dovi_matrix3_mul(
    doviParams.nonlinearMatrix0,
    doviParams.nonlinearMatrix1,
    doviParams.nonlinearMatrix2,
    nonlinearInput
  ), vec3<f32>(0.0), vec3<f32>(1.0));
  let lmsLinear = vec3<f32>(pq_eotf(lmsCode.x), pq_eotf(lmsCode.y), pq_eotf(lmsCode.z));
  let sourceRgbLinear = dovi_matrix3_mul(
    doviParams.linearMatrix0,
    doviParams.linearMatrix1,
    doviParams.linearMatrix2,
    lmsLinear
  );
  let rgb2020Nits = dovi_lms_to_bt2020(sourceRgbLinear);
  let inputMaxPq = select(doviParams.sourcePq.y, doviParams.sourcePq.z, doviParams.sourcePq.z > 0.0);
  return tone_map_bt2390_to_sdr(rgb2020Nits, inputMaxPq);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= frameParams.outputWidth || id.y >= frameParams.outputHeight) {
    return;
  }

  let sourceCoord = vec2<f32>(
    (f32(id.x) + 0.5) * f32(frameParams.sourceWidth) / f32(frameParams.outputWidth) - 0.5,
    (f32(id.y) + 0.5) * f32(frameParams.sourceHeight) / f32(frameParams.outputHeight) - 0.5
  );
  // The current DV fixtures report AVCHROMA_LOC_LEFT: horizontally co-sited
  // with the left luma sample and vertically centered for 4:2:0.
  let chromaCoord = vec2<f32>(sourceCoord.x * 0.5, (sourceCoord.y - 0.5) * 0.5);
  let y = sample_y_linear(sourceCoord);
  let u = sample_u_linear(chromaCoord);
  let v = sample_v_linear(chromaCoord);

  var rgb = render_dovi_rpu(y, u, v);
  if (frameParams.previewMode == 1u) {
    rgb = render_luma(y);
  } else if (frameParams.previewMode == 2u) {
    rgb = render_dovi_p5_base(y, u, v);
  } else if (doviParams.reshapeHeader.x < 1.5) {
    rgb = render_pq_sdr(y, u, v);
  }

  outputPixels[id.y * frameParams.outputWidth + id.x] = pack_rgba8(rgb);
}
