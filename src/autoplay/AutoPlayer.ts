// src/autoplay/AutoPlayer.ts
// AutoPlayer using a strength-tuned Expectimax search.
//
// === CHEAT-PREVENTION BOUNDARY ===
// The AutoPlayer ONLY interacts with the game through:
//   1. game.getBoardSnapshot() - read-only deep copy
//   2. game.requestMove(direction) - the only write channel
//
// The AutoPlayer does NOT:
//   - Access game.board (private)
//   - Call game.spawnTile, game.applyMove, or any internal method
//   - Operate on the real board directly
//   - Manipulate the DOM
//   - Dispatch KeyboardEvent or simulate keyboard input
//
// Simulation is done entirely on local NumBoard copies derived from snapshots.

import type {
  Direction,
  AutoPlayerOptions,
  AutoPlayerStatus,
  AutoPlayerResult,
  EvaluatedMove,
} from "../types";
import type { Game } from "../game/Game";
import {
  cellsToNumBoard,
  simulateMove,
  getEmptyCells,
  isGameOver,
  spawnOnBoard,
  type NumBoard,
} from "./autoSimulator";
import {
  choosePreferredCorner,
  evaluate,
  type Corner,
  type HeuristicPresetName,
} from "./heuristic";

const DIRECTIONS: Direction[] = ["up", "down", "left", "right"];
const PROB_2 = 0.9;
const PROB_4 = 0.1;
const DEFAULT_THINKING_STRENGTH = 6;
const DEFAULT_PRESET: HeuristicPresetName = "balanced";

export interface SearchConfig {
  depth: number;
  timeBudgetMs: number;
  chanceCellLimit: number;
  riskWeight: number;
  worstCaseWeight: number;
  cacheLimit: number;
  heuristicPreset: HeuristicPresetName;
}

export interface SearchMetrics {
  nodes: number;
  cacheHits: number;
  cacheMisses: number;
  chanceNodes: number;
  durationMs: number;
  timedOut: boolean;
}

export interface SearchDecision {
  bestDirection: Direction | null;
  bestScore: number;
  depth: number;
  evaluatedMoves: EvaluatedMove[];
  metrics: SearchMetrics;
}

export interface FindBestMoveOptions {
  thinkingStrength?: number;
  useDynamicDepth?: boolean;
  maxDepth?: number;
  timeBudgetMs?: number;
  heuristicPreset?: HeuristicPresetName;
}

interface OrderedMove {
  direction: Direction;
  board: NumBoard;
  score: number;
  priority: number;
}

interface SearchContext {
  config: SearchConfig;
  preferredCorner: Corner;
  startTime: number;
  cache: Map<string, number>;
  metrics: SearchMetrics;
}

class SearchTimeout extends Error {
  constructor() {
    super("AutoPlayer search timed out");
  }
}

export function normalizeThinkingStrength(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_THINKING_STRENGTH;
  return clampInt(Math.round(value), 1, 10);
}

export function deriveSearchConfig(
  thinkingStrength: number,
  emptyCells: number,
  useDynamicDepth: boolean = true,
  heuristicPreset: HeuristicPresetName = DEFAULT_PRESET
): SearchConfig {
  const strength = normalizeThinkingStrength(thinkingStrength);
  const empty = clampInt(emptyCells, 0, 16);

  let depth = strength <= 2
    ? 1
    : strength <= 4
      ? 2
      : strength <= 6
        ? 3
        : strength <= 8
          ? 4
          : 5;

  if (useDynamicDepth) {
    if (empty <= 2) depth += 2;
    else if (empty <= 4) depth += 1;
    else if (empty >= 10) depth -= 1;
  }

  return {
    depth: clampInt(depth, 1, 7),
    timeBudgetMs: strength >= 10 ? Number.POSITIVE_INFINITY : 45 + strength * strength * 6,
    chanceCellLimit: strength >= 9
      ? 16
      : strength <= 2
        ? 3
        : strength <= 4
          ? 4
          : strength <= 6
            ? 6
            : 8,
    riskWeight: 0.75 + strength * 0.08,
    worstCaseWeight: strength <= 3 ? 0.02 : strength <= 6 ? 0.06 : 0.1,
    cacheLimit: 8000 + strength * 5000,
    heuristicPreset,
  };
}

