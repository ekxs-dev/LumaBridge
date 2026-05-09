struct FrameParams {
  width: u32,
  height: u32,
  yStride: u32,
  uvStride: u32,
  range: u32,
  _pad0: vec3<u32>,
};

struct DoviParams {
  nonlinearOffset: vec4<f32>,
  nonlinearMatrix0: vec4<f32>,
  nonlinearMatrix1: vec4<f32>,
  nonlinearMatrix2: vec4<f32>,
  linearMatrix0: vec4<f32>,
  linearMatrix1: vec4<f32>,
  linearMatrix2: vec4<f32>,
  sourcePq: vec4<f32>,
  pivots: array<vec4<f32>, 7>,
  polyCoeffs: array<vec4<f32>, 18>,
  mmrCoeffs: array<vec4<f32>, 36>,
};

@group(0) @binding(0) var<storage, read> yPlane: array<u32>;
@group(0) @binding(1) var<storage, read> uPlane: array<u32>;
@group(0) @binding(2) var<storage, read> vPlane: array<u32>;
@group(0) @binding(3) var<uniform> frameParams: FrameParams;
@group(0) @binding(4) var<uniform> doviParams: DoviParams;

fn sample10(buffer: array<u32>, index: u32) -> f32 {
  return f32(buffer[index] & 0x03ffu);
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

fn pq_eotf(code: f32) -> f32 {
  let m1 = 2610.0 / 16384.0;
  let m2 = (2523.0 / 4096.0) * 128.0;
  let c1 = 3424.0 / 4096.0;
  let c2 = (2413.0 / 4096.0) * 32.0;
  let c3 = (2392.0 / 4096.0) * 32.0;
  let v = pow(max(code, 0.0), 1.0 / m2);
  return 10000.0 * pow(max(v - c1, 0.0) / (c2 - c3 * v), 1.0 / m1);
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
  return mat3x3<f32>(
    vec3<f32>(1.6605, -0.1246, -0.0182),
    vec3<f32>(-0.5876, 1.1329, -0.1006),
    vec3<f32>(-0.0728, -0.0083, 1.1187)
  ) * rgb;
}

fn dovi_poly(signal: f32, coeffs: vec3<f32>) -> f32 {
  return (coeffs.z * signal + coeffs.y) * signal + coeffs.x;
}

fn tone_map_reinhard(nits: vec3<f32>) -> vec3<f32> {
  let normalized = max(nits / vec3<f32>(100.0), vec3<f32>(0.0));
  return normalized / (vec3<f32>(1.0) + normalized);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= frameParams.width || id.y >= frameParams.height) {
    return;
  }

  let yIndex = id.y * frameParams.yStride + id.x;
  let uvIndex = (id.y / 2u) * frameParams.uvStride + (id.x / 2u);
  let y = normalize_y(sample10(yPlane, yIndex));
  let u = normalize_uv(sample10(uPlane, uvIndex));
  let v = normalize_uv(sample10(vPlane, uvIndex));

  let reshaped = vec3<f32>(
    dovi_poly(y, doviParams.polyCoeffs[0].xyz),
    dovi_poly(u, doviParams.polyCoeffs[1].xyz),
    dovi_poly(v, doviParams.polyCoeffs[2].xyz)
  );
  let rgb2020 = yuv2020_to_rgb(reshaped.x, reshaped.y, reshaped.z);
  let nits = vec3<f32>(pq_eotf(rgb2020.r), pq_eotf(rgb2020.g), pq_eotf(rgb2020.b));
  let sdr709 = bt2020_to_bt709(tone_map_reinhard(nits));
  _ = clamp(sdr709, vec3<f32>(0.0), vec3<f32>(1.0));
}
