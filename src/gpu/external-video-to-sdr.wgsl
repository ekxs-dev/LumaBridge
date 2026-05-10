struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@group(0) @binding(0) var videoTexture: texture_external;
@group(0) @binding(1) var videoSampler: sampler;

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

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let sampled = textureSampleBaseClampToEdge(videoTexture, videoSampler, input.uv);
  return vec4<f32>(approximate_sdr_from_browser_rgb(sampled.rgb), sampled.a);
}
