// src/game/moveLogic.ts
// Pure functions for 2048 move logic.
// These functions are used by both the real Game class and the AutoPlayer simulator.

import type { Direction, Tile, MovedTileInfo, MergedTileInfo } from "../types";

export type Board = Array<Array<Tile | null>>;

/** Deep-clone a board (for snapshot purposes in the real game). */
export function cloneBoard(board: Board): Board {
  return board.map((row) => row.map((tile) => (tile ? { ...tile } : null)));
}

/** Extract a 2D number matrix from a Board (for display / heuristic). */
export function boardToMatrix(board: Board): Array<Array<number | null>> {
  return board.map((row) => row.map((tile) => (tile ? tile.value : null)));
}

/**
 * Apply a move on a single row (left direction).
 * Returns the new row and information about moved/merged tiles.
 */
function slideRowLeft(
  row: (Tile | null)[],
  idGen: () => string
): {
  resultRow: (Tile | null)[];
  movedTiles: MovedTileInfo[];
  mergedTiles: MergedTileInfo[];
  scoreGained: number;
} {
  const movedTiles: MovedTileInfo[] = [];
  const mergedTiles: MergedTileInfo[] = [];
  let scoreGained = 0;

  // Collect non-null tiles in order
  const tiles = row.filter((t): t is Tile => t !== null);
  const resultRow: (Tile | null)[] = [null, null, null, null];

  let writeIdx = 0;
  let readIdx = 0;

  while (readIdx < tiles.length) {
    const current = tiles[readIdx];

    // Check if we can merge with next
    if (
      readIdx + 1 < tiles.length &&
      tiles[readIdx + 1].value === current.value
    ) {
      const next = tiles[readIdx + 1];
      const mergedValue = current.value * 2;
      scoreGained += mergedValue;

      const mergedId = idGen();
      const mergedTile: Tile = {
        id: mergedId,
        value: mergedValue,
        row: current.row, // will be updated by caller
        col: writeIdx,
        mergedFrom: [current.id, next.id],
        isNew: false,
      };

      mergedTiles.push({
        resultId: mergedId,
        sourceIds: [current.id, next.id],
        row: current.row,
        col: writeIdx,
        value: mergedValue,
      });

      // Record moves for both source tiles
      movedTiles.push({
        id: current.id,
        fromRow: current.row,
        fromCol: current.col,
        toRow: current.row,
        toCol: writeIdx,
        value: current.value,
      });
      movedTiles.push({
        id: next.id,
        fromRow: next.row,
        fromCol: next.col,
        toRow: next.row,
        toCol: writeIdx,
        value: next.value,
      });

      resultRow[writeIdx] = mergedTile;
      writeIdx++;
      readIdx += 2;
    } else {
      // Just slide
      if (current.col !== writeIdx) {
        movedTiles.push({
          id: current.id,
          fromRow: current.row,
          fromCol: current.col,
          toRow: current.row,
          toCol: writeIdx,
          value: current.value,
        });
      }
      resultRow[writeIdx] = { ...current, col: writeIdx };
      writeIdx++;
      readIdx++;
    }
  }

  return { resultRow, movedTiles, mergedTiles, scoreGained };
}

export interface ApplyMoveResult {
  board: Board;
  moved: boolean;
  movedTiles: MovedTileInfo[];
  mergedTiles: MergedTileInfo[];
  scoreGained: number;
}

/**
 * Apply a move direction to a board.
 * Returns the new board state and move details.
 * This is a pure function — does NOT mutate the input board.
 */
export function applyMove(
  board: Board,
  direction: Direction,
  idGen: () => string
): ApplyMoveResult {
  const size = board.length;

  // We always process "left" and rotate the board conceptually
  // by transposing/reversing rows before and after.
  let workBoard = rotateBoard(board, direction);

  let moved = false;
  const allMovedTiles: MovedTileInfo[] = [];
  const allMergedTiles: MergedTileInfo[] = [];
  let totalScore = 0;

  const newBoard: Board = workBoard.map((row, rowIdx) => {
    const { resultRow, movedTiles, mergedTiles, scoreGained } = slideRowLeft(
      row,
      idGen
    );

    // Update row index to match current rotated coordinate
    resultRow.forEach((tile) => {
      if (tile) tile.row = rowIdx;
    });

    if (movedTiles.length > 0) moved = true;

    allMovedTiles.push(...movedTiles);
    allMergedTiles.push(...mergedTiles);
    totalScore += scoreGained;

    return resultRow;
  });

  // Rotate back
  const finalBoard = unrotateBoard(newBoard, direction, size);

  // Fix coordinates after unrotation
  // The unrotateBoard already sets correct row/col.
  // Re-check if anything actually moved by comparing positions
  // (moved flag may be set even if a tile didn't change position in some edge cases — recheck)
  if (moved) {
    // Transform coordinates back through unrotation
    transformMoveResults(allMovedTiles, allMergedTiles, direction, size);
  }

  return {
    board: finalBoard,
    moved,
    movedTiles: moved ? allMovedTiles : [],
    mergedTiles: moved ? allMergedTiles : [],
    scoreGained: totalScore,
  };
}

