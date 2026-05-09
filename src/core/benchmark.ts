export type BenchmarkStage =
  | 'demux'
  | 'wasmRpuParse'
  | 'webCodecsDecode'
  | 'copyTo'
  | 'gpuUpload'
  | 'shaderRender'
  | 'present';

export type BenchmarkFrame = Record<BenchmarkStage, number> & {
  frame: number;
  dropped: boolean;
  decodeQueueDepth: number;
  gpuQueueBacklog: number;
};

export interface BenchmarkSummary {
  frames: number;
  droppedFrames: number;
  stages: Record<BenchmarkStage, { p50: number; p95: number; max: number }>;
  maxDecodeQueueDepth: number;
  maxGpuQueueBacklog: number;
}

const stages: BenchmarkStage[] = ['demux', 'wasmRpuParse', 'webCodecsDecode', 'copyTo', 'gpuUpload', 'shaderRender', 'present'];

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((pct / 100) * (sorted.length - 1)));
  return sorted[index];
}

export function summarizeBenchmark(frames: BenchmarkFrame[]): BenchmarkSummary {
  const stageSummary = Object.fromEntries(
    stages.map((stage) => {
      const values = frames.map((frame) => frame[stage]);
      return [
        stage,
        {
          p50: percentile(values, 50),
          p95: percentile(values, 95),
          max: values.length ? Math.max(...values) : 0,
        },
      ];
    }),
  ) as BenchmarkSummary['stages'];

  return {
    frames: frames.length,
    droppedFrames: frames.filter((frame) => frame.dropped).length,
    stages: stageSummary,
    maxDecodeQueueDepth: Math.max(0, ...frames.map((frame) => frame.decodeQueueDepth)),
    maxGpuQueueBacklog: Math.max(0, ...frames.map((frame) => frame.gpuQueueBacklog)),
  };
}

export function createSyntheticBenchmark(frameCount = 48): BenchmarkFrame[] {
  return Array.from({ length: frameCount }, (_, frame) => ({
    frame,
    dropped: frame % 29 === 0 && frame > 0,
    decodeQueueDepth: frame % 4,
    gpuQueueBacklog: frame % 3,
    demux: 0.18 + (frame % 5) * 0.02,
    wasmRpuParse: 0.34 + (frame % 7) * 0.03,
    webCodecsDecode: 2.4 + (frame % 11) * 0.11,
    copyTo: 4.8 + (frame % 13) * 0.19,
    gpuUpload: 1.2 + (frame % 3) * 0.08,
    shaderRender: 1.6 + (frame % 9) * 0.1,
    present: 0.32 + (frame % 4) * 0.04,
  }));
}
