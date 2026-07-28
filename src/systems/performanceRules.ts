export interface PerformanceSample {
  averageFrameMs: number;
  fps: number;
  worstFrameMs: number;
}

export function resolvePerformanceSample(
  elapsedSeconds: number,
  frameCount: number,
  worstFrameSeconds: number,
): PerformanceSample {
  if (elapsedSeconds <= 0 || frameCount <= 0) {
    return { averageFrameMs: 0, fps: 0, worstFrameMs: 0 };
  }
  return {
    averageFrameMs: (elapsedSeconds * 1000) / frameCount,
    fps: frameCount / elapsedSeconds,
    worstFrameMs: Math.max(0, worstFrameSeconds) * 1000,
  };
}
