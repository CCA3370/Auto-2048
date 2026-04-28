// src/tests/moveLogic.test.ts
// Tests for the core move logic.
// Uses Vitest. No DOM dependency.

import { describe, it, expect } from "vitest";
import {
  applyMove,
  canMove,
  canMoveAny,
  getEmptyCells,
  type Board,
} from "../game/moveLogic";
import { simulateMove, cellsToNumBoard, isGameOver } from "../autoplay/autoSimulator";
import type { Tile } from "../types";

// ── Helpers ──────────────────────────────────────────────────────────────────

let idCounter = 0;
function mkId(): string {
  return `t${++idCounter}`;
}

/** Build a Board from a 4x4 number matrix (0 = empty). */
function makeBoard(matrix: number[][]): Board {
  return matrix.map((row, r) =>
    row.map((v, c): Tile | null =>
      v === 0 ? null : { id: mkId(), value: v, row: r, col: c }
    )
  );
}

/** Extract just the values from a Board into a matrix. */
function boardValues(board: Board): (number | null)[][] {
  return board.map((row) => row.map((t) => (t ? t.value : null)));
}

// ── Row sliding tests ─────────────────────────────────────────────────────────

describe("Move logic: left slide", () => {
  it("[2, 2, 2, 0] left => [4, 2, 0, 0]", () => {
    const board = makeBoard([[2, 2, 2, 0], [0,0,0,0], [0,0,0,0], [0,0,0,0]]);
    const { board: newBoard, moved } = applyMove(board, "left", mkId);
    expect(moved).toBe(true);
    expect(boardValues(newBoard)[0]).toEqual([4, 2, null, null]);
  });

  it("[2, 2, 2, 2] left => [4, 4, 0, 0]", () => {
    const board = makeBoard([[2, 2, 2, 2], [0,0,0,0], [0,0,0,0], [0,0,0,0]]);
    const { board: newBoard } = applyMove(board, "left", mkId);
    expect(boardValues(newBoard)[0]).toEqual([4, 4, null, null]);
  });

  it("[4, 4, 4, 0] left => [8, 4, 0, 0]", () => {
    const board = makeBoard([[4, 4, 4, 0], [0,0,0,0], [0,0,0,0], [0,0,0,0]]);
    const { board: newBoard } = applyMove(board, "left", mkId);
    expect(boardValues(newBoard)[0]).toEqual([8, 4, null, null]);
  });

  it("[2, 0, 2, 4] left => [4, 4, 0, 0]", () => {
    const board = makeBoard([[2, 0, 2, 4], [0,0,0,0], [0,0,0,0], [0,0,0,0]]);
    const { board: newBoard } = applyMove(board, "left", mkId);
    expect(boardValues(newBoard)[0]).toEqual([4, 4, null, null]);
  });

  it("[0, 0, 0, 0] left => invalid move", () => {
    const board = makeBoard([[0, 0, 0, 0], [0,0,0,0], [0,0,0,0], [0,0,0,0]]);
    const { moved } = applyMove(board, "left", mkId);
    expect(moved).toBe(false);
  });
});

describe("Move logic: right slide", () => {
  it("[2, 2, 0, 0] right => [0, 0, 0, 4]", () => {
    const board = makeBoard([[2, 2, 0, 0], [0,0,0,0], [0,0,0,0], [0,0,0,0]]);
    const { board: newBoard } = applyMove(board, "right", mkId);
    expect(boardValues(newBoard)[0]).toEqual([null, null, null, 4]);
  });

  it("[2, 2, 2, 2] right => [0, 0, 4, 4]", () => {
    const board = makeBoard([[2, 2, 2, 2], [0,0,0,0], [0,0,0,0], [0,0,0,0]]);
    const { board: newBoard } = applyMove(board, "right", mkId);
    expect(boardValues(newBoard)[0]).toEqual([null, null, 4, 4]);
  });
});

