// src/autoplay/heuristic.ts
// Comprehensive heuristic evaluation for the Expectimax AutoPlayer.
// Each component is individually commented for clarity.

import type { NumBoard } from "./autoSimulator";

// ── Snake-pattern weight matrix ──────────────────────────────────────────────
// Rewards keeping the largest tiles in a snake pattern (corner strategy).
// Higher values in top-left, winding down.
const SNAKE_WEIGHTS: number[][] = [
  [65536, 32768, 16384, 8192],
  [  512,  1024,  2048, 4096],
  [  256,   128,    64,   32],
  [    2,     4,     8,   16],
];

// Rotated variants of the snake matrix for all 4 corners
const SNAKE_VARIANTS: number[][][] = [];
function buildSnakeVariants(): void {
  function rotateMatrix(m: number[][]): number[][] {
    const n = m.length;
    return Array.from({ length: n }, (_, r) =>
      Array.from({ length: n }, (_, c) => m[n - 1 - c][r])
    );
  }
  function mirrorMatrix(m: number[][]): number[][] {
    return m.map((row) => [...row].reverse());
  }

  const variants = new Set<string>();
  let current = SNAKE_WEIGHTS;
  for (let i = 0; i < 4; i++) {
    const key = JSON.stringify(current);
    if (!variants.has(key)) {
      variants.add(key);
      SNAKE_VARIANTS.push(current);
    }
    const mirrored = mirrorMatrix(current);
    const mirrorKey = JSON.stringify(mirrored);
    if (!variants.has(mirrorKey)) {
      variants.add(mirrorKey);
      SNAKE_VARIANTS.push(mirrored);
    }
    current = rotateMatrix(current);
  }
}
buildSnakeVariants();

// ── Individual heuristic components ─────────────────────────────────────────

/**
 * Empty cell bonus: more empty cells = more room to maneuver.
 * Weight: high — an empty board gives the most freedom.
 */
function emptyBonus(board: NumBoard): number {
  let count = 0;
  for (const row of board) {
    for (const v of row) {
      if (v === 0) count++;
    }
  }
  return count * 200;
}

/**
 * Max tile value: logarithmic score for the highest tile.
 */
function maxTileBonus(board: NumBoard): number {
  let max = 0;
  for (const row of board) {
    for (const v of row) {
      if (v > max) max = v;
    }
  }
  return max > 0 ? Math.log2(max) * 50 : 0;
}

/**
 * Corner bonus: reward when the max tile is in a corner.
 * This is critical for snake-pattern strategies.
 */
function cornerBonus(board: NumBoard): number {
  const size = board.length;
  let max = 0;
  for (const row of board) {
    for (const v of row) {
      if (v > max) max = v;
    }
  }

  const corners = [
    board[0][0],
    board[0][size - 1],
    board[size - 1][0],
    board[size - 1][size - 1],
  ];

  if (corners.includes(max)) {
    return max * 2;
  }
  return 0;
}

/**
 * Monotonicity: reward rows/columns that are monotonically increasing or decreasing.
 * Lower penalty = better score.
 */
function monotonicityScore(board: NumBoard): number {
  const size = board.length;
  let score = 0;

  for (let r = 0; r < size; r++) {
    let incScore = 0;
    let decScore = 0;
    for (let c = 0; c < size - 1; c++) {
      const a = board[r][c] > 0 ? Math.log2(board[r][c]) : 0;
      const b = board[r][c + 1] > 0 ? Math.log2(board[r][c + 1]) : 0;
      if (a > b) incScore += b - a;
      else decScore += a - b;
    }
    score += Math.max(incScore, decScore);
  }

  for (let c = 0; c < size; c++) {
    let incScore = 0;
    let decScore = 0;
    for (let r = 0; r < size - 1; r++) {
      const a = board[r][c] > 0 ? Math.log2(board[r][c]) : 0;
      const b = board[r + 1][c] > 0 ? Math.log2(board[r + 1][c]) : 0;
      if (a > b) incScore += b - a;
      else decScore += a - b;
    }
    score += Math.max(incScore, decScore);
  }

  return score * 25;
}

/**
 * Smoothness: penalize large differences between adjacent tiles.
 * Adjacent similar-valued tiles are easier to merge.
 */
function smoothnessScore(board: NumBoard): number {
  const size = board.length;
  let penalty = 0;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] === 0) continue;
      const logVal = Math.log2(board[r][c]);

      if (c + 1 < size && board[r][c + 1] !== 0) {
        penalty -= Math.abs(logVal - Math.log2(board[r][c + 1]));
      }
      if (r + 1 < size && board[r + 1][c] !== 0) {
        penalty -= Math.abs(logVal - Math.log2(board[r + 1][c]));
      }
    }
  }

  return penalty * 15;
}

/**
 * Merge potential: count pairs of identical adjacent tiles (potential merges).
 * More merges available = more scoring opportunities.
 */
function mergePotential(board: NumBoard): number {
  const size = board.length;
  let count = 0;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] === 0) continue;
      if (c + 1 < size && board[r][c] === board[r][c + 1]) count++;
      if (r + 1 < size && board[r][c] === board[r + 1][c]) count++;
    }
  }

  return count * 100;
}

/**
 * Snake weight matrix: reward board configurations that match the
 * snake pattern (keeping largest values along a snake path from a corner).
 */
function snakeWeight(board: NumBoard): number {
  const size = board.length;
  let best = -Infinity;

  for (const weights of SNAKE_VARIANTS) {
    let score = 0;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        score += board[r][c] * weights[r][c];
      }
    }
    if (score > best) best = score;
  }

  return best * 0.1;
}

/**
 * Edge stability: reward tiles on the edge/border (harder to displace).
 */
function edgeStability(board: NumBoard): number {
  const size = board.length;
  let score = 0;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (r === 0 || r === size - 1 || c === 0 || c === size - 1) {
        score += board[r][c];
      }
    }
  }

  return score * 0.5;
}

/**
 * Failure risk penalty: when there are very few empty cells, apply a large penalty
 * to discourage moves that lead to near-full boards.
 */
function failureRiskPenalty(board: NumBoard): number {
  let empty = 0;
  for (const row of board) {
    for (const v of row) {
      if (v === 0) empty++;
    }
  }

  if (empty === 0) return -100000; // immediate game over risk
  if (empty <= 2) return -5000;
  if (empty <= 4) return -500;
  return 0;
}

// ── Main evaluation function ─────────────────────────────────────────────────

/**
 * Evaluate a board position with a weighted combination of heuristics.
 * Returns a numeric score — higher is better.
 */
export function evaluate(board: NumBoard): number {
  return (
    emptyBonus(board) +
    maxTileBonus(board) +
    cornerBonus(board) +
    monotonicityScore(board) +
    smoothnessScore(board) +
    mergePotential(board) +
    snakeWeight(board) +
    edgeStability(board) +
    failureRiskPenalty(board)
  );
}
