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
- `src/gpu/dv-p5-to-sdr.wgsl`: WGSL shader skeleton for YUV10/DV/PQ/tone mapping work.
- `crates/lumabridge_wasm/`: Rust crate for HEVC NAL parsing, RPU extraction, metadata packing, and future libdovi integration.
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
- Rust `parse_rpu_metadata` is currently a placeholder returning identity metadata for valid payloads. Full libdovi/dovi_tool-compatible parsing is still pending.
- WGSL currently contains a skeleton/reference compute path, not libplacebo-accurate DV reshaping.

## PR / Commit Guidance
- Suggested title format: `[lumabridge] <Title>`.
- Keep changes scoped. Avoid touching `source/` unless the task explicitly concerns the reference source tree.
- Do not commit generated `dist/`, `node_modules/`, Playwright reports, or Rust `target/`.
- If changing public test fixtures, update `tests/README.md` and the golden assertions together.

## TODO
- [x] Add real MP4 track/sample metadata parser for benchmark file selection.
- [ ] Implement real MP4/MKV demux for HEVC samples and codec string extraction.
- [ ] Feed demuxed samples into WebCodecs `VideoDecoder`.
- [ ] Validate real `VideoFrame.format === "I420P10"` and `VideoFrame.colorSpace`.
- [ ] Copy real `VideoFrame` planes with `copyTo()` and upload Y/U/V data to WebGPU.
- [ ] Replace Rust placeholder RPU parsing with full libdovi/dovi_tool-compatible metadata extraction.
- [ ] Define and freeze the compact metadata buffer ABI between Rust, TypeScript, and WGSL.
- [ ] Implement libplacebo-aligned DV polynomial/MMR reshape in WGSL.
- [ ] Add real SDR frame readback and pixel-error comparison against `sdr_reference.png`.
- [ ] Replace synthetic benchmark timings with measured demux/decode/copy/upload/shader/present timings.
- [ ] Add benchmark file-selection e2e that uploads a fixture and verifies metadata/report updates.