describe("Move logic: up slide", () => {
  it("Column [2, 2, 0, 0] up => [4, 0, 0, 0]", () => {
    const board = makeBoard([
      [2, 0, 0, 0],
      [2, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    const { board: newBoard } = applyMove(board, "up", mkId);
    // Column 0 should be [4, 0, 0, 0]
    expect(newBoard[0][0]?.value).toBe(4);
    expect(newBoard[1][0]).toBeNull();
  });
});

describe("Move logic: down slide", () => {
  it("Column [2, 2, 0, 0] down => [0, 0, 0, 4]", () => {
    const board = makeBoard([
      [2, 0, 0, 0],
      [2, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    const { board: newBoard } = applyMove(board, "down", mkId);
    expect(newBoard[3][0]?.value).toBe(4);
    expect(newBoard[0][0]).toBeNull();
  });
});

// ── Game-over detection ───────────────────────────────────────────────────────

describe("Game-over detection", () => {
  it("Full board with no merges is game over", () => {
    // Alternating pattern — no adjacent equal values
    const board = makeBoard([
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 2],
    ]);
    expect(canMoveAny(board)).toBe(false);
  });

  it("Full board with mergeable pair is NOT game over", () => {
    const board = makeBoard([
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 2, 2], // last row has adjacent 2s
    ]);
    expect(canMoveAny(board)).toBe(true);
  });
});

// ── Valid/invalid moves ───────────────────────────────────────────────────────

describe("Valid vs invalid moves", () => {
  it("Left move on already-left board is invalid", () => {
    const board = makeBoard([
      [4, 0, 0, 0],
      [2, 0, 0, 0],
      [8, 0, 0, 0],
      [16, 0, 0, 0],
    ]);
    expect(canMove(board, "left")).toBe(false);
  });

  it("Right move on already-right board is invalid", () => {
    const board = makeBoard([
      [0, 0, 0, 4],
      [0, 0, 0, 2],
      [0, 0, 0, 8],
      [0, 0, 0, 16],
    ]);
    expect(canMove(board, "right")).toBe(false);
  });

  it("Moving a board with a gap is valid", () => {
    const board = makeBoard([
      [0, 0, 4, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    expect(canMove(board, "left")).toBe(true);
  });
});

// ── Score tracking ────────────────────────────────────────────────────────────

describe("Score tracking", () => {
  it("Merging two 2s scores 4", () => {
    const board = makeBoard([[2, 2, 0, 0], [0,0,0,0], [0,0,0,0], [0,0,0,0]]);
    const result = applyMove(board, "left", mkId);
    expect(result.scoreGained).toBe(4);
  });

  it("Merging four 2s scores 8 (two merges)", () => {
    const board = makeBoard([[2, 2, 2, 2], [0,0,0,0], [0,0,0,0], [0,0,0,0]]);
    const result = applyMove(board, "left", mkId);
    expect(result.scoreGained).toBe(8);
  });
});

// ── Empty cells ───────────────────────────────────────────────────────────────

describe("getEmptyCells", () => {
  it("Returns correct empty positions", () => {
    const board = makeBoard([
      [2, 0, 4, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 8],
    ]);
    const empty = getEmptyCells(board);
    // Total 16 - 3 tiles = 13 empty cells
    expect(empty.length).toBe(13);
    // [0][1] is empty
    expect(empty.some(([r, c]) => r === 0 && c === 1)).toBe(true);
  });
});

// ── AutoSimulator tests ───────────────────────────────────────────────────────

describe("autoSimulator", () => {
  it("simulateMove left works correctly", () => {
    const cells = [
      [2, 2, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    const board = cellsToNumBoard(cells);
    const { board: newBoard, moved, score } = simulateMove(board, "left");
    expect(moved).toBe(true);
    expect(newBoard[0][0]).toBe(4);
    expect(newBoard[0][1]).toBe(0);
    expect(score).toBe(4);
  });

  it("simulateMove on empty row is invalid", () => {
    const board = cellsToNumBoard([
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    const { moved } = simulateMove(board, "left");
    expect(moved).toBe(false);
  });

  it("isGameOver on full alternating board", () => {
    const board = cellsToNumBoard([
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 2],
    ]);
    expect(isGameOver(board)).toBe(true);
  });

  it("isGameOver is false when moves exist", () => {
    const board = cellsToNumBoard([
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 2, 2],
    ]);
    expect(isGameOver(board)).toBe(false);
  });
});

// ── Merge info tracking ───────────────────────────────────────────────────────

describe("Merge info", () => {
  it("Returns mergedTiles with correct info", () => {
    const board = makeBoard([[2, 2, 0, 0], [0,0,0,0], [0,0,0,0], [0,0,0,0]]);
    const result = applyMove(board, "left", mkId);
    expect(result.mergedTiles.length).toBe(1);
    expect(result.mergedTiles[0].value).toBe(4);
  });

  it("Returns movedTiles for non-merge moves", () => {
    const board = makeBoard([[0, 2, 0, 0], [0,0,0,0], [0,0,0,0], [0,0,0,0]]);
    const result = applyMove(board, "left", mkId);
    expect(result.moved).toBe(true);
    // The tile at col 1 should move to col 0
    expect(result.movedTiles.some((t) => t.fromCol === 1 && t.toCol === 0)).toBe(true);
  });
});
