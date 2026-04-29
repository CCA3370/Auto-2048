// src/autoplay/benchmark.ts
// Deterministic benchmark utilities for comparing AutoPlayer configurations.

import type { Direction } from "../types";
import {
  findBestMoveForBoard,
  type FindBestMoveOptions,
} from "./AutoPlayer";
import {
  getEmptyCells,
  isGameOver,
  simulateMove,
  spawnOnBoard,
  type NumBoard,
} from "./autoSimulator";
import type { HeuristicPresetName } from "./heuristic";
import { runBenchmarkViaWasm } from "./wasmEngine";

export type Seed = number | string;

export interface BenchmarkStrategyConfig extends FindBestMoveOptions {
  name: string;
  heuristicPreset?: HeuristicPresetName;
}

export interface BenchmarkGameOptions {
  seed: Seed;
  strategy: BenchmarkStrategyConfig;
  maxMoves?: number;
}

export interface BenchmarkGameResult {
  seed: Seed;
  strategyName: string;
  score: number;
  maxTile: number;
  steps: number;
  finalBoard: NumBoard;
  moveCounts: Record<Direction, number>;
  reached2048: boolean;
  reached4096: boolean;
  reached8192: boolean;
}

export interface BenchmarkSummary {
  strategyName: string;
  games: number;
  averageScore: number;
  medianScore: number;
  bestScore: number;
  averageSteps: number;
  bestTile: number;
  reached2048Rate: number;
  reached4096Rate: number;
  reached8192Rate: number;
  maxTileDistribution: Record<number, number>;
  results: BenchmarkGameResult[];
}

export function createSeededRandom(seed: Seed): () => number {
  let state = normalizeSeed(seed);
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function runBenchmarkGame(
  options: BenchmarkGameOptions
): BenchmarkGameResult {
  const rng = createSeededRandom(options.seed);
  const maxMoves = options.maxMoves ?? 2000;
  const moveCounts: Record<Direction, number> = {
    up: 0,
    down: 0,
    left: 0,
    right: 0,
  };

  let board = createEmptyBoard(4);
  board = spawnRandomTile(board, rng);
  board = spawnRandomTile(board, rng);

  let score = 0;
  let steps = 0;

  while (!isGameOver(board) && steps < maxMoves) {
    const decision = findBestMoveForBoard(board, options.strategy);
    if (!decision?.bestDirection) break;

    const move = simulateMove(board, decision.bestDirection);
    if (!move.moved) break;

    board = move.board;
    score += move.score;
    moveCounts[decision.bestDirection]++;

    if (getEmptyCells(board).length > 0) {
      board = spawnRandomTile(board, rng);
    }
    steps++;
  }

  const maxTile = getMaxTile(board);
  return {
    seed: options.seed,
    strategyName: options.strategy.name,
    score,
    maxTile,
    steps,
    finalBoard: board,
    moveCounts,
    reached2048: maxTile >= 2048,
    reached4096: maxTile >= 4096,
    reached8192: maxTile >= 8192,
  };
}

export function runBenchmark(
  seeds: Seed[],
  strategies: BenchmarkStrategyConfig[],
  maxMoves?: number
): BenchmarkSummary[] {
  return strategies.map((strategy) => {
    const results = seeds.map((seed) =>
      runBenchmarkGame({ seed, strategy, maxMoves })
    );
    return summarizeResults(strategy.name, results);
  });
}

export async function runBenchmarkAsync(
  seeds: Seed[],
  strategies: BenchmarkStrategyConfig[],
  maxMoves?: number
): Promise<BenchmarkSummary[]> {
  const wasmSummaries = await runBenchmarkViaWasm(seeds, strategies, maxMoves);
  return wasmSummaries ?? runBenchmark(seeds, strategies, maxMoves);
}

function summarizeResults(
  strategyName: string,
  results: BenchmarkGameResult[]
): BenchmarkSummary {
  const scores = results.map((result) => result.score).sort((a, b) => a - b);
  const games = results.length;
  const maxTileDistribution: Record<number, number> = {};

  for (const result of results) {
    maxTileDistribution[result.maxTile] =
      (maxTileDistribution[result.maxTile] ?? 0) + 1;
  }

  return {
    strategyName,
    games,
    averageScore: average(scores),
    medianScore: median(scores),
    bestScore: Math.max(...scores),
    averageSteps: average(results.map((result) => result.steps)),
    bestTile: Math.max(...results.map((result) => result.maxTile)),
    reached2048Rate: rate(results, (result) => result.reached2048),
    reached4096Rate: rate(results, (result) => result.reached4096),
    reached8192Rate: rate(results, (result) => result.reached8192),
    maxTileDistribution,
    results,
  };
}

function createEmptyBoard(size: number): NumBoard {
  return Array.from({ length: size }, () =>
    Array.from({ length: size }, () => 0)
  );
}

function spawnRandomTile(board: NumBoard, rng: () => number): NumBoard {
  const empty = getEmptyCells(board);
  if (empty.length === 0) return board;

  const [row, col] = empty[Math.floor(rng() * empty.length)];
  const value = rng() < 0.9 ? 2 : 4;
  return spawnOnBoard(board, row, col, value);
}

function getMaxTile(board: NumBoard): number {
  let max = 0;
  for (const row of board) {
    for (const value of row) {
      if (value > max) max = value;
    }
  }
  return max;
}

function normalizeSeed(seed: Seed): number {
  if (typeof seed === "number") return seed >>> 0;

  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(sortedValues: number[]): number {
  if (sortedValues.length === 0) return 0;
  const mid = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) return sortedValues[mid];
  return (sortedValues[mid - 1] + sortedValues[mid]) / 2;
}

function rate(
  results: BenchmarkGameResult[],
  predicate: (result: BenchmarkGameResult) => boolean
): number {
  if (results.length === 0) return 0;
  return results.filter(predicate).length / results.length;
}
