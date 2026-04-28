// src/game/Game.ts
// Core game logic. The real board (Tile objects) is private.
// AutoPlayer can only interact via requestMove(direction) and getBoardSnapshot().

import type {
  Direction,
  Tile,
  BoardSnapshot,
  MoveResult,
  MovedTileInfo,
  MergedTileInfo,
} from "../types";
import {
  applyMove,
  canMoveAny,
  getEmptyCells,
  boardToMatrix,
  type Board,
} from "./moveLogic";

const BEST_SCORE_KEY = "2048_best_score";
const WIN_TILE = 2048;
const SPAWN_4_PROBABILITY = 0.1;

/** Generates a unique tile ID. */
let tileCounter = 0;
function newTileId(): string {
  return `t_${++tileCounter}`;
}

export class Game {
  private readonly size: number;
  /** The true game board — private to prevent AutoPlayer access. */
  private board: Board;
  private score: number = 0;
  private bestScore: number = 0;
  private hasWon: boolean = false;
  private isGameOver: boolean = false;
  private continueAfterWinFlag: boolean = false;
  private steps: number = 0;

  /** Pending move lock — prevents concurrent moves. */
  private moveLock: boolean = false;

  private stateChangeCallbacks: Array<() => void> = [];
  private moveStartCallbacks: Array<(result: MoveResult) => void> = [];
  private moveEndCallbacks: Array<(result: MoveResult) => void> = [];

