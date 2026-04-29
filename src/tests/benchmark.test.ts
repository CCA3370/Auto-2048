import { describe, it, expect } from "vitest";
import {
  createSeededRandom,
  runBenchmark,
  runBenchmarkGame,
} from "../autoplay/benchmark";

describe("AutoPlayer benchmark utilities", () => {
  it("creates reproducible random sequences", () => {
    const a = createSeededRandom("fixed-seed");
    const b = createSeededRandom("fixed-seed");

    expect([a(), a(), a(), a()]).toEqual([b(), b(), b(), b()]);
  });

  it("runs deterministic benchmark games for the same seed and strategy", () => {
    const strategy = {
      name: "test-balanced",
      thinkingStrength: 1,
      useDynamicDepth: false,
      maxDepth: 1,
      timeBudgetMs: Number.POSITIVE_INFINITY,
      heuristicPreset: "balanced" as const,
    };

    const first = runBenchmarkGame({
      seed: 3370,
      strategy,
      maxMoves: 12,
    });
    const second = runBenchmarkGame({
      seed: 3370,
      strategy,
      maxMoves: 12,
    });

    expect(second).toEqual(first);
    expect(first.steps).toBeGreaterThan(0);
  });

  it("summarizes multiple strategy presets", () => {
    const summaries = runBenchmark(
      [1, 2],
      [
        {
          name: "balanced",
          thinkingStrength: 1,
          useDynamicDepth: false,
          maxDepth: 1,
          timeBudgetMs: Number.POSITIVE_INFINITY,
          heuristicPreset: "balanced",
        },
        {
          name: "survival",
          thinkingStrength: 1,
          useDynamicDepth: false,
          maxDepth: 1,
          timeBudgetMs: Number.POSITIVE_INFINITY,
          heuristicPreset: "survival",
        },
      ],
      8
    );

    expect(summaries).toHaveLength(2);
    expect(summaries[0].games).toBe(2);
    expect(summaries[0].results).toHaveLength(2);
    expect(summaries[0].averageScore).toBeGreaterThanOrEqual(0);
  });
});
