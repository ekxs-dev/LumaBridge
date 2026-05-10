# LumaBridge Agent Notes

## Project Overview
- Project name: `lumabridge`.
- Goal: browser-side Dolby Vision Profile 5 to SDR preview/verification tooling.
- Current state: test infrastructure, benchmark UI, fixtures, Rust/WASM parser skeleton, and WGSL shader skeleton are in place. The full demux -> WebCodecs -> `VideoFrame.copyTo()` -> WebGPU DV P5 pipeline is not complete yet.
- Primary browser target: Chrome/Edge first.
- Reference target: SDR BT.709, 100 nit, with sRGB display adaptation for page preview.

## Repository Layout
- `src/main.ts`: Vite app entry. Home page and `/bench` page are currently implemented here.
- `src/core/`: TypeScript capability checks, codec helpers, metadata packing, color math, and benchmark summaries.
- `src/core/rpu-metadata.ts`: Lazy browser adapter for generated Rust/WASM RPU metadata packing.
- `src/gpu/dv-p5-to-sdr.wgsl`: WGSL shader skeleton for YUV10/DV/PQ/tone mapping work.
- `crates/lumabridge_wasm/`: Rust crate for HEVC NAL parsing, RPU extraction, metadata packing, and future libdovi integration.
- `src/wasm/lumabridge_wasm/`: Generated wasm-bindgen browser package for the Rust RPU metadata parser.
- `tests/unit/`: Vitest unit tests.
- `tests/e2e/`: Playwright smoke/e2e tests.
- `tests/fixtures/`: Small versioned media fixtures.
- `tests/references/`: Golden metadata/reference outputs.
- `scripts/generate-fixtures.mjs`: Regenerates fixtures from `LUMABRIDGE_SOURCE` or `/path/to/input.mkv`.
- `source/`: ignored reference source tree, currently used for local libplacebo study. Do not include it in normal changes.

## Dev Environment Tips
- This repo uses `npm`, not `pnpm`.
- Install JS dependencies with `npm install`.
- Start the dev server with `npm run dev`.
- Open the benchmark page at `/bench`.
- Run Rust tests with `npm run test:rust`.
- Rebuild the generated Rust/WASM browser package with `npm run build:wasm`.
- Regenerate fixtures with `npm run bench:fixtures`.
- Override the source fixture file with:

```bash
LUMABRIDGE_SOURCE=/path/to/input.mkv npm run bench:fixtures
```

## Testing Instructions
- Run TypeScript unit tests:

```bash
npm run test
```

- Run the production build/typecheck:

```bash
npm run build
```

- Run Playwright e2e smoke tests:

```bash
npm run test:e2e
```

- Run Rust/WASM crate tests:

```bash
npm run test:rust
```

- Before considering a change done, run the checks relevant to the changed area. For cross-cutting work, run all four commands above.
- Add or update tests for every behavior change.
- Keep e2e tests capability-aware. Do not make CI fail solely because the machine lacks HEVC hardware decode or WebGPU.

## Fixture And Reference Constraints
- Keep fixtures small enough for repository smoke tests.
- Current DV fixture was cut from `/path/to/input.mkv`.
- `dv_p5_short.mp4` is HEVC Main10 DV P5 with RPU NAL units.
- Current golden RPU count for `tests/fixtures/dv_p5_short.mp4`: `154`.
- `sdr_reference.png` is generated with FFmpeg/libplacebo as the SDR reference frame.
- Updating golden/reference files should be intentional and reviewed.

