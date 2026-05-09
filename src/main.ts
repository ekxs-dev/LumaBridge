import './styles/app.css';
import { createSyntheticBenchmark, summarizeBenchmark } from './core/benchmark';
import { evaluateCapabilities, probeBrowserCapabilities } from './core/capabilities';

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
        </div>
        <div class="video-frame">
          <video id="bench-video" controls muted playsinline preload="metadata"></video>
          <div class="viewer-meta">
            <span>Local preview only</span>
            <span>Benchmark timings remain synthetic until decode pipeline is connected</span>
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
  const reportJson = document.querySelector<HTMLElement>('#report-json');

  const updateReport = () => {
    if (reportJson) reportJson.textContent = JSON.stringify(report, null, 2);
  };

  fileInput?.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file || !video) return;

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

    if (videoMeta) {
      videoMeta.innerHTML = `
        <dt>type</dt><dd>${report.selectedVideo.type}</dd>
        <dt>size</dt><dd>${(file.size / 1024 / 1024).toFixed(2)} MB</dd>
        <dt>duration</dt><dd>reading metadata</dd>
        <dt>resolution</dt><dd>reading metadata</dd>
      `;
    }
    updateReport();
  });

  video?.addEventListener('loadedmetadata', () => {
    if (!video || !report.selectedVideo || !videoMeta) return;
    report.selectedVideo.durationSeconds = Number.isFinite(video.duration) ? video.duration : null;
    report.selectedVideo.width = video.videoWidth || null;
    report.selectedVideo.height = video.videoHeight || null;
    videoMeta.innerHTML = `
      <dt>type</dt><dd>${report.selectedVideo.type}</dd>
      <dt>size</dt><dd>${(report.selectedVideo.sizeBytes / 1024 / 1024).toFixed(2)} MB</dd>
      <dt>duration</dt><dd>${report.selectedVideo.durationSeconds == null ? 'unknown' : `${report.selectedVideo.durationSeconds.toFixed(2)} s`}</dd>
      <dt>resolution</dt><dd>${report.selectedVideo.width && report.selectedVideo.height ? `${report.selectedVideo.width} x ${report.selectedVideo.height}` : 'unknown'}</dd>
    `;
    updateReport();
  });

  document.querySelector('#export-report')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
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
