# ToneBridge Test Fixtures

The fixtures in this directory are intentionally small and versioned.

- `dv_p5_short.mp4` / `.mkv`: short HEVC Main10 DV Profile 5 sample with RPU NAL units.
- `dv_p5_single_frame.mp4` / `.mkv`: deterministic single-frame DV sample.
- `hdr10_short.mp4`: synthetic HEVC Main10 HDR10-like sample with no Dolby Vision RPU.
- `no_rpu_hevc.mp4`: alias of the HDR10 fixture for explicit no-RPU tests.
- `bad_codec.mp4`: H.264 sample used to verify unsupported-codec handling.
- `references/rpu_reference.json`: golden RPU NAL count, extraction facts, and compact metadata ABI size.
- `references/sdr_reference.png`: libplacebo SDR BT.709 reference frame.

Regenerate fixtures with:

```bash
TONEBRIDGE_SOURCE=/path/to/source.mkv npm run bench:fixtures
```

Full WebGPU + HEVC + DV playback E2E should run on a dedicated browser/GPU host. CI smoke tests are capability-aware and must not fail just because the runner lacks HEVC or WebGPU.
