# LumaBridge Agent Notes

## Project Overview
- Project name: `lumabridge`.
- Goal: browser-side Dolby Vision Profile 5 to SDR preview/verification tooling.
- Current state: test infrastructure, benchmark UI, fixtures, Rust/WASM parser skeleton, and WGSL shader skeleton are in place. The full demux -> WebCodecs -> `VideoFrame.copyTo()` -> WebGPU DV P5 pipeline is not complete yet.
- Primary browser target: Chrome/Edge first.
- Reference target intent: SDR BT.709, 100 nit. Current generated/manual FFmpeg `libplacebo` references do not explicitly override target peak, so libplacebo's default `PL_COLOR_SDR_WHITE = 203 nit` and BT.1886-style `color_trc=bt709` mapping are the practical browser comparison target until references are regenerated with an explicit 100 nit policy.

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
- `sdr_reference.png` is generated with FFmpeg/libplacebo as the SDR reference frame. The current command uses `color_trc=bt709`, which libplacebo maps as a BT.1886 display curve, and no explicit 100 nit target override.
- Updating golden/reference files should be intentional and reviewed.

## Implementation Constraints
- Do not claim the full DV P5 -> SDR pipeline is complete until actual demux, WebCodecs decode, `I420P10` copy, WebGPU upload, RPU metadata application, and reference image comparison are wired end to end.
- `ffmpeg.wasm` is not the intended main 4K decode path. Prefer WebCodecs for decode and Rust/WASM for RPU/container support.
- HDR10/PQ-only behavior is debug/fallback, not a valid DV P5 result.
- Benchmark timings on `/bench` are synthetic until the real pipeline is connected. The page already supports selecting and previewing a local video via native `<video>`.
- `/bench` also has diagnostic raw-frame preview controls: a time slider/seconds input plus Raw luma, DV P5 base approximation, and PQ SDR approximation modes. Raw luma confirms decoded frame structure; DV P5 base approximation interprets the planes as IPT/PQ before RPU reshape; PQ SDR intentionally shows the incorrect HDR10-style path for comparison.
- `/bench` shows selected-time Frame/RPU alignment for parsed samples: sample index, timestamp, RPU count, and first RPU NAL bytes. Large MKV files are still prefix-parsed, so seeks beyond that parsed window report unknown/outside until streaming demux is implemented.
- When selected time is outside the parsed prefix and ffmpeg.wasm raw preview succeeds, `/bench` first tries a one-packet HEVC copy probe (`hevc_mp4toannexb`) at that time, scans the Annex-B packet for RPU NALs, then renders the debug preview with that selected-time RPU metadata when available. Raw-frame decode and packet probe use a hybrid seek (`input -ss` near the target plus output `-ss` for the final 2 seconds) to reduce off-by-keyframe diagnostics, but this is still a diagnostic fallback, not the final demux strategy.
- Compact DV metadata ABI v2 is 840 `f32` values with explicit `reshapeHeader`, padded pivots, per-piece method/order metadata, polynomial slots, full MMR coefficient slots, and `sourcePq = [sourceMin, sourceMax, level1Max, level1Avg]`. RPU luma pivots from the `dolby_vision` crate are cumulative deltas and must be accumulated before packing. MMR coefficients are packed like libplacebo as `[c0,c1,c2,pad] + [c3,c4,c5,c6]` per order. Keep `src/core/metadata.ts`, `crates/lumabridge_wasm/src/lib.rs`, and `src/gpu/dv-p5-to-sdr.wgsl` aligned.
- `src/core/gpu-upload.ts` prepares tightly packed `u32` Y/U/V storage-buffer data plus source/output frame params from I420P10 frames. `/bench` attempts a live WebGPU buffer upload after ffmpeg.wasm raw-frame decode when WebGPU is available.
- `src/core/rpu-metadata.ts` lazy-loads the generated Rust/WASM parser and converts selected-frame RPU NAL payloads into the 840-f32 compact shader metadata buffer. If parsing fails or no RPU payload is available, `/bench` falls back to identity metadata and reports that explicitly.
- `src/core/webgpu-render.ts` runs the WGSL compute shader against the ffmpeg.wasm raw frame and reads back an RGBA8 SDR debug preview when WebGPU is available. It now accepts packed RPU metadata, but the WGSL reshape math is still simplified/debug quality.
- `/bench` keeps the previous preview visible while a selected raw frame is being decoded/rendered and only draws the CPU preview as fallback, avoiding a CPU-to-WebGPU color flash during successful RPU renders.
- `/bench` can manually load a libplacebo PNG reference and compare the current SDR preview readback against it. The report records RGB MAE, per-channel MAE, signed RGB bias, output/reference averages, max-error pixel, outlier count, and a reference-gap diagnosis with likely causes/next checks; this is a manual diagnostic, not the final automated fixture parity gate yet.
- `/bench` avoids resetting the SDR canvas dimensions when the preview size is unchanged. This keeps the previous preview visible during re-renders and prevents the one-frame blank/flash seen while ffmpeg.wasm/WebGPU work is still in flight.
- `/bench` records sampled raw Y/U/V min/max/average stats for each ffmpeg.wasm I420P10 frame. If WebGPU returns a black preview while the CPU raw preview is non-black, the page automatically shows the CPU fallback and reports the WebGPU black-frame anomaly instead of leaving the user with a misleading blank/blue canvas.
- `/bench` also has a "Fast WebCodecs preview" button. It decodes parsed HEVC samples through WebCodecs and draws opaque `VideoFrame`s directly to the SDR preview canvas with `drawImage()`. This is the normal-speed/browser-hardware visibility path, but it is not the strict DV P5 raw path because Chrome currently reports `VideoFrame.format === null` for the user's HEVC sample and does not expose I420P10 planes via `copyTo()`.
- `/bench` has a "Fast WebGPU SDR preview" button. It decodes through WebCodecs, imports each opaque `VideoFrame` via `GPUDevice.importExternalTexture()`, then renders a fullscreen WebGPU shader from `src/gpu/external-video-to-sdr.wgsl` into a dedicated external-texture canvas. This is the fastest interactive WebGPU entry available when raw `I420P10` is unavailable, but it starts from browser-converted RGB and may already include YUV/RGB/color-space conversion, clamping, or DV-incorrect interpretation. Treat it as approximate interaction/debug preview only, not reference SDR.
- `/bench` has a "Realtime preview" control for the currently feasible browser path. Today it runs a wall-clock ffmpeg.wasm fallback loop with target FPS clamped to 0.25-4fps and defaulting to 0.25fps for 4K safety, skips ahead when decode/render is slower than target, and records effective FPS/dropped-frame estimates. This is useful for interactive visual tracking, but it is not strict 24fps DV playback. Strict realtime still requires WebCodecs streaming decode plus `VideoFrame.copyTo()` I420P10 frames.
- HEVC WebCodecs codec strings are generated from hvcC with profile-compatibility flags converted into codec-string bit order. `/bench` also probes strict and relaxed HEVC candidates (`hev1`/`hvc1`, full constraints/`B0`) before selecting ffmpeg.wasm fallback, because over-specific constraint bits can make `VideoDecoder.isConfigSupported()` reject an otherwise decodable HEVC Main10 stream.
- `tests/unit/rpu-metadata.test.ts` now checks compact RPU metadata against FFmpeg Dolby Vision side-data fields for the first fixture frame: matrices, offsets, source PQ, pivots, and polynomial coefficients. If that test is green, the largest libplacebo gap is more likely in WGSL sampling/reshape/tone/gamut mapping or frame/RPU alignment than in Rust metadata packing.
- Rust `parse_rpu_metadata` now uses the MIT `dolby_vision` crate to parse real HEVC type-62 RPU payloads and fill compact metadata with Dolby matrices, offsets, source PQ, DV Level 1 max/avg PQ, pivots, and polynomial/MMR coefficient slots. It also retries ffmpeg single-packet RPU payloads with CRC-validated tail trimming because Annex-B copy probes can leave non-RPU bytes after the real RPU terminator. It is still pending final libplacebo parity for pivot interpretation, per-piece method/order packing, and shader application.
- The browser WASM package is built with rustup stable + `wasm32-unknown-unknown` and `wasm-bindgen-cli` 0.2.121 via `npm run build:wasm`.
- WGSL currently contains a debug compute path and simplified preview modes. It now applies ABI v2 RPU reshape metadata for diagnostics, the MMR basis terms and coefficient padding match libplacebo's `x*y`, `x*z`, `y*z`, `x*y*z` layout, the DV decode offset follows libplacebo's full-range `1024/1023` normalization, the DV nonlinear matrix output only clamps the lower bound before PQ EOTF like libplacebo, the DV post step avoids an extra PQ OETF/EOTF round trip, and the SDR diagnostic tone map uses a BT.2390-style IPT/PQ path using Level 1 max PQ when present instead of the old Reinhard path. For practical comparison against the current FFmpeg/libplacebo PNG command, WebGPU/CPU SDR diagnostics use libplacebo's default `PL_COLOR_SDR_WHITE = 203 nit`, force PQ black to `PL_COLOR_HDR_BLACK`, use an SDR black point of white/1000, apply the libplacebo softclip formula to BT.709 linear RGB highlights, and write BT.1886-style output for `color_trc=bt709`; raw luma remains an sRGB-ish structural diagnostic. The raw WebGPU preview samples luma/chroma bilinearly and assumes the current fixtures' `AVCHROMA_LOC_LEFT` 4:2:0 chroma siting. The result is not yet full libplacebo/reference validated.
- Current libplacebo gap focus: `pl_shader_dovi_reshape` and the packed RPU fields now have good coverage, so the next largest known mismatch is the simplified WebGPU color-map/gamut path after DV decode. libplacebo's DV decode path is reshape -> nonlinear matrix/offset -> PQ EOTF -> `(HPE LMS->BT.2020 * linear matrix)` -> PQ OETF -> full `pl_shader_color_map_ex`; our WGSL now has the BT.2390/IPT path plus RGB softclip, but does not yet implement libplacebo's perceptual gamut 3D LUT or hue/saturation remapping.
- Chrome currently rejects `meta` and `target` as WGSL identifiers. Keep shader locals and function parameters away from reserved keywords; `tests/unit/wgsl.test.ts` guards these regressions that broke `/bench` WebGPU rendering.

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
- [x] Fix Chrome WGSL shader compilation failure caused by reserved identifier `target`.
- [x] Avoid CPU preview flash before successful WebGPU RPU render.
- [x] Avoid blank SDR canvas flash by preserving canvas dimensions between same-size renders.
- [x] Add manual `/bench` libplacebo PNG pixel-error comparison for current SDR preview.
- [x] Add signed RGB bias and output/reference averages to manual reference comparison diagnostics.
- [x] Add reference-gap diagnosis to explain likely libplacebo mismatch causes from MAE/bias/pipeline context.
- [x] Use hybrid ffmpeg.wasm seek for selected raw-frame and HEVC packet probes.
- [x] Replace diagnostic Reinhard tone mapping with a BT.2390-style IPT/PQ SDR path.
- [x] Align SDR diagnostic white/black points with current libplacebo reference behavior: `PL_COLOR_SDR_WHITE = 203 nit`, `PL_COLOR_HDR_BLACK`, and SDR black = white/1000.
- [x] Use BT.1886-style output for SDR/RPU preview bytes to match FFmpeg/libplacebo `color_trc=bt709` references.
- [x] Add libplacebo-style RGB softclip to SDR diagnostic output before BT.1886 encoding.
- [x] Carry DV source min PQ into the WGSL metadata path for reporting, while using libplacebo PQ black for the current BT.2390 diagnostic mapping.
- [x] Avoid upper-clamping Dolby Vision nonlinear matrix output before PQ EOTF.
- [x] Add FFmpeg-side-data golden coverage for compact RPU metadata fields.
- [x] Use bilinear WGSL luma/chroma sampling with left chroma siting for current fixtures.
- [x] Add `/bench` realtime fallback preview controls with target FPS, effective FPS, dropped-frame estimates, and wall-clock seek advancement.
- [x] Normalize HEVC profile compatibility flags for WebCodecs codec strings and probe relaxed `hev1`/`hvc1` candidates before ffmpeg.wasm fallback.
- [x] Add raw I420P10 Y/U/V frame statistics and CPU fallback when WebGPU returns a black frame for non-black raw data.
- [x] Add fast WebCodecs opaque-frame preview for normal-speed decode diagnostics.
- [x] Add fast WebGPU external-texture preview for opaque WebCodecs frames when raw I420P10 is unavailable.
- [ ] Implement strict WebCodecs streaming realtime path: demux sample stream -> `VideoDecoder` -> `VideoFrame.copyTo()` -> WebGPU render.
- [ ] Replace ffmpeg.wasm realtime fallback seek-per-frame loop with a streaming raw-frame adapter for short clips.
- [ ] Port libplacebo-style post-DV color-map/gamut behavior beyond the simplified BT.2390/IPT diagnostic path.
- [ ] Implement and validate libplacebo-aligned DV polynomial/MMR reshape in WGSL.
- [ ] Add real SDR frame readback and pixel-error comparison against `sdr_reference.png`.
- [ ] Replace synthetic benchmark timings with measured demux/decode/copy/upload/shader/present timings.
- [ ] Add benchmark file-selection e2e that uploads a fixture and verifies metadata/report updates.