export function selectChanceCellsForSearch(
  board: NumBoard,
  config: SearchConfig,
  preferredCorner: Corner = choosePreferredCorner(board)
): Array<[number, number]> {
  const empty = getEmptyCells(board);
  const ranked = empty
    .map(([row, col]) => {
      const board2 = spawnOnBoard(board, row, col, 2);
      const board4 = spawnOnBoard(board, row, col, 4);
      const score = Math.min(
        evaluate(board2, {
          preferredCorner,
          riskWeight: config.riskWeight,
          preset: config.heuristicPreset,
        }),
        evaluate(board4, {
          preferredCorner,
          riskWeight: config.riskWeight,
          preset: config.heuristicPreset,
        })
      );
      return { row, col, score };
    })
    .sort((a, b) => a.score - b.score || a.row - b.row || a.col - b.col);

  return ranked
    .slice(0, Math.min(config.chanceCellLimit, ranked.length))
    .map(({ row, col }) => [row, col]);
}

export function findBestMoveForBoard(
  board: NumBoard,
  options: FindBestMoveOptions = {}
): SearchDecision | null {
  const config = resolveSearchConfig(board, options);
  const preferredCorner = choosePreferredCorner(board);
  const context: SearchContext = {
    config,
    preferredCorner,
    startTime: performance.now(),
    cache: new Map(),
    metrics: {
      nodes: 0,
      cacheHits: 0,
      cacheMisses: 0,
      chanceNodes: 0,
      durationMs: 0,
      timedOut: false,
    },
  };

  let bestCompleted: SearchDecision | null = null;

  for (let depth = 1; depth <= config.depth; depth++) {
    try {
      bestCompleted = evaluateRootMoves(board, depth, context);
    } catch (error) {
      if (error instanceof SearchTimeout) break;
      throw error;
    }
  }

  const decision = bestCompleted ?? evaluateImmediateMoves(board, config, preferredCorner);
  if (!decision) return null;

  decision.metrics = {
    ...context.metrics,
    durationMs: performance.now() - context.startTime,
    timedOut: context.metrics.timedOut,
  };
  return decision;
}

export class AutoPlayer {
  private readonly game: Game;
  private options: AutoPlayerOptions;
  private status: AutoPlayerStatus;

  /** Running loop handle - null when stopped. */
  private loopHandle: ReturnType<typeof setTimeout> | null = null;
  private running: boolean = false;
  private paused: boolean = false;

  private onStatusChangeCallback: (() => void) | null = null;

  constructor(game: Game, options?: Partial<AutoPlayerOptions>) {
    this.game = game;

    const thinkingStrength = normalizeThinkingStrength(
      options?.thinkingStrength ?? strengthFromDepth(options?.maxDepth ?? 4)
    );
    const initialConfig = deriveSearchConfig(
      thinkingStrength,
      8,
      options?.useDynamicDepth ?? true,
      options?.heuristicPreset ?? DEFAULT_PRESET
    );

    this.options = {
      delayMs: options?.delayMs ?? 300,
      maxDepth: options?.maxDepth ?? initialConfig.depth,
      useDynamicDepth: options?.useDynamicDepth ?? true,
      timeBudgetMs: options?.timeBudgetMs ?? initialConfig.timeBudgetMs,
      thinkingStrength,
      heuristicPreset: options?.heuristicPreset ?? DEFAULT_PRESET,
    };
    this.status = this.defaultStatus();
  }

  // -- Public API -------------------------------------------------------------

