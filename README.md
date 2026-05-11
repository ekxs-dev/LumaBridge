# LumaBridge

[中文说明](./README.zh-CN.md)

LumaBridge is a browser-side Dolby Vision Profile 5 to SDR preview and verification tool. The project is focused on testing whether a web stack can expose raw 10-bit video frames, parse Dolby Vision RPU metadata, and render diagnostic SDR output through WebGPU.

This is an engineering and verification project, not a finished production transcoder.

## Current Status

The current implementation can:

- Parse MP4 inputs and prefix-parse large Matroska inputs.
- Detect HEVC codec strings and Dolby Vision RPU NAL units.
- Probe WebCodecs support and classify raw-frame access.
- Decode raw `I420P10` frames through `ffmpeg.wasm` fallback.
- Parse selected-frame Dolby Vision RPU metadata through Rust/WASM.
- Upload raw Y/U/V planes into WebGPU buffers.
- Render diagnostic SDR previews with WGSL.
- Manually compare a raw WebGPU preview against a libplacebo PNG reference.
- Run fast WebCodecs and WebGPU opaque-frame previews for speed and visibility checks.

The strict browser-native path is not complete yet:

```text
demux
  -> WebCodecs VideoDecoder
  -> VideoFrame.copyTo() as I420P10
  -> WebGPU raw YUV/RPU rendering
```

For the current DV P5 test samples, Chrome can decode opaque WebCodecs frames, but does not expose `I420P10` raw planes via `copyTo()`. The fast opaque paths are useful for previewing motion and decode speed, but they are not reference-correct DV P5 to SDR paths.

See [docs/current-stage-status.md](./docs/current-stage-status.md) for the detailed current-stage notes.

## Architecture

```text
TypeScript
  -> file input, UI, benchmark page
  -> MP4 / Matroska metadata parsing
  -> WebCodecs probing and preview
  -> ffmpeg.wasm fallback adapter
  -> WebGPU upload/render orchestration

Rust + WASM
  -> HEVC NAL parsing
  -> Dolby Vision RPU extraction and parsing
  -> compact metadata packing for WGSL

WGSL
  -> I420P10 YUV sampling
  -> DV/PQ/BT.2020 diagnostic processing
  -> SDR preview output
```

## Preview Paths

### Raw Diagnostic Path

```text
ffmpeg.wasm raw I420P10
  -> Rust/WASM RPU metadata
  -> WebGPU WGSL diagnostic render
```

Use this path for selected-frame correctness work and libplacebo reference comparison. It is not fast enough for full 4K realtime playback.

### Fast Opaque Paths

```text
WebCodecs opaque VideoFrame -> canvas drawImage()
WebCodecs opaque VideoFrame -> GPUExternalTexture -> WebGPU
```

Use these paths for speed, visibility, and scheduling diagnostics. They start from browser-converted RGB frames and must not be treated as correct DV P5 SDR output.

## Requirements

- Node.js 18 or newer.
- npm.
- Chrome or Edge with WebCodecs and WebGPU support for the browser diagnostics.
- Rust toolchain for Rust/WASM tests and rebuilds.

## Quick Start

```bash
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:5173/bench
```

The Vite dev server intentionally sends cross-origin isolation headers so `@ffmpeg/core-mt` can use `SharedArrayBuffer`.

## Useful Commands

```bash
npm run test
npm run build
npm run test:e2e
npm run test:rust
npm run build:wasm
```

## Repository Layout

```text
src/main.ts
  Vite app entry, home page, and benchmark page.

src/core/
  TypeScript parsing, probing, fallback, upload, reference comparison, and benchmark logic.

src/gpu/
  WGSL shaders for raw DV/PQ diagnostics and opaque WebGPU preview.

crates/lumabridge_wasm/
  Rust crate for HEVC/RPU parsing and compact metadata packing.

src/wasm/lumabridge_wasm/
  Generated wasm-bindgen browser package.

tests/
  Unit tests, Playwright smoke tests, fixtures, and references.

docs/
  Current-stage notes and project documentation.
```

## Testing Policy

CI-style smoke tests should remain capability-aware. They should not fail only because a machine lacks HEVC hardware decode or WebGPU.

For cross-cutting changes, run:

```bash
npm run test
npm run build
npm run test:e2e
npm run test:rust
```

## Known Limitations

- Chrome currently exposes the tested DV P5 HEVC stream as opaque frames, not strict `I420P10` raw frames.
- `ffmpeg.wasm` raw decoding is useful for correctness diagnostics but not practical for 4K 24/30/60fps playback.
- Large Matroska files are currently prefix-parsed; full streaming demux is still pending.
- WGSL color mapping is diagnostic quality and not fully libplacebo-matched yet.
