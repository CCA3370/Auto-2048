import type {
  FindBestMoveOptions,
  SearchDecision,
  SearchMetrics,
} from "./AutoPlayer";
import type { NumBoard } from "./autoSimulator";
import type {
  BenchmarkStrategyConfig,
  BenchmarkSummary,
  Seed,
} from "./benchmark";
import type { Direction, EvaluatedMove } from "../types";

const WASM_MODULE_PATH = "wasm-autoplayer/wasm_autoplayer.js";
const DIRECTIONS: Direction[] = ["up", "down", "left", "right"];

export interface WasmAutoplayerModule {
  default?: (moduleOrPath?: unknown) => unknown | Promise<unknown>;
  find_best_move: (
    board: Uint32Array,
    options: FindBestMoveOptions
  ) => unknown;
  run_benchmark?: (
    seeds: Seed[],
    strategies: BenchmarkStrategyConfig[],
    maxMoves: number
  ) => unknown;
}

type WasmModuleLoader = () => Promise<WasmAutoplayerModule>;

let wasmModuleLoader: WasmModuleLoader = defaultWasmModuleLoader;
let wasmModulePromise: Promise<WasmAutoplayerModule | undefined> | null = null;

export async function findBestMoveViaWasm(
  board: NumBoard,
  options: FindBestMoveOptions = {}
): Promise<SearchDecision | null | undefined> {
  try {
    const wasm = await getWasmModule();
    if (!wasm) return undefined;

    const rawDecision = await wasm.find_best_move(encodeBoardForWasm(board), options);
    return coerceSearchDecision(rawDecision);
  } catch {
    return undefined;
  }
}

export async function runBenchmarkViaWasm(
  seeds: Seed[],
  strategies: BenchmarkStrategyConfig[],
  maxMoves?: number
): Promise<BenchmarkSummary[] | undefined> {
  try {
    const wasm = await getWasmModule();
    if (!wasm?.run_benchmark) return undefined;

    const rawSummaries = await wasm.run_benchmark(seeds, strategies, maxMoves ?? 0);
    return Array.isArray(rawSummaries)
      ? (rawSummaries as BenchmarkSummary[])
      : undefined;
  } catch {
    return undefined;
  }
}

export function encodeBoardForWasm(board: NumBoard): Uint32Array {
  const encoded = new Uint32Array(16);
  let index = 0;

  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      encoded[index] = Math.max(0, Math.trunc(board[row]?.[col] ?? 0));
      index++;
    }
  }

  return encoded;
}

export function setWasmModuleLoaderForTests(loader: WasmModuleLoader): void {
  wasmModuleLoader = loader;
  wasmModulePromise = null;
}

export function resetWasmModuleLoaderForTests(): void {
  wasmModuleLoader = defaultWasmModuleLoader;
  wasmModulePromise = null;
}

async function getWasmModule(): Promise<WasmAutoplayerModule | undefined> {
  wasmModulePromise ??= loadAndInitializeWasmModule();
  return wasmModulePromise;
}

async function loadAndInitializeWasmModule(): Promise<WasmAutoplayerModule | undefined> {
  try {
    const wasm = await wasmModuleLoader();
    await wasm.default?.();
    return wasm;
  } catch {
    return undefined;
  }
}

async function defaultWasmModuleLoader(): Promise<WasmAutoplayerModule> {
  if (typeof window === "undefined") {
    throw new Error("WASM AutoPlayer is only loaded in a browser runtime.");
  }

  const moduleUrl = new URL(WASM_MODULE_PATH, document.baseURI).href;
  return import(/* @vite-ignore */ moduleUrl) as Promise<WasmAutoplayerModule>;
}

function coerceSearchDecision(value: unknown): SearchDecision | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return undefined;

  const bestDirection = coerceDirection(value.bestDirection);
  return {
    bestDirection,
    bestScore: numberOr(value.bestScore, Number.NEGATIVE_INFINITY),
    depth: Math.max(0, Math.trunc(numberOr(value.depth, 0))),
    evaluatedMoves: coerceEvaluatedMoves(value.evaluatedMoves),
    metrics: coerceMetrics(value.metrics),
  };
}

function coerceEvaluatedMoves(value: unknown): EvaluatedMove[] {
  const moves = DIRECTIONS.map((direction) => ({
    direction,
    score: Number.NEGATIVE_INFINITY,
    valid: false,
  }));

  if (!Array.isArray(value)) return moves;

  for (const item of value) {
    if (!isRecord(item)) continue;
    const direction = coerceDirection(item.direction);
    if (!direction) continue;

    moves[directionIndex(direction)] = {
      direction,
      score: numberOr(item.score, Number.NEGATIVE_INFINITY),
      valid: Boolean(item.valid),
    };
  }

  return moves;
}

function coerceMetrics(value: unknown): SearchMetrics {
  if (!isRecord(value)) {
    return {
      nodes: 0,
      cacheHits: 0,
      cacheMisses: 0,
      chanceNodes: 0,
      durationMs: 0,
      timedOut: false,
    };
  }

  return {
    nodes: Math.max(0, Math.trunc(numberOr(value.nodes, 0))),
    cacheHits: Math.max(0, Math.trunc(numberOr(value.cacheHits, 0))),
    cacheMisses: Math.max(0, Math.trunc(numberOr(value.cacheMisses, 0))),
    chanceNodes: Math.max(0, Math.trunc(numberOr(value.chanceNodes, 0))),
    durationMs: Math.max(0, numberOr(value.durationMs, 0)),
    timedOut: Boolean(value.timedOut),
  };
}

function coerceDirection(value: unknown): Direction | null {
  if (typeof value === "number") {
    return DIRECTIONS[value] ?? null;
  }
  if (typeof value === "string" && isDirection(value)) {
    return value;
  }
  return null;
}

function directionIndex(direction: Direction): number {
  return DIRECTIONS.indexOf(direction);
}

function isDirection(value: string): value is Direction {
  return DIRECTIONS.includes(value as Direction);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && !Number.isNaN(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