  start(): void {
    if (this.running && !this.paused) return;

    const snapshot = this.game.getBoardSnapshot();
    if (snapshot.isGameOver) {
      this.status.message = "Game is over. Start a new game first.";
      this.notifyStatusChange();
      return;
    }

    this.running = true;
    this.paused = false;
    this.status.state = "running";
    this.status.message = "AutoPlayer running...";
    this.notifyStatusChange();

    this.scheduleNextStep();
  }

  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.status.state = "paused";
    this.status.message = "Paused.";
    this.cancelScheduled();
    this.notifyStatusChange();
  }

  stop(): void {
    this.running = false;
    this.paused = false;
    this.cancelScheduled();
    this.status = this.defaultStatus();
    this.status.state = "stopped";
    this.status.message = "Stopped.";
    this.notifyStatusChange();
  }

  async stepOnce(): Promise<void> {
    const snapshot = this.game.getBoardSnapshot();
    if (snapshot.isGameOver) {
      this.status.message = "Game is over.";
      this.notifyStatusChange();
      return;
    }

    this.status.state = "thinking";
    this.status.message = "Thinking...";
    this.notifyStatusChange();

    const result = await this.computeAndMove();

    if (result) {
      this.status.state = "paused";
      this.status.message = `Step: ${result.direction}`;
    } else {
      this.status.state = "idle";
      this.status.message = "No valid move found.";
    }
    this.notifyStatusChange();
  }

  setDelay(ms: number): void {
    this.options.delayMs = normalizeDelay(ms);
  }

  setThinkingStrength(value: number): void {
    const thinkingStrength = normalizeThinkingStrength(value);
    const config = deriveSearchConfig(
      thinkingStrength,
      8,
      this.options.useDynamicDepth,
      this.options.heuristicPreset
    );
    this.options.thinkingStrength = thinkingStrength;
    this.options.maxDepth = config.depth;
    this.options.timeBudgetMs = config.timeBudgetMs;
    this.status.thinkingStrength = thinkingStrength;
    this.notifyStatusChange();
  }

  setHeuristicPreset(preset: HeuristicPresetName): void {
    this.options.heuristicPreset = preset;
  }

  /** Compatibility for callers that still think in terms of max search depth. */
  setMaxDepth(depth: number): void {
    const normalizedDepth = clampInt(Math.round(depth), 1, 7);
    this.options.maxDepth = normalizedDepth;
    this.setThinkingStrength(strengthFromDepth(normalizedDepth));
  }

  isRunning(): boolean {
    return this.running && !this.paused;
  }

  getStatus(): AutoPlayerStatus {
    return {
      ...this.status,
      evaluatedMoves: this.status.evaluatedMoves.map((move) => ({ ...move })),
    };
  }

  onStatusChange(cb: () => void): void {
    this.onStatusChangeCallback = cb;
  }

  // -- Internal loop ----------------------------------------------------------

  private scheduleNextStep(): void {
    if (!this.running || this.paused) return;

    this.loopHandle = setTimeout(async () => {
      if (!this.running || this.paused) return;

      const snapshot = this.game.getBoardSnapshot();
      if (snapshot.isGameOver) {
        this.stop();
        this.status.message = "Game over - AutoPlayer stopped.";
        this.notifyStatusChange();
        return;
      }

      this.status.state = "thinking";
      this.notifyStatusChange();

      await this.computeAndMove();

      if (this.running && !this.paused) {
        this.scheduleNextStep();
      }
    }, this.options.delayMs);
  }

  private cancelScheduled(): void {
    if (this.loopHandle !== null) {
      clearTimeout(this.loopHandle);
      this.loopHandle = null;
    }
  }

  private async computeAndMove(): Promise<AutoPlayerResult | null> {
    const snapshot = this.game.getBoardSnapshot();
    if (snapshot.isGameOver) return null;

    const board = cellsToNumBoard(snapshot.cells);
    const search = findBestMoveForBoard(board, {
      thinkingStrength: this.options.thinkingStrength,
      useDynamicDepth: this.options.useDynamicDepth,
      maxDepth: this.options.maxDepth,
      timeBudgetMs: this.options.timeBudgetMs,
      heuristicPreset: this.options.heuristicPreset,
    });

    this.status.evaluatedMoves = search?.evaluatedMoves ?? [];
    this.status.lastDepth = search?.depth ?? null;
    this.status.lastScore = search?.bestScore ?? null;
    this.status.lastSearchMs = search?.metrics.durationMs ?? null;
    this.status.searchNodes = search?.metrics.nodes ?? 0;
    this.status.cacheHitRate = search
      ? hitRate(search.metrics.cacheHits, search.metrics.cacheMisses)
      : null;

    if (!search?.bestDirection) {
      this.status.message = "No valid moves.";
      this.notifyStatusChange();
      return null;
    }

    this.status.state = "running";
    this.status.lastDirection = search.bestDirection;
    this.status.message = `Moving: ${search.bestDirection}`;
    this.notifyStatusChange();

    // === The ONLY write operation ===
    // AutoPlayer calls requestMove - does not touch board internals.
    await this.game.requestMove(search.bestDirection, {
      animationDurationMs: this.options.delayMs,
    });

    this.status.steps++;

    return {
      direction: search.bestDirection,
      score: search.bestScore,
      depth: search.depth,
      evaluatedMoves: search.evaluatedMoves,
    };
  }

  // -- Helpers ----------------------------------------------------------------

  private defaultStatus(): AutoPlayerStatus {
    return {
      state: "idle",
      lastDirection: null,
      lastScore: null,
      lastDepth: null,
      steps: 0,
      evaluatedMoves: [],
      message: "Ready",
      thinkingStrength: this.options.thinkingStrength,
      lastSearchMs: null,
      searchNodes: 0,
      cacheHitRate: null,
    };
  }

  private notifyStatusChange(): void {
    this.onStatusChangeCallback?.();
  }
}

