import { describe, expect, it } from 'vitest';
import { createSyntheticBenchmark, summarizeBenchmark } from '../../src/core/benchmark';

describe('benchmark summary', () => {
  it('produces p50/p95/max and queue diagnostics', () => {
    const summary = summarizeBenchmark(createSyntheticBenchmark(48));
    expect(summary.frames).toBe(48);
    expect(summary.stages.copyTo.p95).toBeGreaterThan(summary.stages.copyTo.p50);
    expect(summary.stages.shaderRender.max).toBeGreaterThan(0);
    expect(summary.maxDecodeQueueDepth).toBe(3);
  });
});
