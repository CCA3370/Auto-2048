// src/autoplay/AutoPlayer.ts
// AutoPlayer using Expectimax algorithm.
//
// === CHEAT-PREVENTION BOUNDARY ===
// The AutoPlayer ONLY interacts with the game through:
//   1. game.getBoardSnapshot()  — read-only deep copy
//   2. game.requestMove(direction) — the only write channel
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
  type NumBoard,
} from "./autoSimulator";
import { evaluate } from "./heuristic";

const DIRECTIONS: Direction[] = ["up", "down", "left", "right"];

// Probability of spawning 2 vs 4
const PROB_2 = 0.9;
const PROB_4 = 0.1;

export class AutoPlayer {
  private readonly game: Game;
  private options: AutoPlayerOptions;
  private status: AutoPlayerStatus;

  /** Running loop handle — null when stopped. */
  private loopHandle: ReturnType<typeof setTimeout> | null = null;
  private running: boolean = false;
  private paused: boolean = false;

  private onStatusChangeCallback: (() => void) | null = null;

  constructor(game: Game, options?: Partial<AutoPlayerOptions>) {
    this.game = game;
    this.options = {
      delayMs: options?.delayMs ?? 300,
      maxDepth: options?.maxDepth ?? 4,
      useDynamicDepth: options?.useDynamicDepth ?? true,
      timeBudgetMs: options?.timeBudgetMs ?? 200,
    };
    this.status = this.defaultStatus();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

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
    this.status.message = "AutoPlayer running…";
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
    this.status.message = "Thinking…";
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
    this.options.delayMs = ms;
  }

  setMaxDepth(depth: number): void {
    this.options.maxDepth = depth;
  }

  isRunning(): boolean {
    return this.running && !this.paused;
  }

  getStatus(): AutoPlayerStatus {
    return { ...this.status };
  }

  onStatusChange(cb: () => void): void {
    this.onStatusChangeCallback = cb;
  }

  // ── Internal loop ───────────────────────────────────────────────────────────

  private scheduleNextStep(): void {
    if (!this.running || this.paused) return;

    this.loopHandle = setTimeout(async () => {
      if (!this.running || this.paused) return;

      const snapshot = this.game.getBoardSnapshot();
      if (snapshot.isGameOver) {
        this.stop();
        this.status.message = "Game over — AutoPlayer stopped.";
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
    const depth = this.selectDepth(board);

    const startTime = performance.now();
    const evaluatedMoves: EvaluatedMove[] = [];
    let bestDirection: Direction | null = null;
    let bestScore = -Infinity;

    for (const dir of DIRECTIONS) {
      const { board: newBoard, moved } = simulateMove(board, dir);
      if (!moved) {
        evaluatedMoves.push({ direction: dir, score: -Infinity, valid: false });
        continue;
      }

      const score = this.expectimax(
        newBoard,
        depth - 1,
        false,
        startTime,
        this.options.timeBudgetMs
      );

      evaluatedMoves.push({ direction: dir, score, valid: true });

      if (score > bestScore) {
        bestScore = score;
        bestDirection = dir;
      }
    }

    this.status.evaluatedMoves = evaluatedMoves;
    this.status.lastDepth = depth;
    this.status.lastScore = bestScore;

    if (!bestDirection) {
      // No valid moves — game should be over
      this.status.message = "No valid moves.";
      this.notifyStatusChange();
      return null;
    }

    this.status.state = "running";
    this.status.lastDirection = bestDirection;
    this.status.message = `Moving: ${bestDirection}`;
    this.notifyStatusChange();

    // === The ONLY write operation ===
    // AutoPlayer calls requestMove — does not touch board internals.
    await this.game.requestMove(bestDirection);

    this.status.steps++;

    const result: AutoPlayerResult = {
      direction: bestDirection,
      score: bestScore,
      depth,
      evaluatedMoves,
    };

    return result;
  }

  // ── Expectimax algorithm ────────────────────────────────────────────────────

  /**
   * Expectimax search.
   * isChance = true: chance node (tile spawns).
   * isChance = false: max node (player move).
   */
  private expectimax(
    board: NumBoard,
    depth: number,
    isChance: boolean,
    startTime: number,
    timeBudget: number
  ): number {
    // Timeout guard
    if (performance.now() - startTime > timeBudget) {
      return evaluate(board);
    }

    if (depth === 0 || isGameOver(board)) {
      return evaluate(board);
    }

    if (!isChance) {
      // Max node — choose best direction
      let best = -Infinity;

      for (const dir of DIRECTIONS) {
        const { board: newBoard, moved } = simulateMove(board, dir);
        if (!moved) continue;

        const score = this.expectimax(
          newBoard,
          depth - 1,
          true,
          startTime,
          timeBudget
        );
        if (score > best) best = score;
      }

      return best === -Infinity ? evaluate(board) : best;
    } else {
      // Chance node — weighted average over all possible tile spawns
      const empty = getEmptyCells(board);
      if (empty.length === 0) return evaluate(board);

      // Limit chance node branching for performance
      const sampledCells = empty.length > 6
        ? sampleCells(empty, 6)
        : empty;

      let total = 0;

      for (const [r, c] of sampledCells) {
        // Spawn 2
        const board2 = board.map((row) => [...row]);
        board2[r][c] = 2;
        const score2 = this.expectimax(
          board2,
          depth - 1,
          false,
          startTime,
          timeBudget
        );

        // Spawn 4
        const board4 = board.map((row) => [...row]);
        board4[r][c] = 4;
        const score4 = this.expectimax(
          board4,
          depth - 1,
          false,
          startTime,
          timeBudget
        );

        total += PROB_2 * score2 + PROB_4 * score4;
      }

      return total / sampledCells.length;
    }
  }

  // ── Dynamic depth selection ─────────────────────────────────────────────────

  private selectDepth(board: NumBoard): number {
    if (!this.options.useDynamicDepth) return this.options.maxDepth;

    let empty = 0;
    for (const row of board) {
      for (const v of row) {
        if (v === 0) empty++;
      }
    }

    // Fewer empty cells → deeper search (board is tight, critical decisions)
    if (empty <= 2) return Math.min(this.options.maxDepth + 2, 6);
    if (empty <= 4) return Math.min(this.options.maxDepth + 1, 5);
    if (empty >= 10) return Math.max(this.options.maxDepth - 1, 2);

    return this.options.maxDepth;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private defaultStatus(): AutoPlayerStatus {
    return {
      state: "idle",
      lastDirection: null,
      lastScore: null,
      lastDepth: null,
      steps: 0,
      evaluatedMoves: [],
      message: "Ready",
    };
  }

  private notifyStatusChange(): void {
    this.onStatusChangeCallback?.();
  }
}

/** Randomly sample `n` cells from an array (without replacement). */
function sampleCells(
  cells: Array<[number, number]>,
  n: number
): Array<[number, number]> {
  const copy = [...cells];
  const result: Array<[number, number]> = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy.splice(idx, 1)[0]);
  }
  return result;
}