  constructor(size: number = 4) {
    this.size = size;
    this.board = this.createEmptyBoard();
    this.bestScore = this.loadBestScore();
    this.startNewGame();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  startNewGame(): void {
    this.board = this.createEmptyBoard();
    this.score = 0;
    this.hasWon = false;
    this.isGameOver = false;
    this.continueAfterWinFlag = false;
    this.steps = 0;
    this.moveLock = false;

    this.spawnTile();
    this.spawnTile();

    this.notifyStateChange();
  }

  /**
   * The only entry point for moving tiles.
   * Human input and AutoPlayer both call this.
   * Resolves after both the move logic and animation are complete.
   */
  async requestMove(direction: Direction): Promise<MoveResult> {
    // Snapshot before move
    const previousSnapshot = this.getBoardSnapshot();

    // Guard: no move if game over or lock held
    if (this.isGameOver || this.moveLock) {
      return this.buildNoopResult(direction, previousSnapshot);
    }

    this.moveLock = true;

    const result = this.executeMove(direction, previousSnapshot);

    if (result.moved) {
      this.steps++;
    }

    // Notify move start (for animation)
    this.moveStartCallbacks.forEach((cb) => cb(result));

    // Wait for animation to complete
    await this.waitForAnimation(result);

    // Spawn a new tile if the move was valid
    if (result.moved) {
      const spawned = this.spawnTile();
      if (spawned) {
        result.spawnedTile = { ...spawned };
      }
    }

    // Update game-over / win state
    this.checkWinAndGameOver();

    const nextSnapshot = this.getBoardSnapshot();
    result.nextBoardSnapshot = nextSnapshot;

    this.moveLock = false;

    // Notify move end (for animation completion and re-render)
    this.moveEndCallbacks.forEach((cb) => cb(result));
    this.notifyStateChange();

    return result;
  }

  /** Returns a deep-copy snapshot of the board state. AutoPlayer only gets this. */
  getBoardSnapshot(): BoardSnapshot {
    return {
      size: this.size,
      cells: boardToMatrix(this.board),
      tiles: this.board.flatMap((row) =>
        row.filter((t): t is Tile => t !== null).map((t) => ({ ...t }))
      ),
      score: this.score,
      bestScore: this.bestScore,
      maxTile: this.getMaxTile(),
      isGameOver: this.isGameOver,
      hasWon: this.hasWon,
    };
  }

  canMove(direction?: Direction): boolean {
    if (this.isGameOver) return false;
    if (direction) {
      const result = applyMove(this.board, direction, () => "check");
      return result.moved;
    }
    return canMoveAny(this.board);
  }

  continueAfterWin(): void {
    if (this.hasWon) {
      this.continueAfterWinFlag = true;
      this.notifyStateChange();
    }
  }

  getSteps(): number {
    return this.steps;
  }

  onStateChange(callback: () => void): void {
    this.stateChangeCallbacks.push(callback);
  }

  onMoveStart(callback: (result: MoveResult) => void): void {
    this.moveStartCallbacks.push(callback);
  }

  onMoveEnd(callback: (result: MoveResult) => void): void {
    this.moveEndCallbacks.push(callback);
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private createEmptyBoard(): Board {
    return Array.from({ length: this.size }, () =>
      Array.from({ length: this.size }, () => null)
    );
  }

  private executeMove(
    direction: Direction,
    previousSnapshot: BoardSnapshot
  ): MoveResult {
    const applyResult = applyMove(this.board, direction, newTileId);

    if (applyResult.moved) {
      this.board = applyResult.board;
      this.score += applyResult.scoreGained;

      if (this.score > this.bestScore) {
        this.bestScore = this.score;
        this.saveBestScore(this.bestScore);
      }
    }

    return {
      direction,
      moved: applyResult.moved,
      scoreGained: applyResult.scoreGained,
      movedTiles: applyResult.movedTiles,
      mergedTiles: applyResult.mergedTiles,
      spawnedTile: null,
      previousBoardSnapshot: previousSnapshot,
      nextBoardSnapshot: previousSnapshot, // updated after spawn
    };
  }

  /** Spawn a new tile at a random empty cell. Returns the spawned tile or null. */
  private spawnTile(): Tile | null {
    const empty = getEmptyCells(this.board);
    if (empty.length === 0) return null;

    const [row, col] = empty[Math.floor(Math.random() * empty.length)];
    const value = Math.random() < SPAWN_4_PROBABILITY ? 4 : 2;

    const tile: Tile = {
      id: newTileId(),
      value,
      row,
      col,
      isNew: true,
    };

    this.board[row][col] = tile;
    return tile;
  }

  private checkWinAndGameOver(): void {
    const maxTile = this.getMaxTile();

    if (maxTile >= WIN_TILE && !this.hasWon && !this.continueAfterWinFlag) {
      this.hasWon = true;
    }

    if (!canMoveAny(this.board)) {
      this.isGameOver = true;
    }
  }

  private getMaxTile(): number {
    let max = 0;
    for (const row of this.board) {
      for (const tile of row) {
        if (tile && tile.value > max) max = tile.value;
      }
    }
    return max;
  }

  /** Wait for the animation duration. Renderer sets this value on Game. */
  private animationDurationMs: number = 150;

  setAnimationDuration(ms: number): void {
    this.animationDurationMs = ms;
  }

  private waitForAnimation(_result: MoveResult): Promise<void> {
    if (!_result.moved) return Promise.resolve();
    return new Promise((resolve) =>
      setTimeout(resolve, this.animationDurationMs)
    );
  }

  private buildNoopResult(
    direction: Direction,
    snapshot: BoardSnapshot
  ): MoveResult {
    return {
      direction,
      moved: false,
      scoreGained: 0,
      movedTiles: [],
      mergedTiles: [],
      spawnedTile: null,
      previousBoardSnapshot: snapshot,
      nextBoardSnapshot: snapshot,
    };
  }

  private notifyStateChange(): void {
    this.stateChangeCallbacks.forEach((cb) => cb());
  }

  private loadBestScore(): number {
    try {
      const stored = localStorage.getItem(BEST_SCORE_KEY);
      return stored ? parseInt(stored, 10) : 0;
    } catch {
      return 0;
    }
  }

  private saveBestScore(score: number): void {
    try {
      localStorage.setItem(BEST_SCORE_KEY, String(score));
    } catch {
      // localStorage may be unavailable in some environments
    }
  }

  // ── Type-safe move info helpers (used by tests/other consumers) ───────────

  /** For test visibility only — returns the raw board matrix values. */
  _getBoardValues(): Array<Array<number | null>> {
    return boardToMatrix(this.board);
  }

  _getMoveInfo(): { movedTiles: MovedTileInfo[]; mergedTiles: MergedTileInfo[] } {
    return { movedTiles: [], mergedTiles: [] };
  }
}
