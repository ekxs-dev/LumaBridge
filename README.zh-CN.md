# LumaBridge

[English README](./README.md)

LumaBridge 是一个网页端 Dolby Vision Profile 5 到 SDR 的预览与验证工具。项目重点不是做一个已经完成的生产级转码器，而是验证网页技术栈能否拿到 raw 10-bit video frame、解析 Dolby Vision RPU metadata，并通过 WebGPU 做可对齐的 SDR 诊断渲染。

## 离可用还有多远

当前阶段更接近“验证台”和“诊断工具”，还不是一个可日常使用的 DV P5 转 SDR 播放器。

现在能稳定使用的是：

- 选择某个时间点，解出 raw `I420P10` 单帧。
- 查看 Raw luma / DV P5 base / PQ SDR approximation 诊断预览。
- 把当前 raw WebGPU 预览和 libplacebo PNG 参考图做误差对比。
- 用 fast opaque preview 快速确认浏览器能否正常解码和显示运动画面。
- 用低帧率 ffmpeg.wasm chunk fallback 做粗略跟踪。

现在比较可靠的正确性路径是：

```text
选中时间点
  -> ffmpeg.wasm 解 raw I420P10
  -> 解析对应 RPU
  -> WebGPU 渲染一帧 SDR 诊断图
  -> 手动和 libplacebo PNG 对比
```

现在还不能做到：

- 4K DV P5 正确色彩的 24/30/60fps 实时播放。
- 纯 Chrome 路径下稳定拿到 `I420P10` raw planes。
- 完整替代 libplacebo 的 DV reshape、gamut mapping 和 tone mapping。

离真正可用主要卡在两件事：

- Chrome/WebCodecs 需要稳定暴露 HEVC Main10 / DV P5 的 raw `I420P10` frame，或者允许等价的高位深 raw access。
- `ffmpeg.wasm` 或其他浏览器内解码方案需要有数量级性能提升，否则 raw 路径只能做单帧、短片段和低帧率诊断。