/**
 * Rotate board so that moving "left" simulates the given direction.
 * Returns a new board with updated tile coordinates.
 */
function rotateBoard(board: Board, direction: Direction): Board {
  const size = board.length;

  if (direction === "left") return board.map((row) => [...row]);

  if (direction === "right") {
    return board.map((row, r) =>
      [...row].reverse().map((tile, c) =>
        tile ? { ...tile, row: r, col: c } : null
      )
    );
  }

  if (direction === "up") {
    // Transpose
    return Array.from({ length: size }, (_, r) =>
      Array.from({ length: size }, (_, c) => {
        const tile = board[c][r];
        return tile ? { ...tile, row: r, col: c } : null;
      })
    );
  }

  // direction === "down"
  // Transpose then reverse each row, equivalent to transpose + mirror
  return Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => {
      const tile = board[size - 1 - c][r];
      return tile ? { ...tile, row: r, col: c } : null;
    })
  );
}

/** Rotate board back after processing. */
function unrotateBoard(board: Board, direction: Direction, size: number): Board {
  if (direction === "left") return board.map((row) => [...row]);

  if (direction === "right") {
    return board.map((row, r) =>
      [...row].reverse().map((tile, c) =>
        tile ? { ...tile, row: r, col: c } : null
      )
    );
  }

  if (direction === "up") {
    // Transpose again
    return Array.from({ length: size }, (_, r) =>
      Array.from({ length: size }, (_, c) => {
        const tile = board[c][r];
        return tile ? { ...tile, row: r, col: c } : null;
      })
    );
  }

  // down: reverse unrotate — apply transpose then reverse
  return Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => {
      const tile = board[c][size - 1 - r];
      return tile ? { ...tile, row: r, col: c } : null;
    })
  );
}

/**
 * Transform moved/merged tile coordinates back through the unrotation.
 * The movedTiles and mergedTiles currently have rotated coordinates.
 * We need to convert them back to real board coordinates.
 */
function transformMoveResults(
  movedTiles: MovedTileInfo[],
  mergedTiles: MergedTileInfo[],
  direction: Direction,
  size: number
): void {
  const transform = getCoordTransform(direction, size);

  for (const t of movedTiles) {
    const [fr, fc] = transform(t.fromRow, t.fromCol);
    const [tr, tc] = transform(t.toRow, t.toCol);
    t.fromRow = fr;
    t.fromCol = fc;
    t.toRow = tr;
    t.toCol = tc;
  }

  for (const m of mergedTiles) {
    const [r, c] = transform(m.row, m.col);
    m.row = r;
    m.col = c;
  }
}

/** Returns a function that transforms rotated coordinates back to real coordinates. */
function getCoordTransform(
  direction: Direction,
  size: number
): (r: number, c: number) => [number, number] {
  if (direction === "left") return (r, c) => [r, c];
  if (direction === "right") return (r, c) => [r, size - 1 - c];
  if (direction === "up") return (r, c) => [c, r];
  // down
  return (r, c) => [size - 1 - c, r];
}

/** Check if a move is valid (any tile would move or merge). */
export function canMove(board: Board, direction: Direction): boolean {
  const result = applyMove(board, direction, () => "test");
  return result.moved;
}

/** Check if any direction can be moved. */
export function canMoveAny(board: Board): boolean {
  return (
    canMove(board, "up") ||
    canMove(board, "down") ||
    canMove(board, "left") ||
    canMove(board, "right")
  );
}

/** Get all empty positions on the board. */
export function getEmptyCells(board: Board): Array<[number, number]> {
  const empty: Array<[number, number]> = [];
  for (let r = 0; r < board.length; r++) {
    for (let c = 0; c < board[r].length; c++) {
      if (!board[r][c]) empty.push([r, c]);
    }
  }
  return empty;
}