## Implementation Constraints
- Do not claim the full DV P5 -> SDR pipeline is complete until actual demux, WebCodecs decode, `I420P10` copy, WebGPU upload, RPU metadata application, and reference image comparison are wired end to end.
- `ffmpeg.wasm` is not the intended main 4K decode path. Prefer WebCodecs for decode and Rust/WASM for RPU/container support.
- HDR10/PQ-only behavior is debug/fallback, not a valid DV P5 result.
- Benchmark timings on `/bench` are synthetic until the real pipeline is connected. The page already supports selecting and previewing a local video via native `<video>`.
- `/bench` also has diagnostic raw-frame preview controls: a time slider/seconds input plus Raw luma, DV P5 base approximation, and PQ SDR approximation modes. Raw luma confirms decoded frame structure; DV P5 base approximation interprets the planes as IPT/PQ before RPU reshape; PQ SDR intentionally shows the incorrect HDR10-style path for comparison.
- `/bench` shows selected-time Frame/RPU alignment for parsed samples: sample index, timestamp, RPU count, and first RPU NAL bytes. Large MKV files are still prefix-parsed, so seeks beyond that parsed window report unknown/outside until streaming demux is implemented.
- When selected time is outside the parsed prefix and ffmpeg.wasm raw preview succeeds, `/bench` first tries a one-packet HEVC copy probe (`hevc_mp4toannexb`) at that time, scans the Annex-B packet for RPU NALs, then renders the debug preview with that selected-time RPU metadata when available. This is diagnostic fallback, not the final demux strategy.
- Compact DV metadata ABI v2 is 840 `f32` values with explicit `reshapeHeader`, padded pivots, per-piece method/order metadata, polynomial slots, full MMR coefficient slots, and `sourcePq = [sourceMin, sourceMax, level1Max, level1Avg]`. RPU luma pivots from the `dolby_vision` crate are cumulative deltas and must be accumulated before packing. MMR coefficients are packed like libplacebo as `[c0,c1,c2,pad] + [c3,c4,c5,c6]` per order. Keep `src/core/metadata.ts`, `crates/lumabridge_wasm/src/lib.rs`, and `src/gpu/dv-p5-to-sdr.wgsl` aligned.
- `src/core/gpu-upload.ts` prepares tightly packed `u32` Y/U/V storage-buffer data plus source/output frame params from I420P10 frames. `/bench` attempts a live WebGPU buffer upload after ffmpeg.wasm raw-frame decode when WebGPU is available.
- `src/core/rpu-metadata.ts` lazy-loads the generated Rust/WASM parser and converts selected-frame RPU NAL payloads into the 840-f32 compact shader metadata buffer. If parsing fails or no RPU payload is available, `/bench` falls back to identity metadata and reports that explicitly.
- `src/core/webgpu-render.ts` runs the WGSL compute shader against the ffmpeg.wasm raw frame and reads back an RGBA8 SDR debug preview when WebGPU is available. It now accepts packed RPU metadata, but the WGSL reshape math is still simplified/debug quality.
- `/bench` keeps the previous preview visible while a selected raw frame is being decoded/rendered and only draws the CPU preview as fallback, avoiding a CPU-to-WebGPU color flash during successful RPU renders.
- `/bench` can manually load a libplacebo PNG reference and compare the current SDR preview readback against it. The report records RGB MAE, per-channel MAE, signed RGB bias, output/reference averages, max-error pixel, and outlier count; this is a manual diagnostic, not the final automated fixture parity gate yet.
- Rust `parse_rpu_metadata` now uses the MIT `dolby_vision` crate to parse real HEVC type-62 RPU payloads and fill compact metadata with Dolby matrices, offsets, source PQ, DV Level 1 max/avg PQ, pivots, and polynomial/MMR coefficient slots. It also retries ffmpeg single-packet RPU payloads with CRC-validated tail trimming because Annex-B copy probes can leave non-RPU bytes after the real RPU terminator. It is still pending final libplacebo parity for pivot interpretation, per-piece method/order packing, and shader application.
- The browser WASM package is built with rustup stable + `wasm32-unknown-unknown` and `wasm-bindgen-cli` 0.2.121 via `npm run build:wasm`.
- WGSL currently contains a debug compute path and simplified preview modes. It now applies ABI v2 RPU reshape metadata for diagnostics, the MMR basis terms and coefficient padding match libplacebo's `x*y`, `x*z`, `y*z`, `x*y*z` layout, the DV decode offset follows libplacebo's full-range `1024/1023` normalization, the DV post step avoids an extra PQ OETF/EOTF round trip, and the SDR diagnostic tone map uses a BT.2390-style IPT/PQ path using DV Level 1 max PQ when present instead of the old Reinhard path. The result is not yet full libplacebo/reference validated.
- Chrome currently rejects `meta` as a WGSL local identifier. Keep shader locals away from reserved keywords; `tests/unit/wgsl.test.ts` guards the regression that broke `/bench` WebGPU rendering.

## PR / Commit Guidance
- Suggested title format: `[lumabridge] <Title>`.
- Keep changes scoped. Avoid touching `source/` unless the task explicitly concerns the reference source tree.
- Do not commit generated `dist/`, `node_modules/`, Playwright reports, or Rust `target/`.
- If changing public test fixtures, update `tests/README.md` and the golden assertions together.

