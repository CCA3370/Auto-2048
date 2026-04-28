// src/autoplay/autoSimulator.ts
// Pure simulation utilities for the AutoPlayer.
// Uses number matrices (no Tile objects) for performance.
// IMPORTANT: These functions NEVER touch the real Game state.
// The AutoPlayer only reads BoardSnapshot from game.getBoardSnapshot() and
// writes back via game.requestMove(direction).

import type { Direction } from "../types";

export type NumBoard = Array<Array<number>>;

/** Deep-clone a number matrix. */
export function cloneNumBoard(board: NumBoard): NumBoard {
  return board.map((row) => [...row]);
}

/** Convert a BoardSnapshot's cells to a NumBoard (null → 0). */
export function cellsToNumBoard(
  cells: Array<Array<number | null>>
): NumBoard {
  return cells.map((row) => row.map((v) => v ?? 0));
}

/** Get all positions where value === 0. */
export function getEmptyCells(board: NumBoard): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  for (let r = 0; r < board.length; r++) {
    for (let c = 0; c < board[r].length; c++) {
      if (board[r][c] === 0) result.push([r, c]);
    }
  }
  return result;
}

/** Slide a single row left, returning new row and score gained. */
function slideLeft(row: number[]): { row: number[]; score: number } {
  const size = row.length;
  const tiles = row.filter((v) => v !== 0);
  const result: number[] = [];
  let score = 0;
  let i = 0;

  while (i < tiles.length) {
    if (i + 1 < tiles.length && tiles[i] === tiles[i + 1]) {
      const merged = tiles[i] * 2;
      result.push(merged);
      score += merged;
      i += 2;
    } else {
      result.push(tiles[i]);
      i++;
    }
  }

  while (result.length < size) result.push(0);
  return { row: result, score };
}

/** Simulate a move on a number board. Returns new board, score gained, and whether moved. */
export function simulateMove(
  board: NumBoard,
  direction: Direction
): { board: NumBoard; score: number; moved: boolean } {
  const size = board.length;
  let totalScore = 0;
  let moved = false;

  const newBoard = cloneNumBoard(board);

  if (direction === "left") {
    for (let r = 0; r < size; r++) {
      const { row: newRow, score } = slideLeft(newBoard[r]);
      if (newRow.some((v, i) => v !== newBoard[r][i])) moved = true;
      newBoard[r] = newRow;
      totalScore += score;
    }
  } else if (direction === "right") {
    for (let r = 0; r < size; r++) {
      const reversed = [...newBoard[r]].reverse();
      const { row: newRow, score } = slideLeft(reversed);
      const flipped = newRow.reverse();
      if (flipped.some((v, i) => v !== newBoard[r][i])) moved = true;
      newBoard[r] = flipped;
      totalScore += score;
    }
  } else if (direction === "up") {
    for (let c = 0; c < size; c++) {
      const col = newBoard.map((row) => row[c]);
      const { row: newCol, score } = slideLeft(col);
      if (newCol.some((v, i) => v !== newBoard[i][c])) moved = true;
      newCol.forEach((v, r) => { newBoard[r][c] = v; });
      totalScore += score;
    }
  } else {
    // down
    for (let c = 0; c < size; c++) {
      const col = newBoard.map((row) => row[c]).reverse();
      const { row: newCol, score } = slideLeft(col);
      const flipped = newCol.reverse();
      if (flipped.some((v, i) => v !== newBoard[i][c])) moved = true;
      flipped.forEach((v, r) => { newBoard[r][c] = v; });
      totalScore += score;
    }
  }

  return { board: newBoard, score: totalScore, moved };
}

/** Check if any move is possible on a number board. */
export function canMove(board: NumBoard): boolean {
  for (const dir of ["up", "down", "left", "right"] as Direction[]) {
    if (simulateMove(board, dir).moved) return true;
  }
  return false;
}

/** Check if the game is over for a number board. */
export function isGameOver(board: NumBoard): boolean {
  return !canMove(board);
}

/** Spawn a tile on a copy of the board. Does NOT mutate the original. */
export function spawnOnBoard(
  board: NumBoard,
  row: number,
  col: number,
  value: number
): NumBoard {
  const next = cloneNumBoard(board);
  next[row][col] = value;
  return next;
}