function resolveSearchConfig(
  board: NumBoard,
  options: FindBestMoveOptions
): SearchConfig {
  const useDynamicDepth = options.useDynamicDepth ?? true;
  const heuristicPreset = options.heuristicPreset ?? DEFAULT_PRESET;
  const config = deriveSearchConfig(
    options.thinkingStrength ?? DEFAULT_THINKING_STRENGTH,
    getEmptyCells(board).length,
    useDynamicDepth,
    heuristicPreset
  );

  return {
    ...config,
    depth: useDynamicDepth ? config.depth : clampInt(options.maxDepth ?? config.depth, 1, 7),
    timeBudgetMs: options.timeBudgetMs ?? config.timeBudgetMs,
  };
}

function evaluateRootMoves(
  board: NumBoard,
  depth: number,
  context: SearchContext
): SearchDecision {
  const evaluated = new Map<Direction, EvaluatedMove>();
  let bestDirection: Direction | null = null;
  let bestScore = -Infinity;

  for (const move of DIRECTIONS) {
    evaluated.set(move, { direction: move, score: -Infinity, valid: false });
  }

  for (const move of orderMoves(board, context.config, context.preferredCorner)) {
    checkTimeout(context);
    const score = move.score + expectimax(move.board, depth, true, context);
    evaluated.set(move.direction, { direction: move.direction, score, valid: true });

    if (score > bestScore) {
      bestScore = score;
      bestDirection = move.direction;
    }
  }

  return {
    bestDirection,
    bestScore,
    depth,
    evaluatedMoves: DIRECTIONS.map((direction) => evaluated.get(direction)!),
    metrics: { ...context.metrics },
  };
}

function evaluateImmediateMoves(
  board: NumBoard,
  config: SearchConfig,
  preferredCorner: Corner
): SearchDecision | null {
  const evaluated = new Map<Direction, EvaluatedMove>();
  let bestDirection: Direction | null = null;
  let bestScore = -Infinity;

  for (const direction of DIRECTIONS) {
    const result = simulateMove(board, direction);
    if (!result.moved) {
      evaluated.set(direction, { direction, score: -Infinity, valid: false });
      continue;
    }

    const score = result.score + evaluate(result.board, {
      preferredCorner,
      riskWeight: config.riskWeight,
      preset: config.heuristicPreset,
    });
    evaluated.set(direction, { direction, score, valid: true });
    if (score > bestScore) {
      bestScore = score;
      bestDirection = direction;
    }
  }

  if (!bestDirection) return null;
  return {
    bestDirection,
    bestScore,
    depth: 0,
    evaluatedMoves: DIRECTIONS.map((direction) => evaluated.get(direction)!),
    metrics: {
      nodes: 0,
      cacheHits: 0,
      cacheMisses: 0,
      chanceNodes: 0,
      durationMs: 0,
      timedOut: false,
    },
  };
}