## TODO
- [x] Add real MP4 track/sample metadata parser for benchmark file selection.
- [x] Add HEVC sample scanning for MP4 fixtures and surface RPU NAL counts in `/bench`.
- [x] Implement real MP4 demux metadata for HEVC samples and codec string extraction.
- [x] Feed MP4 samples into WebCodecs `VideoDecoder` for first-frame probing.
- [x] Probe `VideoFrame.copyTo()` on the first decoded frame and report I420P10 layout status.
- [x] Add MKV demux support or a WASM-backed MKV adapter.
- [x] Add WebCodecs-first decoder adapter with ffmpeg.wasm fallback probing.
- [x] Add automatic ffmpeg.wasm first-frame I420P10 diagnostic decode and SDR debug preview.
- [x] Add selectable timestamp controls for ffmpeg.wasm SDR debug preview frames.
- [x] Add Raw luma diagnostic preview mode for DV P5 frames before RPU color processing.
- [x] Add DV P5 base-layer approximation preview mode for greener-than-expected debug frames.
- [x] Add selected-time sample/RPU alignment diagnostics on `/bench`.
- [x] Add ffmpeg.wasm selected-time HEVC packet RPU probe for prefix-miss diagnostics.
- [x] Run prefix-miss HEVC packet RPU probe before WebGPU raw preview rendering so selected-time metadata can be applied.
- [x] Report non-HEVC Matroska tracks as unsupported inputs instead of container parse failures.
- [ ] Turn ffmpeg.wasm fallback from first-frame diagnostic into a streaming/raw-frame adapter.
- [ ] Validate real `VideoFrame.format === "I420P10"` and `VideoFrame.colorSpace`.
- [ ] Copy real `VideoFrame` planes with `copyTo()` and upload Y/U/V data to WebGPU.
- [x] Replace Rust placeholder RPU parsing with real `dolby_vision` crate-backed metadata extraction.
- [x] Generate browser WASM bindings for the Rust RPU parser and load them from TypeScript.
- [x] Pass selected-frame packed RPU metadata into WebGPU render diagnostics when available.
- [x] Expand compact metadata ABI to carry reshape header, per-piece method/order metadata, polynomial slots, and full MMR coefficient slots.
- [x] Carry Dolby Vision Level 1 max/avg PQ through Rust/WASM, TypeScript probes, and WGSL tone-map peak selection.
- [x] Add CRC-validated RPU tail trimming for ffmpeg single-packet Annex-B probes.
- [x] Preserve CPU debug preview instead of covering it with identity WebGPU output when RPU metadata parsing fails.
- [ ] Validate RPU pivot/method/MMR packing against FFmpeg/libplacebo for all compact metadata slots.
- [x] Define and freeze the compact metadata buffer ABI between Rust, TypeScript, and WGSL.
- [x] Add deterministic I420P10 plane upload planning for WebGPU storage buffers.
- [x] Wire ffmpeg.wasm raw-frame output to a live WebGPU buffer upload probe on `/bench`.
- [x] Add WebGPU compute shader SDR debug render/readback for raw I420P10 preview frames.
- [x] Align WGSL MMR reshape cross terms with libplacebo's coefficient basis.
- [x] Accumulate Dolby Vision RPU pivot deltas before compact metadata packing.
- [x] Align Rust/WASM MMR coefficient vec4 padding with WGSL/libplacebo.
- [x] Fix Chrome WGSL shader compilation failure caused by reserved local identifier `meta`.
- [x] Avoid CPU preview flash before successful WebGPU RPU render.
- [x] Add manual `/bench` libplacebo PNG pixel-error comparison for current SDR preview.
- [x] Add signed RGB bias and output/reference averages to manual reference comparison diagnostics.
- [x] Replace diagnostic Reinhard tone mapping with a BT.2390-style IPT/PQ SDR path.
- [ ] Implement and validate libplacebo-aligned DV polynomial/MMR reshape in WGSL.
- [ ] Add real SDR frame readback and pixel-error comparison against `sdr_reference.png`.
- [ ] Replace synthetic benchmark timings with measured demux/decode/copy/upload/shader/present timings.
- [ ] Add benchmark file-selection e2e that uploads a fixture and verifies metadata/report updates.
