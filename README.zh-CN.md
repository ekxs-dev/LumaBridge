# LumaBridge

[English README](./README.md)

LumaBridge 是一个网页端 Dolby Vision Profile 5 到 SDR 的预览与验证工具。项目重点不是做一个已经完成的生产级转码器，而是验证网页技术栈能否拿到 raw 10-bit video frame、解析 Dolby Vision RPU metadata，并通过 WebGPU 做可对齐的 SDR 诊断渲染。

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

更详细的阶段记录见：[docs/current-stage-status.md](./docs/current-stage-status.md)。

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

### 快速 Opaque 路径

```text
WebCodecs opaque VideoFrame -> canvas drawImage()
WebCodecs opaque VideoFrame -> GPUExternalTexture -> WebGPU
```

这两条路径用于速度、可见性和逐帧调度诊断。它们的输入已经是浏览器转换后的 RGB frame，不能当作正确的 DV P5 SDR 输出。

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

docs/
  阶段记录和项目文档。
```

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
