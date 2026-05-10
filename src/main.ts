import './styles/app.css';
import { createSyntheticBenchmark, summarizeBenchmark } from './core/benchmark';
import { evaluateCapabilities, probeBrowserCapabilities } from './core/capabilities';
import {
  probeDecoderAdapters,
  probeFfmpegHevcPacket,
  probeFfmpegWasmAdapter,
  type DecoderAdapterProbe,
} from './core/decoder-adapter';
import { analyzeMp4HevcSamples, parseLengthPrefixedHevcSample } from './core/hevc';
import { buildI420P10GpuUpload, type GpuPreviewMode } from './core/gpu-upload';
import { parseMediaFile, type ParsedMediaSource } from './core/media-source';
import type { Mp4VideoTrack } from './core/mp4';
import {
  convertI420P10ToDoviP5BasePreview,
  convertI420P10ToLumaPreview,
  convertI420P10ToSdrPreview,
  createI420P10Frame,
  inspectI420P10Frame,
  type RawFrameStats,
  type RawPreviewMode,
  type SdrPreviewImage,
} from './core/raw-frame';
import { inspectRpuAnnexBPacket, inspectRpuForSeconds, type RpuFrameSelection } from './core/rpu-alignment';
import { parseRpuMetadataForShader, type RpuMetadataProbe } from './core/rpu-metadata';
import { renderI420P10SdrWithWebGpu, type WebGpuSdrRenderProbe } from './core/webgpu-render';
import {
  EXTERNAL_PREVIEW_RECOVERY_MODES,
  renderWebCodecsExternalTexturePreview,
  type ExternalPreviewRecoveryMode,
  type WebGpuExternalPreviewStats,
} from './core/webgpu-external-preview';
import { uploadI420P10ToWebGpu, type WebGpuUploadProbe } from './core/webgpu-upload';
import {
  renderWebCodecsCanvasPreview,
  type DecodedFrameProbe,
  type WebCodecsCanvasPreviewStats,
} from './core/webcodecs';
import {
  clampRealtimeTargetFps,
  createRealtimePreviewReport,
  realtimeSecondsForWallClock,
  updateRealtimeFrameReport,
  type RealtimePreviewReport,
} from './core/realtime-preview';
import {
  comparePreviewToReference,
  diagnoseReferenceGap,
  type PixelErrorStats,
  type ReferenceGapDiagnosis,
  type ReferenceImage,
} from './core/reference-compare';

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
    webCodecsCanvasPreview: null as WebCodecsCanvasPreviewStats | null,
    webCodecsExternalPreview: null as WebGpuExternalPreviewStats | null,
    decoderAdapter: null as DecoderAdapterProbe | null,
    frameRpu: null as RpuFrameSelection | null,
    rpuMetadata: null as RpuMetadataProbe | null,
    gpuUpload: null as WebGpuUploadProbe | null,
    gpuRender: null as WebGpuSdrRenderProbe | null,
    rawFrameStats: null as RawFrameStats | null,
    sdrPreview: null as null | {
      width: number;
      height: number;
      mode: RawPreviewMode;
      renderer: 'cpu' | 'webgpu';
      seekSeconds: number;
      decodeElapsedMs: number;
      averageRgb: [number, number, number];
      nonBlackPixels: number;
    },
    referenceCompare: null as PixelErrorStats | null,
    referenceDiagnosis: null as ReferenceGapDiagnosis | null,
    realtimePreview: createRealtimePreviewReport(),
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
          <button id="webcodecs-fast-preview" class="secondary-button" type="button" disabled>Fast WebCodecs preview</button>
          <button id="webgpu-external-preview-button" class="secondary-button" type="button" disabled>Fast WebGPU SDR preview</button>
          <label class="select-field" for="external-recovery-mode">
            <span>external recovery</span>
            <select id="external-recovery-mode" disabled>
              ${EXTERNAL_PREVIEW_RECOVERY_MODES.map((mode) => `<option value="${mode}"${mode === 'recover-709-full' ? ' selected' : ''}>${mode}</option>`).join('')}
            </select>
          </label>
          <h2 class="subhead">Frame/RPU alignment</h2>
          <dl class="debug-list compact" id="frame-rpu-meta">
            <dt>time</dt><dd>not selected</dd>
            <dt>sample</dt><dd>unknown</dd>
            <dt>RPU</dt><dd>unknown</dd>
            <dt>first NAL</dt><dd>unknown</dd>
          </dl>
          <h2 class="subhead">WebGPU upload</h2>
          <dl class="debug-list compact" id="gpu-upload-meta">
            <dt>status</dt><dd>waiting</dd>
            <dt>buffers</dt><dd>unknown</dd>
            <dt>bytes</dt><dd>unknown</dd>
          </dl>
          <h2 class="subhead">WebGPU render</h2>
          <dl class="debug-list compact" id="gpu-render-meta">
            <dt>status</dt><dd>waiting</dd>
            <dt>shader</dt><dd>unknown</dd>
            <dt>readback</dt><dd>unknown</dd>
          </dl>
          <h2 class="subhead">Reference compare</h2>
          <label class="reference-picker" for="reference-file">
            <input id="reference-file" type="file" accept="image/png,image/*" />
            <span>Load libplacebo PNG</span>
          </label>
          <dl class="debug-list compact" id="reference-meta">
            <dt>reference</dt><dd>none</dd>
            <dt>MAE</dt><dd>waiting</dd>
            <dt>max</dt><dd>waiting</dd>
          </dl>
        </div>
        <div class="video-frame">
          <video id="bench-video" controls muted playsinline preload="metadata"></video>
          <div class="viewer-meta">
            <span>Local preview only</span>
            <span>Benchmark timings remain synthetic until decode pipeline is connected</span>
          </div>
          <canvas id="sdr-preview" class="sdr-preview" width="960" height="402" aria-label="SDR debug preview"></canvas>
          <canvas id="external-preview" class="sdr-preview external-preview is-hidden" width="960" height="402" aria-label="Fast WebGPU external texture preview"></canvas>
          <div class="mode-toggle" role="group" aria-label="Preview mode">
            <button class="mode-button active" type="button" data-preview-mode="raw-luma">Raw luma</button>
            <button class="mode-button" type="button" data-preview-mode="dv-p5-base">DV P5 base</button>
            <button class="mode-button" type="button" data-preview-mode="sdr-approx">PQ SDR approx</button>
          </div>
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
          <div class="realtime-controls" aria-label="Realtime SDR preview controls">
            <button id="realtime-toggle" class="secondary-button realtime-button" type="button" disabled>Start realtime preview</button>
            <label class="seconds-field" for="realtime-fps">
              <span>target fps</span>
              <input id="realtime-fps" type="number" min="0.25" max="4" step="0.25" value="0.25" disabled />
            </label>
          </div>
          <dl class="debug-list compact realtime-meta" id="realtime-meta">
            <dt>status</dt><dd>idle</dd>
            <dt>adapter</dt><dd>waiting</dd>
            <dt>rate</dt><dd>0.00 fps</dd>
            <dt>frames</dt><dd>0 rendered, 0 dropped</dd>
          </dl>
          <div class="viewer-meta" id="sdr-preview-meta">
            <span>Debug preview waiting</span>
            <span>Raw luma diagnostic from ffmpeg.wasm I420P10</span>
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
  const frameRpuMeta = document.querySelector<HTMLElement>('#frame-rpu-meta');
  const gpuUploadMeta = document.querySelector<HTMLElement>('#gpu-upload-meta');
  const gpuRenderMeta = document.querySelector<HTMLElement>('#gpu-render-meta');
  const referenceFileInput = document.querySelector<HTMLInputElement>('#reference-file');
  const referenceMeta = document.querySelector<HTMLElement>('#reference-meta');
  const reportJson = document.querySelector<HTMLElement>('#report-json');
  const ffmpegRawProbe = document.querySelector<HTMLButtonElement>('#ffmpeg-raw-probe');
  const webCodecsFastPreview = document.querySelector<HTMLButtonElement>('#webcodecs-fast-preview');
  const webGpuExternalPreviewButton = document.querySelector<HTMLButtonElement>('#webgpu-external-preview-button');
  const externalRecoveryModeSelect = document.querySelector<HTMLSelectElement>('#external-recovery-mode');
  const sdrPreviewCanvas = document.querySelector<HTMLCanvasElement>('#sdr-preview');
  const externalPreviewCanvas = document.querySelector<HTMLCanvasElement>('#external-preview');
  const sdrPreviewMeta = document.querySelector<HTMLElement>('#sdr-preview-meta');
  const previewTimeRange = document.querySelector<HTMLInputElement>('#sdr-preview-time');
  const previewSecondsInput = document.querySelector<HTMLInputElement>('#sdr-preview-seconds');
  const previewModeButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-preview-mode]')];
  const realtimeToggle = document.querySelector<HTMLButtonElement>('#realtime-toggle');
  const realtimeFpsInput = document.querySelector<HTMLInputElement>('#realtime-fps');
  const realtimeMeta = document.querySelector<HTMLElement>('#realtime-meta');
  let activeTrack: Mp4VideoTrack | null = null;
  let activeParsedSource: ParsedMediaSource | null = null;
  let selectionVersion = 0;
  let isRenderingRawPreview = false;
  let realtimeAbort: AbortController | null = null;
  let realtimeRunVersion = 0;
  let previewMode: RawPreviewMode = 'raw-luma';
  let activeReference: ReferenceImage | null = null;
  let lastSdrPreview: SdrPreviewImage | null = null;

  const updateReport = () => {
    if (reportJson) {
      reportJson.textContent = JSON.stringify(report, (key, value: unknown) => {
        if ((key === 'data' || key === 'firstRpuPayload') && value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
        return value;
      }, 2);
    }
  };

  const realtimeAdapterLabel = () => {
    const adapter = report.decoderAdapter;
    if (adapter?.selected === 'webcodecs') return 'webcodecs';
    if (adapter?.ffmpegWasm?.available || adapter?.selected === 'ffmpeg.wasm') return 'ffmpeg.wasm';
    return null;
  };

  const updateRealtimeMeta = (preview: RealtimePreviewReport = report.realtimePreview) => {
    report.realtimePreview = preview;
    if (realtimeFpsInput) realtimeFpsInput.value = preview.targetFps.toFixed(2);
    if (realtimeToggle) {
      realtimeToggle.textContent = preview.status === 'running' ? 'Stop realtime preview' : 'Start realtime preview';
    }
    if (!realtimeMeta) return;
    const frameMs = preview.lastFrameMs == null ? 'waiting' : `${preview.lastFrameMs.toFixed(1)} ms`;
    const avgMs = preview.averageFrameMs == null ? 'waiting' : `${preview.averageFrameMs.toFixed(1)} ms`;
    realtimeMeta.innerHTML = `
      <dt>status</dt><dd>${preview.status}</dd>
      <dt>adapter</dt><dd>${preview.adapter ?? 'waiting'}</dd>
      <dt>rate</dt><dd>${preview.effectiveFps.toFixed(2)} fps / target ${preview.targetFps.toFixed(2)}</dd>
      <dt>frames</dt><dd>${preview.renderedFrames} rendered, ${preview.droppedFrames} dropped</dd>
      <dt>frame ms</dt><dd>${frameMs}, avg ${avgMs}</dd>
      <dt>time</dt><dd>${preview.currentSeconds == null ? 'waiting' : formatPreviewSeconds(preview.currentSeconds)}</dd>
      <dt>failures</dt><dd>${preview.consecutiveFailures} consecutive</dd>
      ${preview.note ? `<dt>note</dt><dd>${preview.note}</dd>` : ''}
      ${preview.error ? `<dt>error</dt><dd>${preview.error}</dd>` : ''}
    `;
  };

  const stopRealtimePreview = (status: RealtimePreviewReport['status'] = 'stopped', error: string | null = null) => {
    realtimeRunVersion += 1;
    realtimeAbort?.abort();
    realtimeAbort = null;
    const adapter = report.realtimePreview.adapter ?? realtimeAdapterLabel();
    updateRealtimeMeta({
      ...report.realtimePreview,
      adapter,
      status,
      error,
      note: report.realtimePreview.note,
    });
    if (realtimeToggle) realtimeToggle.textContent = 'Start realtime preview';
    setPreviewControlsDisabled(false);
    updateReport();
  };

  const isRealtimeRunning = (preview: RealtimePreviewReport): boolean => preview.status === 'running';

  const updateFrameRpuMeta = (selection: RpuFrameSelection | null, options: { preserveMetadata?: boolean } = {}) => {
    report.frameRpu = selection
      ? {
          ...selection,
          firstRpuPayload: selection.firstRpuPayload ? new Uint8Array(selection.firstRpuPayload) : null,
        }
      : null;
    if (!options.preserveMetadata) {
      report.rpuMetadata = null;
    }
    if (!frameRpuMeta) return;
    if (!selection) {
      frameRpuMeta.innerHTML = `
        <dt>time</dt><dd>not selected</dd>
        <dt>sample</dt><dd>unknown</dd>
        <dt>RPU</dt><dd>unknown</dd>
        <dt>first NAL</dt><dd>unknown</dd>
      `;
      return;
    }

    const timestamp = selection.timestampUs == null
      ? 'unknown'
      : `${(selection.timestampUs / 1_000_000).toFixed(3)} s`;
    const duration = selection.durationUs == null
      ? 'unknown'
      : `${(selection.durationUs / 1_000).toFixed(1)} ms`;
    const sample = selection.sampleIndex == null
      ? selection.status === 'present' || selection.status === 'missing'
        ? `ffmpeg packet probe @ ${timestamp}`
        : 'outside parsed sample window'
      : `#${selection.sampleIndex} @ ${timestamp}, ${duration}, ${selection.isSync ? 'sync' : 'delta'}`;
    const firstNal = selection.firstRpuNalHex
      ? `${selection.firstRpuNalSize} bytes at ${selection.firstRpuNalOffset}: ${selection.firstRpuNalHex}`
      : 'none';
    const metadata = report.rpuMetadata;
    const metadataLabel = metadata
      ? metadata.source === 'wasm' && metadata.ok
        ? `wasm parsed, source PQ ${metadata.sourceMinPq?.toFixed(4)}-${metadata.sourceMaxPq?.toFixed(4)}, L1 ${metadata.level1MaxPq?.toFixed(4)}/${metadata.level1AvgPq?.toFixed(4)}`
        : `${metadata.source}${metadata.error ? `: ${metadata.error}` : ''}`
      : selection.firstRpuPayload
        ? 'waiting for render'
        : 'not available';
    frameRpuMeta.innerHTML = `
      <dt>time</dt><dd>${selection.requestedSeconds.toFixed(3)} s</dd>
      <dt>sample</dt><dd>${sample}</dd>
      <dt>RPU</dt><dd>${selection.status}${selection.rpuNalUnits ? `, ${selection.rpuNalUnits} NAL` : ''}</dd>
      <dt>first NAL</dt><dd>${firstNal}</dd>
      <dt>metadata</dt><dd>${metadataLabel}</dd>
      ${selection.error ? `<dt>note</dt><dd>${selection.error}</dd>` : ''}
    `;
  };

  const updateGpuUploadMeta = (probe: WebGpuUploadProbe | null) => {
    report.gpuUpload = probe;
    if (!gpuUploadMeta) return;
    if (!probe) {
      gpuUploadMeta.innerHTML = `
        <dt>status</dt><dd>waiting</dd>
        <dt>buffers</dt><dd>unknown</dd>
        <dt>bytes</dt><dd>unknown</dd>
      `;
      return;
    }
    gpuUploadMeta.innerHTML = `
      <dt>status</dt><dd>${probe.ok ? 'uploaded' : probe.attempted ? 'failed' : 'unavailable'}${probe.elapsedMs ? ` in ${probe.elapsedMs.toFixed(1)} ms` : ''}</dd>
      <dt>buffers</dt><dd>${probe.buffers}</dd>
      <dt>bytes</dt><dd>${probe.bytes ? `${(probe.bytes / 1024 / 1024).toFixed(2)} MB` : '0'}</dd>
      ${probe.error ? `<dt>note</dt><dd>${probe.error}</dd>` : ''}
    `;
  };

  const updateGpuRenderMeta = (probe: WebGpuSdrRenderProbe | null) => {
    report.gpuRender = probe;
    if (!gpuRenderMeta) return;
    if (!probe) {
      gpuRenderMeta.innerHTML = `
        <dt>status</dt><dd>waiting</dd>
        <dt>shader</dt><dd>unknown</dd>
        <dt>readback</dt><dd>unknown</dd>
      `;
      return;
    }
    const raw = report.rawFrameStats;
    const rawLabel = raw
      ? `Y ${raw.y.min}-${raw.y.max} avg ${raw.y.average.toFixed(1)}, U ${raw.u.min}-${raw.u.max}, V ${raw.v.min}-${raw.v.max}`
      : null;
    gpuRenderMeta.innerHTML = `
      <dt>status</dt><dd>${probe.ok ? `rendered ${probe.width} x ${probe.height}` : probe.attempted ? 'failed' : 'unavailable'}${probe.elapsedMs ? ` in ${probe.elapsedMs.toFixed(1)} ms` : ''}</dd>
      <dt>shader</dt><dd>${probe.shaderElapsedMs ? `${probe.shaderElapsedMs.toFixed(1)} ms` : 'not run'}</dd>
      <dt>readback</dt><dd>${probe.readbackElapsedMs ? `${probe.readbackElapsedMs.toFixed(1)} ms` : 'not run'}</dd>
      <dt>metadata</dt><dd>${probe.metadataSource}</dd>
      ${rawLabel ? `<dt>raw stats</dt><dd>${rawLabel}</dd>` : ''}
      ${probe.averageRgb ? `<dt>avg RGB</dt><dd>${probe.averageRgb.map((value) => value.toFixed(1)).join(', ')}</dd>` : ''}
      ${probe.error ? `<dt>note</dt><dd>${probe.error}</dd>` : ''}
    `;
  };

  const updateReferenceMeta = (note: string | null = null) => {
    if (!referenceMeta) return;
    const stats = report.referenceCompare;
    referenceMeta.innerHTML = `
      <dt>reference</dt><dd>${activeReference ? `${activeReference.name} ${activeReference.width} x ${activeReference.height}` : 'none'}</dd>
      <dt>MAE</dt><dd>${stats ? `${stats.meanAbsError.toFixed(2)} RGB avg (${stats.meanRgbAbsError.map((value) => value.toFixed(2)).join(', ')})` : 'waiting'}</dd>
      ${stats ? `<dt>bias</dt><dd>${stats.meanRgbSignedError.map((value) => value.toFixed(2)).join(', ')}</dd>` : ''}
      ${stats ? `<dt>ref avg</dt><dd>${stats.referenceAverageRgb.map((value) => value.toFixed(1)).join(', ')}</dd>` : ''}
      <dt>max</dt><dd>${stats ? `${stats.maxAbsError.toFixed(0)} at ${stats.maxAbsPixel.x},${stats.maxAbsPixel.y} ${stats.maxAbsPixel.channel}` : 'waiting'}</dd>
      ${stats ? `<dt>outliers</dt><dd>${stats.outlierPixels} above ${stats.outlierThreshold}</dd>` : ''}
      ${report.referenceDiagnosis ? `<dt>diagnosis</dt><dd>${report.referenceDiagnosis.summary}</dd>` : ''}
      ${note ? `<dt>note</dt><dd>${note}</dd>` : ''}
    `;
  };

  const currentRpuAlignment = () => {
    const frameRpu = report.frameRpu;
    if (!frameRpu) return null;
    if (frameRpu.sampleIndex != null) return 'parsed-sample';
    if (frameRpu.status === 'present' || frameRpu.status === 'missing') return 'ffmpeg-packet-probe';
    return 'unresolved';
  };

  const compareLastPreviewWithReference = (note: string | null = null) => {
    if (!activeReference) {
      report.referenceCompare = null;
      report.referenceDiagnosis = null;
      updateReferenceMeta(note);
      return;
    }
    if (!lastSdrPreview) {
      report.referenceCompare = null;
      report.referenceDiagnosis = null;
      updateReferenceMeta(note ?? 'Render a frame before comparing.');
      return;
    }
    try {
      report.referenceCompare = comparePreviewToReference(lastSdrPreview, activeReference);
      report.referenceDiagnosis = diagnoseReferenceGap(report.referenceCompare, {
        previewMode,
        renderer: report.sdrPreview?.renderer ?? null,
        metadataSource: report.gpuRender?.metadataSource ?? null,
        rpuAlignment: currentRpuAlignment(),
      });
      updateReferenceMeta(note);
    } catch (error) {
      report.referenceCompare = null;
      report.referenceDiagnosis = null;
      updateReferenceMeta(error instanceof Error ? error.message : String(error));
    }
  };

  const loadReferenceImage = async (file: File): Promise<ReferenceImage> => {
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas is unavailable for reference decoding.');
      ctx.drawImage(bitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      return {
        name: file.name,
        width: bitmap.width,
        height: bitmap.height,
        data: new Uint8ClampedArray(imageData.data),
      };
    } finally {
      bitmap.close();
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
    const realtimeRunning = report.realtimePreview.status === 'running';
    const baseDisabled = disabled || !activeTrack?.hevcConfig;
    const manualDisabled = baseDisabled || isRenderingRawPreview || realtimeRunning;
    if (previewTimeRange) previewTimeRange.disabled = manualDisabled;
    if (previewSecondsInput) previewSecondsInput.disabled = manualDisabled;
    if (ffmpegRawProbe) ffmpegRawProbe.disabled = manualDisabled;
    if (webCodecsFastPreview) webCodecsFastPreview.disabled = manualDisabled || !activeParsedSource;
    if (webGpuExternalPreviewButton) webGpuExternalPreviewButton.disabled = manualDisabled || !activeParsedSource;
    if (externalRecoveryModeSelect) externalRecoveryModeSelect.disabled = manualDisabled || !activeParsedSource;
    if (realtimeToggle) realtimeToggle.disabled = !realtimeRunning && (baseDisabled || isRenderingRawPreview);
    if (realtimeFpsInput) realtimeFpsInput.disabled = baseDisabled || isRenderingRawPreview || realtimeRunning;
  };

  const readExternalRecoveryMode = (): ExternalPreviewRecoveryMode => {
    const value = externalRecoveryModeSelect?.value;
    return EXTERNAL_PREVIEW_RECOVERY_MODES.includes(value as ExternalPreviewRecoveryMode)
      ? value as ExternalPreviewRecoveryMode
      : 'recover-709-full';
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
    updateSelectedFrameRpuMeta(clamped);
    return clamped;
  };

  function readPreviewSeconds(): number {
    return clampPreviewSeconds(Number(previewSecondsInput?.value ?? previewTimeRange?.value ?? 0));
  }

  function updateSelectedFrameRpuMeta(seconds = readPreviewSeconds()): void {
    if (!activeParsedSource || !activeTrack?.hevcConfig) {
      updateFrameRpuMeta(null);
      return;
    }
    updateFrameRpuMeta(inspectRpuForSeconds(activeParsedSource.bytes, activeTrack, seconds));
  }

  const shouldProbeRpuPacketWithFfmpeg = () => {
    const status = report.frameRpu?.status;
    return status === 'outside-parsed-samples' || status === 'invalid-sample';
  };

  const previewModeLabel = (mode: RawPreviewMode) => {
    if (mode === 'raw-luma') return 'Raw luma diagnostic';
    if (mode === 'dv-p5-base') return 'DV P5 base approximation';
    return 'PQ SDR approximation';
  };

  const isRawPreviewMode = (mode: string | undefined): mode is RawPreviewMode => (
    mode === 'raw-luma' || mode === 'dv-p5-base' || mode === 'sdr-approx'
  );

  const setPreviewMode = (mode: RawPreviewMode) => {
    previewMode = mode;
    for (const button of previewModeButtons) {
      button.classList.toggle('active', button.dataset.previewMode === mode);
    }
  };

  const convertRawFrameForPreview = (data: Uint8Array, track: Mp4VideoTrack, mode: RawPreviewMode) => {
    const frame = createI420P10Frame(data, track.width, track.height, 'full');
    if (mode === 'raw-luma') return convertI420P10ToLumaPreview(frame);
    if (mode === 'dv-p5-base') return convertI420P10ToDoviP5BasePreview(frame);
    return convertI420P10ToSdrPreview(frame);
  };

  const previewModeToGpuMode = (mode: RawPreviewMode): GpuPreviewMode => {
    if (mode === 'raw-luma') return 1;
    if (mode === 'dv-p5-base') return 2;
    return 0;
  };

  const showPreviewCanvas = (kind: 'sdr' | 'external') => {
    sdrPreviewCanvas?.classList.toggle('is-hidden', kind !== 'sdr');
    externalPreviewCanvas?.classList.toggle('is-hidden', kind !== 'external');
  };

  const clearSdrPreview = () => {
    if (!sdrPreviewCanvas) return;
    showPreviewCanvas('sdr');
    lastSdrPreview = null;
    report.referenceCompare = null;
    report.referenceDiagnosis = null;
    const ctx = sdrPreviewCanvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, sdrPreviewCanvas.width, sdrPreviewCanvas.height);
    updateSdrPreviewStatus([
      'Debug preview waiting',
      `${previewModeLabel(previewMode)} from ffmpeg.wasm I420P10`,
    ]);
    compareLastPreviewWithReference();
  };

  const updateSdrPreviewStatus = (items: string[]) => {
    if (!sdrPreviewMeta) return;
    sdrPreviewMeta.replaceChildren(...items.map((item) => {
      const span = document.createElement('span');
      span.textContent = item;
      return span;
    }));
  };

  const drawSdrPreview = (
    preview: SdrPreviewImage,
    mode: RawPreviewMode,
    seekSeconds: number,
    decodeElapsedMs: number,
    renderer: 'cpu' | 'webgpu' = 'cpu',
  ) => {
    if (!sdrPreviewCanvas) return;
    showPreviewCanvas('sdr');
    lastSdrPreview = preview;
    if (sdrPreviewCanvas.width !== preview.width) sdrPreviewCanvas.width = preview.width;
    if (sdrPreviewCanvas.height !== preview.height) sdrPreviewCanvas.height = preview.height;
    const ctx = sdrPreviewCanvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(new ImageData(preview.data, preview.width, preview.height), 0, 0);
    report.sdrPreview = {
      width: preview.width,
      height: preview.height,
      mode,
      renderer,
      seekSeconds,
      decodeElapsedMs,
      averageRgb: preview.stats.averageRgb,
      nonBlackPixels: preview.stats.nonBlackPixels,
    };
    if (sdrPreviewMeta) {
      sdrPreviewMeta.innerHTML = `
        <span>${previewModeLabel(mode)} ${preview.width} x ${preview.height} @ ${formatPreviewSeconds(seekSeconds)}</span>
        <span>${renderer}</span>
        <span>decode ${decodeElapsedMs.toFixed(1)} ms</span>
        <span>avg RGB ${preview.stats.averageRgb.map((value) => value.toFixed(1)).join(', ')}</span>
        <span>${preview.stats.nonBlackPixels} non-black pixels</span>
      `;
    }
    compareLastPreviewWithReference();
  };

  const renderRawFrameForCurrentMode = async (
    data: Uint8Array,
    track: Mp4VideoTrack,
    seekSeconds: number,
    decodeElapsedMs: number,
    version: number,
  ) => {
    const mode = previewMode;
    const frame = createI420P10Frame(data, track.width, track.height, 'full');
    report.rawFrameStats = inspectI420P10Frame(frame);
    const cpuPreview = convertRawFrameForPreview(data, track, mode);
    updateSdrPreviewStatus([
      `${previewModeLabel(mode)} decoded at ${formatPreviewSeconds(seekSeconds)}`,
      `Raw Y ${report.rawFrameStats.y.min}-${report.rawFrameStats.y.max}, avg ${report.rawFrameStats.y.average.toFixed(1)}`,
      'Preparing WebGPU render',
      'Keeping previous preview until the selected SDR frame is ready',
    ]);
    updateReport();

    const gpuUpload = buildI420P10GpuUpload(frame, {
      outputWidth: cpuPreview.width,
      outputHeight: cpuPreview.height,
      previewMode: previewModeToGpuMode(mode),
    });
    updateGpuUploadMeta(await uploadI420P10ToWebGpu(gpuUpload));
    if (version !== selectionVersion) return;

    const metadata = await parseRpuMetadataForShader(report.frameRpu?.firstRpuPayload ?? null);
    if (version !== selectionVersion) return;
    report.rpuMetadata = metadata.probe;
    updateFrameRpuMeta(report.frameRpu, { preserveMetadata: true });

    if (!metadata.probe.ok || metadata.probe.source !== 'wasm') {
      updateGpuRenderMeta({
        attempted: false,
        ok: false,
        elapsedMs: 0,
        uploadElapsedMs: 0,
        shaderElapsedMs: 0,
        readbackElapsedMs: 0,
        bytes: 0,
        width: null,
        height: null,
        mode,
        metadataSource: 'identity',
        averageRgb: null,
        nonBlackPixels: null,
        error: metadata.probe.error ?? 'RPU metadata unavailable; using CPU debug preview.',
      });
      drawSdrPreview(cpuPreview, mode, seekSeconds, decodeElapsedMs, 'cpu');
      updateReport();
      return;
    }

    const gpuRender = await renderI420P10SdrWithWebGpu(gpuUpload, mode, {
      doviMetadata: metadata.packed,
    });
    if (version !== selectionVersion) return;
    updateGpuRenderMeta(gpuRender.probe);
    const gpuBlackButCpuVisible = Boolean(
      gpuRender.preview
      && gpuRender.preview.stats.nonBlackPixels === 0
      && cpuPreview.stats.nonBlackPixels > 0,
    );
    if (gpuRender.preview && !gpuBlackButCpuVisible) {
      drawSdrPreview(gpuRender.preview, mode, seekSeconds, decodeElapsedMs, 'webgpu');
    } else {
      if (gpuBlackButCpuVisible) {
        updateGpuRenderMeta({
          ...gpuRender.probe,
          ok: false,
          error: 'WebGPU render returned a black frame while CPU raw preview is non-black; showing CPU fallback.',
        });
      }
      drawSdrPreview(cpuPreview, mode, seekSeconds, decodeElapsedMs, 'cpu');
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
      previewModeLabel(previewMode),
      `${track.width} x ${track.height}`,
      'Rendering debug preview',
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
      if (shouldProbeRpuPacketWithFfmpeg()) {
        updateFrameRpuMeta({
          requestedSeconds: seekSeconds,
          status: 'outside-parsed-samples',
          sampleIndex: null,
          timestampUs: null,
          durationUs: null,
          isSync: null,
          rpuNalUnits: 0,
          firstRpuNalOffset: null,
          firstRpuNalSize: null,
          firstRpuNalHex: null,
          firstRpuPayload: null,
          error: 'Parsed prefix does not cover this time; probing selected HEVC packet with ffmpeg.wasm before rendering.',
        });
        updateReport();
        const packetProbe = await probeFfmpegHevcPacket(file, { seekSeconds });
        if (version !== selectionVersion) {
          isRenderingRawPreview = false;
          return;
        }
        if (packetProbe.ok && packetProbe.data) {
          updateFrameRpuMeta(inspectRpuAnnexBPacket(packetProbe.data, packetProbe.seekSeconds));
        } else {
          updateFrameRpuMeta({
            requestedSeconds: seekSeconds,
            status: 'invalid-sample',
            sampleIndex: null,
            timestampUs: Math.round(seekSeconds * 1_000_000),
            durationUs: null,
            isSync: null,
            rpuNalUnits: 0,
            firstRpuNalOffset: null,
            firstRpuNalSize: null,
            firstRpuNalHex: null,
            firstRpuPayload: null,
            error: packetProbe.error ?? 'ffmpeg.wasm HEVC packet probe failed.',
          });
        }
      }

      await renderRawFrameForCurrentMode(rawFrame.data, track, rawFrame.seekSeconds, rawFrame.elapsedMs, version);
      if (version !== selectionVersion) {
        isRenderingRawPreview = false;
        return;
      }
    } else {
      updateGpuUploadMeta(null);
      updateGpuRenderMeta(null);
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

  const runRealtimePreview = async () => {
    const file = fileInput?.files?.[0];
    const track = activeTrack;
    if (!file || !track?.hevcConfig || report.realtimePreview.status === 'running') return;

    const targetFps = clampRealtimeTargetFps(Number(realtimeFpsInput?.value ?? report.realtimePreview.targetFps));
    const adapter = realtimeAdapterLabel();
    const hasStrictRealtime = adapter === 'webcodecs' && report.decoderAdapter?.webCodecs?.format === 'I420P10';
    const realtimeAdapter = 'ffmpeg.wasm' as const;
    const note = hasStrictRealtime
      ? 'WebCodecs strict realtime is eligible; this control currently runs the ffmpeg.wasm fallback preview until streaming copyTo is wired.'
      : 'ffmpeg.wasm fallback preview advances on wall clock and skips ahead when decode is slower than target FPS.';
    const startedAtMs = performance.now();
    const startSeconds = readPreviewSeconds();
    const runVersion = selectionVersion;
    const runId = realtimeRunVersion + 1;
    realtimeRunVersion = runId;
    realtimeAbort?.abort();
    realtimeAbort = new AbortController();
    const signal = realtimeAbort.signal;

    updateRealtimeMeta({
      ...createRealtimePreviewReport(targetFps),
      adapter: realtimeAdapter,
      status: 'running',
      currentSeconds: startSeconds,
      note,
      error: null,
    });
    setPreviewControlsDisabled(false);
    updateSdrPreviewStatus([
      `Realtime preview running from ${formatPreviewSeconds(startSeconds)}`,
      note,
    ]);
    updateReport();

    while (!signal.aborted && runId === realtimeRunVersion && runVersion === selectionVersion) {
      const frameStartedAt = performance.now();
      const seconds = realtimeSecondsForWallClock({
        startSeconds,
        startedAtMs,
        nowMs: frameStartedAt,
        durationSeconds: previewDurationLimit(),
      });
      writePreviewSeconds(seconds, false);
      const maxSeconds = previewDurationLimit();
      if (seconds >= maxSeconds && maxSeconds > 0) {
        updateRealtimeMeta({ ...report.realtimePreview, status: 'ended', currentSeconds: seconds });
        break;
      }

      isRenderingRawPreview = true;
      setPreviewControlsDisabled(false);
      try {
        const ffmpegWasm = await probeFfmpegWasmAdapter(file, track, {
          decodeRawFrame: true,
          seekSeconds: seconds,
          timeoutMs: 60_000,
        });
        if (signal.aborted || runId !== realtimeRunVersion || runVersion !== selectionVersion) break;
        if (!report.decoderAdapter) {
          report.decoderAdapter = {
            selected: 'ffmpeg.wasm',
            status: 'fallback-available',
            webCodecs: report.webCodecs,
            ffmpegWasm,
            fallbackReason: 'Realtime fallback preview requested.',
          };
        } else {
          report.decoderAdapter.ffmpegWasm = ffmpegWasm;
          report.decoderAdapter.selected = ffmpegWasm.available ? 'ffmpeg.wasm' : report.decoderAdapter.selected;
          report.decoderAdapter.status = ffmpegWasm.rawFrame.ok ? 'fallback-available' : 'failed';
        }
        updateDecodeMeta(report.decoderAdapter);

        const rawFrame = ffmpegWasm.rawFrame;
        if (!rawFrame.ok || !rawFrame.data) {
          const failures = report.realtimePreview.consecutiveFailures + 1;
          updateRealtimeMeta({
            ...report.realtimePreview,
            status: failures >= 2 ? 'failed' : 'running',
            consecutiveFailures: failures,
            error: rawFrame.error ?? ffmpegWasm.error ?? 'ffmpeg.wasm realtime raw-frame decode failed.',
          });
          if (failures < 2) continue;
          break;
        }

        if (shouldProbeRpuPacketWithFfmpeg()) {
          const packetProbe = await probeFfmpegHevcPacket(file, { seekSeconds: seconds });
          if (signal.aborted || runId !== realtimeRunVersion || runVersion !== selectionVersion) break;
          updateFrameRpuMeta(packetProbe.ok && packetProbe.data
            ? inspectRpuAnnexBPacket(packetProbe.data, packetProbe.seekSeconds)
            : {
                requestedSeconds: seconds,
                status: 'invalid-sample',
                sampleIndex: null,
                timestampUs: Math.round(seconds * 1_000_000),
                durationUs: null,
                isSync: null,
                rpuNalUnits: 0,
                firstRpuNalOffset: null,
                firstRpuNalSize: null,
                firstRpuNalHex: null,
                firstRpuPayload: null,
                error: packetProbe.error ?? 'ffmpeg.wasm HEVC packet probe failed.',
              });
        }

        await renderRawFrameForCurrentMode(rawFrame.data, track, rawFrame.seekSeconds, rawFrame.elapsedMs, runVersion);
        if (signal.aborted || runId !== realtimeRunVersion || runVersion !== selectionVersion) break;
        const frameElapsedMs = performance.now() - frameStartedAt;
        updateRealtimeMeta(updateRealtimeFrameReport(report.realtimePreview, {
          nowMs: performance.now(),
          startedAtMs,
          frameElapsedMs,
          currentSeconds: seconds,
        }));
        updateReport();
        const frameIntervalMs = 1000 / targetFps;
        const delayMs = Math.max(0, frameIntervalMs - (performance.now() - frameStartedAt));
        if (delayMs > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, delayMs));
        }
      } catch (error) {
        updateRealtimeMeta({
          ...report.realtimePreview,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      } finally {
        isRenderingRawPreview = false;
        setPreviewControlsDisabled(false);
      }
    }

    if (runId === realtimeRunVersion && isRealtimeRunning(report.realtimePreview)) {
      updateRealtimeMeta({ ...report.realtimePreview, status: signal.aborted ? 'stopped' : 'ended' });
    }
    if (runId === realtimeRunVersion) {
      realtimeAbort = null;
    }
    isRenderingRawPreview = false;
    setPreviewControlsDisabled(false);
    updateReport();
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
    const fastPreview = report.webCodecsCanvasPreview
      ? report.webCodecsCanvasPreview.ok
        ? `fast preview ${report.webCodecsCanvasPreview.drawnFrames} frames, ${report.webCodecsCanvasPreview.effectiveFps.toFixed(1)} fps, ${report.webCodecsCanvasPreview.elapsedMs.toFixed(1)} ms`
        : `fast preview failed: ${report.webCodecsCanvasPreview.error ?? 'unknown error'}`
      : null;
    const externalPreview = report.webCodecsExternalPreview
      ? report.webCodecsExternalPreview.ok
        ? `external WebGPU ${report.webCodecsExternalPreview.drawnFrames} frames, ${report.webCodecsExternalPreview.effectiveFps.toFixed(1)} fps, ${report.webCodecsExternalPreview.elapsedMs.toFixed(1)} ms`
        : `external WebGPU failed: ${report.webCodecsExternalPreview.error ?? 'unknown error'}`
      : null;
    decodeMeta.innerHTML = `
      <dt>adapter</dt><dd>${adapter.selected ?? 'none'} (${adapter.status})</dd>
      <dt>support</dt><dd>${probe.supported ? 'supported' : 'not supported'}${probe.error ? `: ${probe.error}` : ''}</dd>
      <dt>frame</dt><dd>${probe.decodedFrames} decoded in ${probe.elapsedMs.toFixed(1)} ms</dd>
      <dt>format</dt><dd>${probe.format ?? 'unknown'} ${probe.codedWidth && probe.codedHeight ? `${probe.codedWidth} x ${probe.codedHeight}` : ''}</dd>
      <dt>color</dt><dd>${color}</dd>
      <dt>copyTo</dt><dd>${copyTo}</dd>
      <dt>fallback</dt><dd>${fallback}</dd>
      ${fastPreview ? `<dt>fast path</dt><dd>${fastPreview}</dd>` : ''}
      ${externalPreview ? `<dt>external path</dt><dd>${externalPreview}</dd>` : ''}
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
    report.webCodecsCanvasPreview = null;
    report.webCodecsExternalPreview = null;
    report.decoderAdapter = null;
    report.frameRpu = null;
    report.rpuMetadata = null;
    report.gpuUpload = null;
    report.gpuRender = null;
    report.rawFrameStats = null;
    report.sdrPreview = null;
    report.referenceCompare = null;
    report.referenceDiagnosis = null;
    activeTrack = null;
    activeParsedSource = null;
    report.parseError = null;
    isRenderingRawPreview = false;
    stopRealtimePreview('stopped');
    report.realtimePreview = createRealtimePreviewReport(Number(realtimeFpsInput?.value ?? 1));
    updateRealtimeMeta();
    setPreviewMode('raw-luma');
    if (ffmpegRawProbe) ffmpegRawProbe.textContent = 'Render selected SDR frame';
    if (webCodecsFastPreview) webCodecsFastPreview.textContent = 'Fast WebCodecs preview';
    if (webGpuExternalPreviewButton) webGpuExternalPreviewButton.textContent = 'Fast WebGPU SDR preview';
    if (externalRecoveryModeSelect) externalRecoveryModeSelect.value = 'recover-709-full';
    writePreviewSeconds(0, false);
    updatePreviewControlsMax();
    setPreviewControlsDisabled(true);
    clearSdrPreview();
    updateFrameRpuMeta(null);
    updateGpuUploadMeta(null);
    updateGpuRenderMeta(null);
    updateDecodeMeta(null);
    updateReferenceMeta(activeReference ? 'Render this video frame to compare with the loaded reference.' : null);
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
      activeParsedSource = parsed;
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
      updateSelectedFrameRpuMeta();
      updateReport();
      if (track?.hevcConfig) {
        updateDecodeMeta(null, true);
        report.decoderAdapter = await probeDecoderAdapters(parsed.bytes, track, file);
        if (version !== selectionVersion) return;
        report.webCodecs = report.decoderAdapter.webCodecs;
        setPreviewControlsDisabled(false);
        updateDecodeMeta(report.decoderAdapter);
        updateRealtimeMeta({
          ...report.realtimePreview,
          adapter: realtimeAdapterLabel(),
          note: report.decoderAdapter.selected === 'webcodecs'
            ? 'Strict realtime decode may be possible once streaming VideoFrame.copyTo is enabled.'
            : 'WebCodecs did not provide the strict I420P10 path; realtime preview will use ffmpeg.wasm fallback.',
        });
        if (report.decoderAdapter.selected === 'ffmpeg.wasm' && report.decoderAdapter.ffmpegWasm?.available) {
          void runFfmpegRawPreview(file, track, version, 'Automatic ffmpeg.wasm raw-frame probe after WebCodecs fallback.', 0);
        }
      } else if (track) {
        updateDecodeSkipped(track);
        setPreviewControlsDisabled(true);
        updateRealtimeMeta({
          ...report.realtimePreview,
          adapter: null,
          status: 'idle',
          note: null,
          error: 'Realtime DV preview requires an HEVC/DV track.',
        });
      }
    } catch (error) {
      report.parseError = error instanceof Error ? error.message : String(error);
      updateTrackMeta(null, [], report.parseError);
      updateFrameRpuMeta(null);
      updateDecodeMeta(null);
      updateGpuRenderMeta(null);
      setPreviewControlsDisabled(true);
      updateRealtimeMeta({
        ...report.realtimePreview,
        adapter: null,
        status: 'failed',
        error: report.parseError,
      });
    }
    updateReport();
  });

  ffmpegRawProbe?.addEventListener('click', async () => {
    const file = fileInput?.files?.[0];
    const track = activeTrack;
    if (!file || !track) return;
    await runFfmpegRawPreview(file, track, selectionVersion, 'Manual ffmpeg.wasm raw-frame probe requested.');
  });

  webCodecsFastPreview?.addEventListener('click', async () => {
    const parsed = activeParsedSource;
    const track = activeTrack;
    if (!parsed || !track?.hevcConfig || !sdrPreviewCanvas) return;
    const startSeconds = readPreviewSeconds();
    isRenderingRawPreview = true;
    setPreviewControlsDisabled(true);
    webCodecsFastPreview.textContent = 'Running fast preview...';
    updateSdrPreviewStatus([
      `WebCodecs fast preview running from ${formatPreviewSeconds(startSeconds)}`,
      'Browser decoded VideoFrames are drawn directly to canvas',
      'This is a speed/visibility path, not the strict raw DV SDR path',
    ]);
    updateReport();
    try {
      const stats = await renderWebCodecsCanvasPreview(parsed.bytes, track, sdrPreviewCanvas, {
        maxFrames: 180,
        maxSeconds: 6,
        startSeconds,
      });
      report.webCodecsCanvasPreview = stats;
      updateDecodeMeta(report.decoderAdapter);
      updateSdrPreviewStatus([
        stats.ok ? 'WebCodecs fast preview complete' : 'WebCodecs fast preview failed',
        `requested ${formatPreviewSeconds(stats.requestedStartSeconds)}${stats.firstDrawnTimestampUs != null ? `, first frame ${(stats.firstDrawnTimestampUs / 1_000_000).toFixed(2)} s` : ''}`,
        `${stats.drawnFrames} drawn / ${stats.decodedFrames} decoded`,
        `${stats.effectiveFps.toFixed(1)} fps, ${stats.elapsedMs.toFixed(1)} ms`,
        stats.error ?? 'Browser opaque VideoFrame path; color may not match DV SDR reference',
      ]);
    } finally {
      isRenderingRawPreview = false;
      webCodecsFastPreview.textContent = 'Fast WebCodecs preview';
      setPreviewControlsDisabled(false);
      updateReport();
    }
  });

  webGpuExternalPreviewButton?.addEventListener('click', async () => {
    const parsed = activeParsedSource;
    const track = activeTrack;
    if (!parsed || !track?.hevcConfig || !externalPreviewCanvas) return;
    isRenderingRawPreview = true;
    setPreviewControlsDisabled(true);
    showPreviewCanvas('external');
    const recoveryMode = readExternalRecoveryMode();
    const startSeconds = readPreviewSeconds();
    webGpuExternalPreviewButton.textContent = 'Running WebGPU preview...';
    lastSdrPreview = null;
    report.referenceCompare = null;
    report.referenceDiagnosis = null;
    updateReferenceMeta('External texture preview has no CPU readback yet; reference comparison is unavailable.');
    updateSdrPreviewStatus([
      `Fast WebGPU SDR preview running from ${formatPreviewSeconds(startSeconds)}`,
      'WebCodecs VideoFrames are imported as WebGPU external textures',
      `recovery ${recoveryMode}`,
      'Playing at frame timestamps; approximate color, not libplacebo/reference SDR',
    ]);
    updateReport();
    try {
      const stats = await renderWebCodecsExternalTexturePreview(parsed.bytes, track, externalPreviewCanvas, {
        maxFrames: 720,
        maxSeconds: 30,
        startSeconds,
        realtime: true,
        recoveryMode,
      });
      report.webCodecsExternalPreview = stats;
      updateDecodeMeta(report.decoderAdapter);
      updateSdrPreviewStatus([
        stats.ok ? 'Fast WebGPU SDR preview complete' : 'Fast WebGPU SDR preview failed',
        `requested ${formatPreviewSeconds(stats.requestedStartSeconds)}${stats.firstDrawnTimestampUs != null ? `, first frame ${(stats.firstDrawnTimestampUs / 1_000_000).toFixed(2)} s` : ''}`,
        `${stats.drawnFrames} drawn / ${stats.decodedFrames} decoded`,
        `${stats.presentationMode} ${stats.effectiveFps.toFixed(1)} fps, ${stats.elapsedMs.toFixed(1)} ms`,
        `recovery ${stats.recoveryMode}`,
        stats.error ?? 'External texture path is fast but starts from browser-converted opaque RGB',
      ]);
    } finally {
      isRenderingRawPreview = false;
      webGpuExternalPreviewButton.textContent = 'Fast WebGPU SDR preview';
      setPreviewControlsDisabled(false);
      updateReport();
    }
  });

  referenceFileInput?.addEventListener('change', async () => {
    const file = referenceFileInput.files?.[0];
    if (!file) return;
    report.referenceCompare = null;
    report.referenceDiagnosis = null;
    updateReferenceMeta('Loading reference image.');
    updateReport();
    try {
      activeReference = await loadReferenceImage(file);
      compareLastPreviewWithReference();
    } catch (error) {
      activeReference = null;
      report.referenceCompare = null;
      report.referenceDiagnosis = null;
      updateReferenceMeta(error instanceof Error ? error.message : String(error));
    }
    updateReport();
  });

  const requestPreviewAtSelectedTime = async (reason: string) => {
    const file = fileInput?.files?.[0];
    const track = activeTrack;
    if (!file || !track || !track.hevcConfig || isRenderingRawPreview) return;
    await runFfmpegRawPreview(file, track, selectionVersion, reason);
  };

  realtimeToggle?.addEventListener('click', () => {
    if (report.realtimePreview.status === 'running') {
      stopRealtimePreview('stopped');
      return;
    }
    void runRealtimePreview();
  });

  realtimeFpsInput?.addEventListener('change', () => {
    const targetFps = clampRealtimeTargetFps(Number(realtimeFpsInput.value));
    updateRealtimeMeta({
      ...report.realtimePreview,
      targetFps,
      note: report.realtimePreview.note ?? 'Target FPS applies to the next realtime preview run.',
    });
    updateReport();
  });

  previewTimeRange?.addEventListener('input', () => {
    writePreviewSeconds(Number(previewTimeRange.value), false);
    updateReport();
  });

  previewTimeRange?.addEventListener('change', () => {
    void requestPreviewAtSelectedTime('Manual ffmpeg.wasm raw-frame probe requested from timeline.');
  });

  previewSecondsInput?.addEventListener('input', () => {
    writePreviewSeconds(Number(previewSecondsInput.value), false);
    updateReport();
  });

  previewSecondsInput?.addEventListener('change', () => {
    void requestPreviewAtSelectedTime('Manual ffmpeg.wasm raw-frame probe requested from seconds input.');
  });

  for (const button of previewModeButtons) {
    button.addEventListener('click', () => {
      const mode = button.dataset.previewMode;
      if (!isRawPreviewMode(mode)) return;
      setPreviewMode(mode);

      const track = activeTrack;
      const rawFrame = report.decoderAdapter?.ffmpegWasm?.rawFrame;
      if (track && rawFrame?.ok && rawFrame.data) {
        void renderRawFrameForCurrentMode(rawFrame.data, track, rawFrame.seekSeconds, rawFrame.elapsedMs, selectionVersion).then(updateReport);
      } else {
        updateSdrPreviewStatus([
          'Debug preview waiting',
          `${previewModeLabel(previewMode)} from ffmpeg.wasm I420P10`,
        ]);
      }
    });
  }

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
      if ((key === 'data' || key === 'firstRpuPayload') && value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
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
