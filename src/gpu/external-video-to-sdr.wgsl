struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct PreviewParams {
  recoveryMode: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
};

@group(0) @binding(0) var videoTexture: texture_external;
@group(0) @binding(1) var videoSampler: sampler;
@group(0) @binding(2) var<uniform> previewParams: PreviewParams;

@vertex
fn vertex_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  let position = positions[vertexIndex];
  var output: VertexOutput;
  output.position = vec4<f32>(position, 0.0, 1.0);
  output.uv = position * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
  return output;
}

fn srgb_to_linear(encoded: vec3<f32>) -> vec3<f32> {
  let value = clamp(encoded, vec3<f32>(0.0), vec3<f32>(1.0));
  let low = value / vec3<f32>(12.92);
  let high = pow((value + vec3<f32>(0.055)) / vec3<f32>(1.055), vec3<f32>(2.4));
  return select(high, low, value <= vec3<f32>(0.04045));
}

fn linear_to_srgb(linear: vec3<f32>) -> vec3<f32> {
  let value = clamp(linear, vec3<f32>(0.0), vec3<f32>(1.0));
  let low = value * vec3<f32>(12.92);
  let high = vec3<f32>(1.055) * pow(value, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055);
  return select(high, low, value <= vec3<f32>(0.0031308));
}

fn aces_filmic(value: vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((value * (a * value + vec3<f32>(b))) / (value * (c * value + vec3<f32>(d)) + vec3<f32>(e)), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn approximate_sdr_from_browser_rgb(rgb: vec3<f32>) -> vec3<f32> {
  let linear = srgb_to_linear(rgb);
  let luma = dot(linear, vec3<f32>(0.2126, 0.7152, 0.0722));
  let softened = aces_filmic(linear * vec3<f32>(1.35));
  let desaturated = mix(vec3<f32>(luma), softened, 0.82);
  return linear_to_srgb(desaturated);
}

fn pq_eotf(code: f32) -> f32 {
  let m1 = 2610.0 / 16384.0;
  let m2 = (2523.0 / 4096.0) * 128.0;
  let c1 = 3424.0 / 4096.0;
  let c2 = (2413.0 / 4096.0) * 32.0;
  let c3 = (2392.0 / 4096.0) * 32.0;
  let v = pow(max(code, 0.0), 1.0 / m2);
  return 10000.0 * pow(max(v - c1, 0.0) / max(c2 - c3 * v, 0.000001), 1.0 / m1);
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

fn bt2020_to_bt709(rgb: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    1.6605 * rgb.r - 0.5876 * rgb.g - 0.0728 * rgb.b,
    -0.1246 * rgb.r + 1.1329 * rgb.g - 0.0083 * rgb.b,
    -0.0182 * rgb.r - 0.1006 * rgb.g + 1.1187 * rgb.b
  );
}

fn bt1886_oetf(linear: vec3<f32>) -> vec3<f32> {
  let value = max(linear, vec3<f32>(0.0));
  let minLum = 1.0 / 1000.0;
  let lb = pow(minLum, 1.0 / 2.4);
  return clamp((pow(value, vec3<f32>(1.0 / 2.4)) - vec3<f32>(lb)) / vec3<f32>(1.0 - lb), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn browser_bt709_rgb_to_yuv(rgb: vec3<f32>) -> vec3<f32> {
  let y = dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
  let u = (rgb.b - y) / 1.8556 + 0.5;
  let v = (rgb.r - y) / 1.5748 + 0.5;
  return vec3<f32>(clamp(y, 0.0, 1.0), clamp(u, 0.0, 1.0), clamp(v, 0.0, 1.0));
}

fn browser_bt2020_rgb_to_yuv(rgb: vec3<f32>) -> vec3<f32> {
  let y = dot(rgb, vec3<f32>(0.2627, 0.6780, 0.0593));
  let u = (rgb.b - y) / 1.8814 + 0.5;
  let v = (rgb.r - y) / 1.4746 + 0.5;
  return vec3<f32>(clamp(y, 0.0, 1.0), clamp(u, 0.0, 1.0), clamp(v, 0.0, 1.0));
}

fn expand_limited_yuv(yuv: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    clamp((yuv.x - 16.0 / 255.0) * (255.0 / 219.0), 0.0, 1.0),
    clamp((yuv.y - 16.0 / 255.0) * (255.0 / 224.0), 0.0, 1.0),
    clamp((yuv.z - 16.0 / 255.0) * (255.0 / 224.0), 0.0, 1.0)
  );
}

fn adjust_yuv_by_recovery_mode(yuv: vec3<f32>, mode: u32) -> vec3<f32> {
  var adjusted = yuv;
  if (mode == 3u || mode == 4u) {
    adjusted = expand_limited_yuv(adjusted);
  }
  if (mode == 5u || mode == 6u) {
    adjusted = vec3<f32>(adjusted.x, adjusted.z, adjusted.y);
  }
  if (mode == 7u || mode == 8u) {
    adjusted = vec3<f32>(adjusted.x, 1.0 - adjusted.y, adjusted.z);
  }
  if (mode == 9u || mode == 10u) {
    adjusted = vec3<f32>(adjusted.x, adjusted.y, 1.0 - adjusted.z);
  }
  if (mode == 11u || mode == 12u) {
    adjusted = vec3<f32>(adjusted.x, 1.0 - adjusted.y, 1.0 - adjusted.z);
  }
  return adjusted;
}

fn dovi_p5_base_to_sdr(yuvLike: vec3<f32>) -> vec3<f32> {
  let ipt = vec3<f32>(yuvLike.x, yuvLike.y - 0.5, yuvLike.z - 0.5);
  let lmsCode = clamp(dovi_ipt_to_lms(ipt), vec3<f32>(0.0), vec3<f32>(1.0));
  let lmsNits = vec3<f32>(
    pq_eotf(lmsCode.x),
    pq_eotf(lmsCode.y),
    pq_eotf(lmsCode.z)
  );
  let rgb2020Nits = max(dovi_lms_to_bt2020(lmsNits), vec3<f32>(0.0));
  let rgb709Linear = max(bt2020_to_bt709(rgb2020Nits), vec3<f32>(0.0)) / vec3<f32>(203.0);
  return bt1886_oetf(aces_filmic(rgb709Linear));
}

fn recover_dovi_p5_base_from_browser_rgb(rgb: vec3<f32>) -> vec3<f32> {
  // Chrome currently exposes this HEVC DV P5 sample as opaque bt709 RGB.
  // Invert that visible conversion as a diagnostic approximation, then
  // reinterpret the recovered channels as DV P5 IPT/PQ base data.
  let clampedRgb = clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0));
  let mode = previewParams.recoveryMode;
  if (mode == 0u) {
    return approximate_sdr_from_browser_rgb(clampedRgb);
  }

  var recoveredYuv = browser_bt709_rgb_to_yuv(clampedRgb);
  if (mode == 2u || mode == 4u || mode == 6u || mode == 8u || mode == 10u || mode == 12u) {
    recoveredYuv = browser_bt2020_rgb_to_yuv(clampedRgb);
  }
  return dovi_p5_base_to_sdr(adjust_yuv_by_recovery_mode(recoveredYuv, mode));
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let sampled = textureSampleBaseClampToEdge(videoTexture, videoSampler, input.uv);
  return vec4<f32>(recover_dovi_p5_base_from_browser_rgb(sampled.rgb), sampled.a);
}
