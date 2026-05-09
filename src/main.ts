import './styles/app.css';
import { createSyntheticBenchmark, summarizeBenchmark } from './core/benchmark';
import { evaluateCapabilities, probeBrowserCapabilities } from './core/capabilities';
import { probeDecoderAdapters, probeFfmpegWasmAdapter, type DecoderAdapterProbe } from './core/decoder-adapter';
import { analyzeMp4HevcSamples, parseLengthPrefixedHevcSample } from './core/hevc';
import { parseMediaFile, type ParsedMediaSource } from './core/media-source';
import type { Mp4VideoTrack } from './core/mp4';
import { convertI420P10ToSdrPreview, createI420P10Frame, type SdrPreviewImage } from './core/raw-frame';
import type { DecodedFrameProbe } from './core/webcodecs';

const app = document.querySelector<HTMLDivElement>('#app');

function statusClass(ok: boolean): string {
  return ok ? 'status status-ok' : 'status status-warn';
}

async function renderHome() {
  if (!app) return;
  const features = await probeBrowserCapabilities();
  const report = evaluateCapabilities({ ...features, outputFormat: 'I420P10', rpuPresent: true });

  app.innerHTML = `
    <main class="shell">
      <section class="mast">
        <div>
          <p class="eyebrow">LumaBridge</p>
          <h1>DV P5 to SDR verification console</h1>
        </div>
        <a class="link-button" href="/bench">Open benchmark</a>
      </section>

      <section class="panel grid">
        <div>
          <h2>Capability report</h2>
          <div class="check-row"><span>WebGPU</span><strong class="${statusClass(features.hasWebGPU)}">${features.hasWebGPU ? 'ready' : 'missing'}</strong></div>
          <div class="check-row"><span>WebCodecs</span><strong class="${statusClass(features.hasWebCodecs)}">${features.hasWebCodecs ? 'ready' : 'missing'}</strong></div>
          <div class="check-row"><span>HEVC Main10 probe</span><strong class="${statusClass(features.hevcSupported)}">${features.hevcSupported ? 'supported' : 'not confirmed'}</strong></div>
          <div class="check-row"><span>DV path</span><strong class="${statusClass(report.ok)}">${report.ok ? 'eligible' : report.failures.join(', ')}</strong></div>
        </div>
        <div>
          <h2>Debug frame contract</h2>
          <dl class="debug-list">
            <dt>format</dt><dd>I420P10</dd>
            <dt>primaries</dt><dd>BT.2020</dd>
            <dt>transfer</dt><dd>PQ</dd>
            <dt>RPU</dt><dd>present</dd>
            <dt>timestamp</dt><dd>0 us</dd>
          </dl>
        </div>
      </section>

      <section class="viewer" aria-label="Synthetic SDR preview">
        <canvas id="preview" width="480" height="202"></canvas>
        <div class="viewer-meta">
          <span>BT.709 SDR reference</span>
          <span>100 nit target</span>
          <span>sRGB display adaptation</span>
        </div>
      </section>
    </main>
  `;

  const canvas = document.querySelector<HTMLCanvasElement>('#preview');
  const ctx = canvas?.getContext('2d');
  if (canvas && ctx) {
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, '#111827');
    gradient.addColorStop(0.45, '#2f6f73');
    gradient.addColorStop(1, '#e6c35c');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(32, 32, 96, 28);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(152, 88, 240, 56);
  }
}