相关 Chromium issue：[WebGPU HDR texture support](https://issues.chromium.org/issues/40944011)。这条 issue 讨论了 `importExternalTexture()` / `copyExternalImageToTexture()` 在 HDR 和 high-bit-depth 输入上的限制，包括精度下降、sRGB/RGBA8 转换、HDR headroom 被钳制，以及开发者无法在 WebGPU 中稳定拿到原始 10-bit/HDR 数据的问题。

如果没有这两类能力提升，正确路径更现实的落地方式是 native helper 或服务端解码/转换；浏览器端继续负责 UI、metadata、WebGPU 预览和验证。

## 当前状态

当前实现已经可以：

- 解析 MP4 输入，并对大型 Matroska 输入做 prefix 解析。
- 识别 HEVC codec string 和 Dolby Vision RPU NAL。
- 探测 WebCodecs 支持情况，并分类 raw-frame access 能力。
- 通过 `ffmpeg.wasm` fallback 解出 raw `I420P10` 帧。
- 通过 Rust/WASM 解析选中帧的 Dolby Vision RPU metadata。
- 把 raw Y/U/V planes 上传到 WebGPU buffers。
- 用 WGSL 渲染 SDR 诊断预览。
- 手动加载 libplacebo PNG 参考图，并和 raw WebGPU 预览做像素误差比较。
- 用 WebCodecs 和 WebGPU opaque-frame path 做快速可见性与速度诊断。

严格的浏览器原生路径还没有完成：

```text
demux
  -> WebCodecs VideoDecoder
  -> VideoFrame.copyTo() as I420P10
  -> WebGPU raw YUV/RPU rendering
```

对当前 DV P5 测试样本，Chrome 可以通过 WebCodecs 解码 opaque frame，但不会通过 `copyTo()` 暴露 `I420P10` raw planes。快速 opaque path 可以用来看运动、速度和调度，但不能当作颜色正确的 DV P5 到 SDR 输出。

## 关键判断

Chrome 对当前测试的 HEVC/DV P5 文件可以走 WebCodecs 解码，但输出是 opaque frame：

```text
VideoFrame.format === null
VideoFrame.copyTo() raw I420P10 不可用
```

这意味着快速浏览器路径可以很快显示画面，但不能用于正确的 DV P5 到 SDR。

目前唯一能在网页端拿到 raw 10-bit frame 的路径是：

```text
ffmpeg.wasm
  -> raw yuv420p10le / I420P10
  -> Rust/WASM RPU metadata
  -> WebGPU WGSL 诊断渲染
```

这条路径适合做正确性验证、单帧检查、低帧率跟踪和 libplacebo 对齐工作，但不适合 4K 24/30/60fps 实时播放。

## 架构

```text
TypeScript
  -> 文件输入、UI、benchmark 页面
  -> MP4 / Matroska metadata parsing
  -> WebCodecs 探测和预览
  -> ffmpeg.wasm fallback adapter
  -> WebGPU upload/render orchestration

Rust + WASM
  -> HEVC NAL parsing
  -> Dolby Vision RPU extraction and parsing
  -> 给 WGSL 使用的 compact metadata packing

WGSL
  -> I420P10 YUV sampling
  -> DV/PQ/BT.2020 diagnostic processing
  -> SDR preview output
```

## 预览路径

### Raw 诊断路径

```text
ffmpeg.wasm raw I420P10
  -> Rust/WASM RPU metadata
  -> WebGPU WGSL diagnostic render
```

这条路径用于选中帧的正确性验证和 libplacebo reference 对比。它不是 4K 实时播放路径。

### Fast WebCodecs Canvas Preview

```text
WebCodecs opaque VideoFrame
  -> canvas drawImage()
```

这条路径用于检查浏览器解码速度、从指定时间点开始播放的行为，以及画面是否可见。输入已经是浏览器转换后的 opaque RGB，不能用于参考颜色对比。

### Fast WebGPU Opaque Preview

```text
WebCodecs opaque VideoFrame
  -> GPUExternalTexture
  -> simple WebGPU shader
```

这条路径用于快速验证 WebGPU external texture 渲染、UI 行为和逐帧调度。它同样从浏览器转换后的 opaque RGB 开始，不是 DV P5 SDR 正确路径，也不提供 reference compare。

旧的 `external recovery` matrix/range/channel selector 已经删除。8.5 秒手动诊断证明，BT.709/BT.2020、full/limited、UV swap 和 channel flip 组合都不能从 Chrome opaque RGB frame 里恢复正确的 DV P5 base signal。继续保留会让 UI 看起来像 opaque path 还能被调成正确路径，这是误导。

## 性能现状

大型本地 DV P5 Matroska 样本上的观察结果：

```text
3840 x 1608
ffmpeg.wasm core-mt 可用
target 4 fps
实际约 2 fps
一次观察中 5-frame chunk decode 约 162 ms
一次观察中平均 frame time 约 413 ms
```

短 segment decode 已经明显好于 seek-per-frame，但距离 4K 24/30/60fps 仍然很远。

如果要做到正常视频帧率并保持正确 DV P5 SDR，仍然需要以下路线之一：

- 浏览器 WebCodecs 未来稳定暴露真实 `I420P10` frame，并允许 `copyTo()`。
- native helper 解码 HEVC Main10，再把 raw frame 传给网页。
- 服务端解码和色彩处理。
- 一个比当前 `ffmpeg.wasm` 快很多的浏览器内解码路径。

## 当前正确性差距

RPU 解析和 compact metadata packing 已经有较好的测试覆盖。现在最大的已知差距在 DV decode 之后的色彩映射：

```text
libplacebo:
reshape
  -> nonlinear matrix/offset
  -> PQ EOTF
  -> HPE LMS / BT.2020 matrix path
  -> PQ OETF
  -> full color_map / gamut mapping

current WGSL:
reshape diagnostics
  -> simplified BT.2390/IPT-style SDR mapping
  -> RGB softclip
```

下一阶段如果继续做正确性，重点应该放在 libplacebo 风格的 post-DV color map 和 gamut behavior。

## 环境要求

- Node.js 18 或更新版本。
- npm。
- 用于浏览器诊断的 Chrome 或 Edge，需要 WebCodecs 和 WebGPU 支持。
- Rust toolchain，用于 Rust/WASM 测试和重新构建。

## 快速开始

```bash
npm install
npm run dev
```

打开：

```text
http://127.0.0.1:5173/bench
```

Vite dev server 会故意发送 cross-origin isolation headers，这样 `@ffmpeg/core-mt` 可以使用 `SharedArrayBuffer`。

## 常用命令

```bash
npm run test
npm run build
npm run test:e2e
npm run test:rust
npm run build:wasm
```

## 仓库结构

```text
src/main.ts
  Vite app 入口、首页和 benchmark 页面。

src/core/
  TypeScript 解析、探测、fallback、上传、reference compare 和 benchmark 逻辑。

src/gpu/
  raw DV/PQ 诊断和 opaque WebGPU 预览使用的 WGSL shader。

crates/lumabridge_wasm/
  用于 HEVC/RPU parsing 和 compact metadata packing 的 Rust crate。

src/wasm/lumabridge_wasm/
  生成的 wasm-bindgen browser package。

tests/
  单元测试、Playwright smoke tests、fixtures 和 references。
```

## 人工测试方式

```bash
npm run dev
```

打开：

```text
http://127.0.0.1:5173/bench
```

建议检查：

- 选择本地 DV P5 测试文件。
- 确认 fallback 显示 `ffmpeg.wasm`，并且有 `multi-thread`、`threaded`、`isolated`。
- 用 selected timestamp 渲染 raw `I420P10` WebGPU 诊断帧。
- fast opaque preview 只用于速度和可见性，不用于判断颜色正确性。
- 只有 raw WebGPU SDR preview 才适合加载 libplacebo PNG 做 reference compare。

## 测试策略

CI smoke tests 需要保持 capability-aware。不能因为某台机器缺少 HEVC hardware decode 或 WebGPU 就直接失败。

跨模块改动建议跑：

```bash
npm run test
npm run build
npm run test:e2e
npm run test:rust
```

## 已知限制

- Chrome 当前会把测试 DV P5 HEVC stream 暴露为 opaque frame，而不是严格的 `I420P10` raw frame。
- `ffmpeg.wasm` raw decode 适合做正确性诊断，但不适合 4K 24/30/60fps 播放。
- 大型 Matroska 文件当前仍然是 prefix parsing，完整 streaming demux 尚未实现。
- WGSL color mapping 仍是诊断质量，还没有完全对齐 libplacebo。