function expectimax(
  board: NumBoard,
  depth: number,
  isChance: boolean,
  context: SearchContext
): number {
  checkTimeout(context);
  context.metrics.nodes++;

  const cacheKey = `${isChance ? "C" : "M"}|${depth}|${serializeBoard(board)}`;
  const cached = context.cache.get(cacheKey);
  if (cached !== undefined) {
    context.metrics.cacheHits++;
    return cached;
  }
  context.metrics.cacheMisses++;

  let value: number;
  if (depth <= 0 || isGameOver(board)) {
    value = evaluateBoard(board, context);
  } else if (isChance) {
    value = evaluateChanceNode(board, depth, context);
  } else {
    value = evaluateMaxNode(board, depth, context);
  }

  if (context.cache.size < context.config.cacheLimit) {
    context.cache.set(cacheKey, value);
  }
  return value;
}

function evaluateMaxNode(
  board: NumBoard,
  depth: number,
  context: SearchContext
): number {
  let best = -Infinity;

  for (const move of orderMoves(board, context.config, context.preferredCorner)) {
    checkTimeout(context);
    const score = move.score + expectimax(move.board, depth, true, context);
    if (score > best) best = score;
  }

  return best === -Infinity ? evaluateBoard(board, context) : best;
}

function evaluateChanceNode(
  board: NumBoard,
  depth: number,
  context: SearchContext
): number {
  context.metrics.chanceNodes++;
  const cells = selectChanceCellsForSearch(
    board,
    context.config,
    context.preferredCorner
  );
  if (cells.length === 0) return evaluateBoard(board, context);

  let total = 0;
  let worst = Infinity;

  for (const [row, col] of cells) {
    checkTimeout(context);

    const score2 = expectimax(
      spawnOnBoard(board, row, col, 2),
      depth - 1,
      false,
      context
    );
    const score4 = expectimax(
      spawnOnBoard(board, row, col, 4),
      depth - 1,
      false,
      context
    );
    const expected = PROB_2 * score2 + PROB_4 * score4;

    total += expected;
    worst = Math.min(worst, expected);
  }

  const expectedAverage = total / cells.length;
  return (
    expectedAverage * (1 - context.config.worstCaseWeight) +
    worst * context.config.worstCaseWeight
  );
}

function orderMoves(
  board: NumBoard,
  config: SearchConfig,
  preferredCorner: Corner
): OrderedMove[] {
  return DIRECTIONS.map((direction) => {
    const result = simulateMove(board, direction);
    if (!result.moved) return null;

    const priority =
      result.score * 4 +
      getEmptyCells(result.board).length * 220 +
      evaluate(result.board, {
        preferredCorner,
        riskWeight: config.riskWeight,
        preset: config.heuristicPreset,
      }) * 0.02;

    return {
      direction,
      board: result.board,
      score: result.score,
      priority,
    };
  })
    .filter((move): move is OrderedMove => move !== null)
    .sort((a, b) => b.priority - a.priority);
}

function evaluateBoard(board: NumBoard, context: SearchContext): number {
  return evaluate(board, {
    preferredCorner: context.preferredCorner,
    riskWeight: context.config.riskWeight,
    preset: context.config.heuristicPreset,
  });
}

function checkTimeout(context: SearchContext): void {
  if (!Number.isFinite(context.config.timeBudgetMs)) return;
  if (performance.now() - context.startTime > context.config.timeBudgetMs) {
    context.metrics.timedOut = true;
    throw new SearchTimeout();
  }
}

function hitRate(cacheHits: number, cacheMisses: number): number {
  const total = cacheHits + cacheMisses;
  return total === 0 ? 0 : cacheHits / total;
}

function strengthFromDepth(depth: number): number {
  const normalizedDepth = clampInt(Math.round(depth), 1, 7);
  return clampInt(Math.round(((normalizedDepth - 1) / 6) * 9 + 1), 1, 10);
}

function serializeBoard(board: NumBoard): string {
  return board.map((row) => row.join(",")).join(";");
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeDelay(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.round(ms));
}