function renderBench() {
  if (!app) return;
  const frames = createSyntheticBenchmark();
  const summary = summarizeBenchmark(frames);
  const report = {
    selectedVideo: null as null | {
      name: string;
      type: string;
      sizeBytes: number;
      durationSeconds: number | null;
      width: number | null;
      height: number | null;
    },
    mp4: null as null | {
      container: string;
      loadedBytes: number;
      isPartial: boolean;
      warning: string | null;
      brands: string[];
      track: {
        id: number;
        codecType: string;
        codecString: string | null;
        width: number;
        height: number;
        timescale: number;
        durationSeconds: number;
        sampleCount: number;
        syncSamples: number;
        firstSampleBytes: number;
        hasDolbyVisionConfig: boolean;
        lengthSize: number | null;
        firstSampleNalUnits: number;
        firstSampleRpuNalUnits: number;
        totalRpuNalUnits: number;
      };
    },
    webCodecs: null as DecodedFrameProbe | null,
    decoderAdapter: null as DecoderAdapterProbe | null,
    sdrPreview: null as null | {
      width: number;
      height: number;
      seekSeconds: number;
      decodeElapsedMs: number;
      averageRgb: [number, number, number];
      nonBlackPixels: number;
    },
    parseError: null as string | null,
    summary,
  };
  const rows = Object.entries(summary.stages)
    .map(([stage, stats]) => `<tr><th>${stage}</th><td>${stats.p50.toFixed(2)}</td><td>${stats.p95.toFixed(2)}</td><td>${stats.max.toFixed(2)}</td></tr>`)
    .join('');

  app.innerHTML = `
    <main class="shell">
      <section class="mast">
        <div>
          <p class="eyebrow">Benchmark</p>
          <h1>Pipeline timing report</h1>
        </div>
        <a class="link-button" href="/">Back to console</a>
      </section>
      <section class="panel bench-picker">
        <div>
          <h2>Video preview</h2>
          <label class="file-drop" for="video-file">
            <input id="video-file" type="file" accept="video/*,.mkv,.mp4,.mov,.webm" />
            <span>Select local video</span>
            <strong id="selected-name">No file selected</strong>
          </label>
          <dl class="debug-list compact" id="video-meta">
            <dt>type</dt><dd>none</dd>
            <dt>size</dt><dd>0 MB</dd>
            <dt>duration</dt><dd>unknown</dd>
            <dt>resolution</dt><dd>unknown</dd>
          </dl>
          <h2 class="subhead">Track analysis</h2>
          <dl class="debug-list compact" id="track-meta">
            <dt>container</dt><dd>waiting for file</dd>
            <dt>codec</dt><dd>unknown</dd>
            <dt>samples</dt><dd>0</dd>
            <dt>RPU NAL</dt><dd>unknown</dd>
          </dl>
          <h2 class="subhead">WebCodecs probe</h2>
          <dl class="debug-list compact" id="decode-meta">
            <dt>adapter</dt><dd>not selected</dd>
            <dt>support</dt><dd>not run</dd>
            <dt>frame</dt><dd>unknown</dd>
            <dt>format</dt><dd>unknown</dd>
            <dt>color</dt><dd>unknown</dd>
            <dt>copyTo</dt><dd>unknown</dd>
            <dt>fallback</dt><dd>not needed</dd>
          </dl>
          <button id="ffmpeg-raw-probe" class="secondary-button" type="button" disabled>Render selected SDR frame</button>
        </div>
        <div class="video-frame">
          <video id="bench-video" controls muted playsinline preload="metadata"></video>
          <div class="viewer-meta">
            <span>Local preview only</span>
            <span>Benchmark timings remain synthetic until decode pipeline is connected</span>
          </div>
          <canvas id="sdr-preview" class="sdr-preview" width="960" height="402" aria-label="SDR debug preview"></canvas>
          <div class="preview-controls" aria-label="SDR preview time controls">
            <label class="time-slider" for="sdr-preview-time">
              <span>SDR preview time</span>
              <input id="sdr-preview-time" type="range" min="0" max="60" step="0.25" value="0" disabled />
            </label>
            <label class="seconds-field" for="sdr-preview-seconds">
              <span>seconds</span>
              <input id="sdr-preview-seconds" type="number" min="0" max="60" step="0.25" value="0" disabled />
            </label>
          </div>
          <div class="viewer-meta" id="sdr-preview-meta">
            <span>SDR debug preview waiting</span>
            <span>ffmpeg.wasm I420P10 → CPU PQ/BT.2020 approximation</span>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="bench-topline">
          <span>${summary.frames} frames</span>
          <span>${summary.droppedFrames} dropped</span>
          <span>decode queue max ${summary.maxDecodeQueueDepth}</span>
          <span>GPU backlog max ${summary.maxGpuQueueBacklog}</span>
        </div>
        <table>
          <thead><tr><th>Stage</th><th>p50 ms</th><th>p95 ms</th><th>max ms</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <button id="export-report" class="link-button" type="button">Export JSON</button>
        <pre id="report-json">${JSON.stringify(report, null, 2)}</pre>
      </section>
    </main>
  `;

  let objectUrl: string | null = null;
  const video = document.querySelector<HTMLVideoElement>('#bench-video');
  const fileInput = document.querySelector<HTMLInputElement>('#video-file');
  const selectedName = document.querySelector<HTMLElement>('#selected-name');
  const videoMeta = document.querySelector<HTMLElement>('#video-meta');
  const trackMeta = document.querySelector<HTMLElement>('#track-meta');
  const decodeMeta = document.querySelector<HTMLElement>('#decode-meta');
  const reportJson = document.querySelector<HTMLElement>('#report-json');
  const ffmpegRawProbe = document.querySelector<HTMLButtonElement>('#ffmpeg-raw-probe');
  const sdrPreviewCanvas = document.querySelector<HTMLCanvasElement>('#sdr-preview');
  const sdrPreviewMeta = document.querySelector<HTMLElement>('#sdr-preview-meta');
  const previewTimeRange = document.querySelector<HTMLInputElement>('#sdr-preview-time');
  const previewSecondsInput = document.querySelector<HTMLInputElement>('#sdr-preview-seconds');
  let activeTrack: Mp4VideoTrack | null = null;
  let selectionVersion = 0;
  let isRenderingRawPreview = false;

  const updateReport = () => {
    if (reportJson) {
      reportJson.textContent = JSON.stringify(report, (key, value: unknown) => {
        if (key === 'data' && value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
        return value;
      }, 2);
    }
  };

  const formatPreviewSeconds = (seconds: number) => `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;

  const previewDurationLimit = () => {
    const nativeDuration = report.selectedVideo?.durationSeconds;
    if (nativeDuration && Number.isFinite(nativeDuration) && nativeDuration > 0) return nativeDuration;
    const parsedDuration = report.mp4?.isPartial ? null : report.mp4?.track.durationSeconds;
    if (parsedDuration && Number.isFinite(parsedDuration) && parsedDuration > 0) return parsedDuration;
    if (report.selectedVideo) return 3600;
    return 60;
  };

  const updatePreviewControlsMax = () => {
    const max = Math.max(0.25, previewDurationLimit());
    const value = Math.min(readPreviewSeconds(), max);
    for (const input of [previewTimeRange, previewSecondsInput]) {
      if (!input) continue;
      input.max = max.toFixed(2);
      input.value = value.toFixed(2);
    }
  };

  const setPreviewControlsDisabled = (disabled: boolean) => {
    const shouldDisable = disabled || !activeTrack?.hevcConfig || isRenderingRawPreview;
    if (previewTimeRange) previewTimeRange.disabled = shouldDisable;
    if (previewSecondsInput) previewSecondsInput.disabled = shouldDisable;
    if (ffmpegRawProbe) ffmpegRawProbe.disabled = shouldDisable;
  };

  const clampPreviewSeconds = (seconds: number) => {
    const max = Math.max(0.25, previewDurationLimit());
    const safeSeconds = Number.isFinite(seconds) ? seconds : 0;
    return Math.min(max, Math.max(0, safeSeconds));
  };

  const writePreviewSeconds = (seconds: number, syncNativeVideo = true) => {
    const clamped = clampPreviewSeconds(seconds);
    const value = clamped.toFixed(2);
    if (previewTimeRange) previewTimeRange.value = value;
    if (previewSecondsInput) previewSecondsInput.value = value;
    if (syncNativeVideo && video && Number.isFinite(video.duration)) {
      try {
        video.currentTime = clamped;
      } catch {
        // Some browsers reject seeks before metadata is fully ready.
      }
    }
    return clamped;
  };

  function readPreviewSeconds(): number {
    return clampPreviewSeconds(Number(previewSecondsInput?.value ?? previewTimeRange?.value ?? 0));
  }

  const clearSdrPreview = () => {
    if (!sdrPreviewCanvas) return;
    const ctx = sdrPreviewCanvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, sdrPreviewCanvas.width, sdrPreviewCanvas.height);
    updateSdrPreviewStatus([
      'SDR debug preview waiting',
      'ffmpeg.wasm I420P10 -> CPU PQ/BT.2020 approximation',
    ]);
  };

  const updateSdrPreviewStatus = (items: string[]) => {
    if (!sdrPreviewMeta) return;
    sdrPreviewMeta.replaceChildren(...items.map((item) => {
      const span = document.createElement('span');
      span.textContent = item;
      return span;
    }));
  };

  const drawSdrPreview = (preview: SdrPreviewImage, seekSeconds: number, decodeElapsedMs: number) => {
    if (!sdrPreviewCanvas) return;
    sdrPreviewCanvas.width = preview.width;
    sdrPreviewCanvas.height = preview.height;
    const ctx = sdrPreviewCanvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(new ImageData(preview.data, preview.width, preview.height), 0, 0);
    report.sdrPreview = {
      width: preview.width,
      height: preview.height,
      seekSeconds,
      decodeElapsedMs,
      averageRgb: preview.stats.averageRgb,
      nonBlackPixels: preview.stats.nonBlackPixels,
    };
    if (sdrPreviewMeta) {
      sdrPreviewMeta.innerHTML = `
        <span>SDR debug preview ${preview.width} x ${preview.height} @ ${formatPreviewSeconds(seekSeconds)}</span>
        <span>decode ${decodeElapsedMs.toFixed(1)} ms</span>
        <span>avg RGB ${preview.stats.averageRgb.map((value) => value.toFixed(1)).join(', ')}</span>
        <span>${preview.stats.nonBlackPixels} non-black pixels</span>
      `;
    }
  };

  const runFfmpegRawPreview = async (file: File, track: Mp4VideoTrack, version: number, reason: string, requestedSeconds = readPreviewSeconds()) => {
    const seekSeconds = writePreviewSeconds(requestedSeconds);
    if (!report.decoderAdapter) {
      report.decoderAdapter = {
        selected: 'ffmpeg.wasm',
        status: 'fallback-needed',
        webCodecs: report.webCodecs,
        ffmpegWasm: null,
        fallbackReason: reason,
      };
    }

    isRenderingRawPreview = true;
    setPreviewControlsDisabled(true);
    if (ffmpegRawProbe) ffmpegRawProbe.textContent = `Rendering ${formatPreviewSeconds(seekSeconds)}...`;
    updateSdrPreviewStatus([
      `Decoding I420P10 frame at ${formatPreviewSeconds(seekSeconds)} with ffmpeg.wasm`,
      `${track.width} x ${track.height}`,
      'Rendering SDR debug preview',
    ]);
    updateReport();

    const ffmpegWasm = await probeFfmpegWasmAdapter(file, track, { decodeRawFrame: true, seekSeconds });
    if (version !== selectionVersion) {
      isRenderingRawPreview = false;
      return;
    }

    report.decoderAdapter.ffmpegWasm = ffmpegWasm;
    report.decoderAdapter.selected = ffmpegWasm.available ? 'ffmpeg.wasm' : report.decoderAdapter.selected;
    report.decoderAdapter.status = ffmpegWasm.rawFrame.ok ? 'fallback-available' : 'failed';
    report.decoderAdapter.fallbackReason ??= reason;

    const rawFrame = ffmpegWasm.rawFrame;
    if (rawFrame.ok && rawFrame.data) {
      const preview = convertI420P10ToSdrPreview(createI420P10Frame(rawFrame.data, track.width, track.height, 'full'));
      drawSdrPreview(preview, rawFrame.seekSeconds, rawFrame.elapsedMs);
    } else {
      updateSdrPreviewStatus([
        'SDR debug preview failed',
        `requested ${formatPreviewSeconds(seekSeconds)}`,
        rawFrame.error ?? ffmpegWasm.error ?? 'Unknown ffmpeg.wasm error',
      ]);
    }

    updateDecodeMeta(report.decoderAdapter);
    updateReport();
    isRenderingRawPreview = false;
    if (ffmpegRawProbe) {
      ffmpegRawProbe.textContent = 'Render selected SDR frame';
    }
    setPreviewControlsDisabled(false);
  };

  const updateTrackMeta = (
    track: Mp4VideoTrack | null,
    brands: string[] = [],
    error: string | null = null,
    rpuSummary: { firstSampleRpuNalUnits: number; totalRpuNalUnits: number } | null = null,
    source: Pick<ParsedMediaSource, 'container' | 'loadedBytes' | 'isPartial' | 'warning'> | null = null,
  ) => {
    if (!trackMeta) return;
    if (error) {
      trackMeta.innerHTML = `
        <dt>container</dt><dd>parse failed</dd>
        <dt>codec</dt><dd>${error}</dd>
        <dt>samples</dt><dd>0</dd>
        <dt>RPU NAL</dt><dd>unknown</dd>
      `;
      return;
    }
    if (!track) {
      trackMeta.innerHTML = `
        <dt>container</dt><dd>not MP4 or no video track</dd>
        <dt>codec</dt><dd>unknown</dd>
        <dt>samples</dt><dd>0</dd>
        <dt>RPU NAL</dt><dd>unknown</dd>
      `;
      return;
    }
    const loaded = source ? `${(source.loadedBytes / 1024 / 1024).toFixed(1)} MB${source.isPartial ? ' prefix' : ''}` : 'full file';
    const containerLabel = source?.container ?? (brands.join(', ') || 'mp4');
    trackMeta.innerHTML = `
      <dt>container</dt><dd>${containerLabel} (${loaded})</dd>
      <dt>codec</dt><dd>${track.hevcConfig?.codecString ?? track.codecType}</dd>
      <dt>samples</dt><dd>${track.sampleCount} (${track.samples.filter((sample) => sample.isSync).length} sync)</dd>
      <dt>RPU NAL</dt><dd>${rpuSummary ? `${rpuSummary.totalRpuNalUnits} total, ${rpuSummary.firstSampleRpuNalUnits} in first sample` : 'not scanned'}</dd>
      ${source?.warning ? `<dt>note</dt><dd>${source.warning}</dd>` : ''}
    `;
  };

  const updateDecodeMeta = (adapter: DecoderAdapterProbe | null, pending = false) => {
    if (!decodeMeta) return;
    if (pending) {
      decodeMeta.innerHTML = `
        <dt>adapter</dt><dd>probing WebCodecs first</dd>
        <dt>support</dt><dd>probing</dd>
        <dt>frame</dt><dd>waiting for decoder</dd>
        <dt>format</dt><dd>unknown</dd>
        <dt>color</dt><dd>unknown</dd>
        <dt>copyTo</dt><dd>waiting</dd>
        <dt>fallback</dt><dd>ffmpeg.wasm will be checked if needed</dd>
      `;
      return;
    }
    if (!adapter?.webCodecs) {
      decodeMeta.innerHTML = `
        <dt>adapter</dt><dd>not selected</dd>
        <dt>support</dt><dd>not run</dd>
        <dt>frame</dt><dd>unknown</dd>
        <dt>format</dt><dd>unknown</dd>
        <dt>color</dt><dd>unknown</dd>
        <dt>copyTo</dt><dd>unknown</dd>
        <dt>fallback</dt><dd>not needed</dd>
      `;
      return;
    }
    const probe = adapter.webCodecs;
    const color = probe.colorSpace
      ? `${probe.colorSpace.primaries ?? 'unknown'} / ${probe.colorSpace.transfer ?? 'unknown'} / ${probe.colorSpace.matrix ?? 'unknown'}`
      : 'unknown';
    const copyTo = probe.copyTo
      ? probe.copyTo.ok
        ? `${probe.copyTo.allocationSize} bytes, ${probe.copyTo.layout.length} planes, ${probe.copyTo.elapsedMs.toFixed(1)} ms`
        : probe.copyTo.error
      : 'not attempted';
    const fallback = adapter.fallbackReason
      ? adapter.ffmpegWasm
        ? `${adapter.fallbackReason}; ffmpeg.wasm ${adapter.ffmpegWasm.available ? `available in ${adapter.ffmpegWasm.elapsedMs.toFixed(1)} ms${adapter.ffmpegWasm.rawFrame.attempted ? `; raw @ ${formatPreviewSeconds(adapter.ffmpegWasm.rawFrame.seekSeconds)} ${adapter.ffmpegWasm.rawFrame.ok ? 'ok' : `failed: ${adapter.ffmpegWasm.rawFrame.error}`}` : ''}` : `failed: ${adapter.ffmpegWasm.error ?? 'unknown error'}`}`
        : adapter.fallbackReason
      : 'not needed';
    decodeMeta.innerHTML = `
      <dt>adapter</dt><dd>${adapter.selected ?? 'none'} (${adapter.status})</dd>
      <dt>support</dt><dd>${probe.supported ? 'supported' : 'not supported'}${probe.error ? `: ${probe.error}` : ''}</dd>
      <dt>frame</dt><dd>${probe.decodedFrames} decoded in ${probe.elapsedMs.toFixed(1)} ms</dd>
      <dt>format</dt><dd>${probe.format ?? 'unknown'} ${probe.codedWidth && probe.codedHeight ? `${probe.codedWidth} x ${probe.codedHeight}` : ''}</dd>
      <dt>color</dt><dd>${color}</dd>
      <dt>copyTo</dt><dd>${copyTo}</dd>
      <dt>fallback</dt><dd>${fallback}</dd>
    `;
  };

  const updateDecodeSkipped = (track: Mp4VideoTrack) => {
    if (!decodeMeta) return;
    decodeMeta.innerHTML = `
      <dt>adapter</dt><dd>not selected</dd>
      <dt>support</dt><dd>skipped: DV P5 path requires HEVC Main10, got ${track.codecType}</dd>
      <dt>frame</dt><dd>not decoded</dd>
      <dt>format</dt><dd>unknown</dd>
      <dt>color</dt><dd>unknown</dd>
      <dt>copyTo</dt><dd>not attempted</dd>
      <dt>fallback</dt><dd>not applicable for non-HEVC input</dd>
    `;
  };

  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file || !video) return;
    selectionVersion += 1;
    const version = selectionVersion;

    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;
    selectedName?.replaceChildren(document.createTextNode(file.name));
    report.selectedVideo = {
      name: file.name,
      type: file.type || 'unknown',
      sizeBytes: file.size,
      durationSeconds: null,
      width: null,
      height: null,
    };
    report.mp4 = null;
    report.webCodecs = null;
    report.decoderAdapter = null;
    report.sdrPreview = null;
    activeTrack = null;
    report.parseError = null;
    isRenderingRawPreview = false;
    if (ffmpegRawProbe) ffmpegRawProbe.textContent = 'Render selected SDR frame';
    writePreviewSeconds(0, false);
    updatePreviewControlsMax();
    setPreviewControlsDisabled(true);
    clearSdrPreview();
    updateDecodeMeta(null);
    updateReport();

    if (videoMeta) {
      videoMeta.innerHTML = `
        <dt>type</dt><dd>${report.selectedVideo.type}</dd>
        <dt>size</dt><dd>${(file.size / 1024 / 1024).toFixed(2)} MB</dd>
        <dt>duration</dt><dd>reading metadata</dd>
        <dt>resolution</dt><dd>reading metadata</dd>
      `;
    }

    try {
      const parsed = await parseMediaFile(file);
      const track = parsed.tracks[0] ?? null;
      const lengthSize = track?.hevcConfig?.lengthSize ?? 0;
      const firstSample = track?.samples[0] ?? null;
      const firstSampleAnalysis = track && firstSample && lengthSize
        ? parseLengthPrefixedHevcSample(parsed.bytes.subarray(firstSample.offset, firstSample.offset + firstSample.size), lengthSize)
        : null;
      const fullAnalysis = track && lengthSize ? analyzeMp4HevcSamples(parsed.bytes, track.samples, lengthSize) : null;
      if (track) {
        activeTrack = track;
        updatePreviewControlsMax();
        report.mp4 = {
          container: parsed.container,
          loadedBytes: parsed.loadedBytes,
          isPartial: parsed.isPartial,
          warning: parsed.warning,
          brands: parsed.brands,
          track: {
            id: track.id,
            codecType: track.codecType,
            codecString: track.hevcConfig?.codecString ?? null,
            width: track.width,
            height: track.height,
            timescale: track.timescale,
            durationSeconds: track.timescale > 0 ? track.duration / track.timescale : 0,
            sampleCount: track.sampleCount,
            syncSamples: track.samples.filter((sample) => sample.isSync).length,
            firstSampleBytes: track.samples[0]?.size ?? 0,
            hasDolbyVisionConfig: track.hasDolbyVisionConfig,
            lengthSize: track.hevcConfig?.lengthSize ?? null,
            firstSampleNalUnits: firstSampleAnalysis?.nalUnits.length ?? 0,
            firstSampleRpuNalUnits: firstSampleAnalysis?.rpuNalUnits.length ?? 0,
            totalRpuNalUnits: fullAnalysis?.rpuNalUnits.length ?? 0,
          },
        };
      }
      updateTrackMeta(track, parsed.brands, null, fullAnalysis && firstSampleAnalysis ? {
        firstSampleRpuNalUnits: firstSampleAnalysis.rpuNalUnits.length,
        totalRpuNalUnits: fullAnalysis.rpuNalUnits.length,
      } : null, parsed);
      updateReport();
      if (track?.hevcConfig) {
        updateDecodeMeta(null, true);
        report.decoderAdapter = await probeDecoderAdapters(parsed.bytes, track, file);
        if (version !== selectionVersion) return;
        report.webCodecs = report.decoderAdapter.webCodecs;
        setPreviewControlsDisabled(false);
        updateDecodeMeta(report.decoderAdapter);
        if (report.decoderAdapter.selected === 'ffmpeg.wasm' && report.decoderAdapter.ffmpegWasm?.available) {
          void runFfmpegRawPreview(file, track, version, 'Automatic ffmpeg.wasm raw-frame probe after WebCodecs fallback.', 0);
        }
      } else if (track) {
        updateDecodeSkipped(track);
        setPreviewControlsDisabled(true);
      }
    } catch (error) {
      report.parseError = error instanceof Error ? error.message : String(error);
      updateTrackMeta(null, [], report.parseError);
      updateDecodeMeta(null);
      setPreviewControlsDisabled(true);
    }
    updateReport();
  });

  ffmpegRawProbe?.addEventListener('click', async () => {
    const file = fileInput?.files?.[0];
    const track = activeTrack;
    if (!file || !track) return;
    await runFfmpegRawPreview(file, track, selectionVersion, 'Manual ffmpeg.wasm raw-frame probe requested.');
  });

  const requestPreviewAtSelectedTime = async (reason: string) => {
    const file = fileInput?.files?.[0];
    const track = activeTrack;
    if (!file || !track || !track.hevcConfig || isRenderingRawPreview) return;
    await runFfmpegRawPreview(file, track, selectionVersion, reason);
  };

  previewTimeRange?.addEventListener('input', () => {
    writePreviewSeconds(Number(previewTimeRange.value), false);
  });

  previewTimeRange?.addEventListener('change', () => {
    void requestPreviewAtSelectedTime('Manual ffmpeg.wasm raw-frame probe requested from timeline.');
  });

  previewSecondsInput?.addEventListener('input', () => {
    writePreviewSeconds(Number(previewSecondsInput.value), false);
  });

  previewSecondsInput?.addEventListener('change', () => {
    void requestPreviewAtSelectedTime('Manual ffmpeg.wasm raw-frame probe requested from seconds input.');
  });

  video?.addEventListener('loadedmetadata', () => {
    if (!video || !report.selectedVideo || !videoMeta) return;
    report.selectedVideo.durationSeconds = Number.isFinite(video.duration) ? video.duration : null;
    report.selectedVideo.width = video.videoWidth || null;
    report.selectedVideo.height = video.videoHeight || null;
    updatePreviewControlsMax();
    videoMeta.innerHTML = `
      <dt>type</dt><dd>${report.selectedVideo.type}</dd>
      <dt>size</dt><dd>${(report.selectedVideo.sizeBytes / 1024 / 1024).toFixed(2)} MB</dd>
      <dt>duration</dt><dd>${report.selectedVideo.durationSeconds == null ? 'unknown' : `${report.selectedVideo.durationSeconds.toFixed(2)} s`}</dd>
      <dt>resolution</dt><dd>${report.selectedVideo.width && report.selectedVideo.height ? `${report.selectedVideo.width} x ${report.selectedVideo.height}` : 'unknown'}</dd>
    `;
    updateReport();
  });

  document.querySelector('#export-report')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(report, (key, value: unknown) => {
      if (key === 'data' && value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
      return value;
    }, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'lumabridge-benchmark.json';
    anchor.click();
    URL.revokeObjectURL(url);
  });
}

if (location.pathname === '/bench') {
  renderBench();
} else {
  renderHome();
}
