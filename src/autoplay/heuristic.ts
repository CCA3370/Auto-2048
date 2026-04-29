// src/autoplay/heuristic.ts
// Heuristic evaluation for the Expectimax AutoPlayer.

import type { NumBoard } from "./autoSimulator";

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface EvaluationOptions {
  preferredCorner?: Corner;
  riskWeight?: number;
}

interface SnakeVariant {
  corner: Corner;
  weights: number[][];
}

// Log-scaled snake weights. The largest tile should stay in a corner and the
// surrounding values should descend along a stable snake path.
const BASE_SNAKE_WEIGHTS: number[][] = [
  [15, 14, 13, 12],
  [8, 9, 10, 11],
  [7, 6, 5, 4],
  [0, 1, 2, 3],
];

const SNAKE_VARIANTS: SnakeVariant[] = buildSnakeVariants();

function buildSnakeVariants(): SnakeVariant[] {
  function rotateMatrix(m: number[][]): number[][] {
    const n = m.length;
    return Array.from({ length: n }, (_, r) =>
      Array.from({ length: n }, (_, c) => m[n - 1 - c][r])
    );
  }

  function mirrorMatrix(m: number[][]): number[][] {
    return m.map((row) => [...row].reverse());
  }

  const variants: SnakeVariant[] = [];
  const seen = new Set<string>();
  let current = BASE_SNAKE_WEIGHTS;

  for (let i = 0; i < 4; i++) {
    for (const weights of [current, mirrorMatrix(current)]) {
      const key = JSON.stringify(weights);
      if (!seen.has(key)) {
        seen.add(key);
        variants.push({ weights, corner: strongestWeightCorner(weights) });
      }
    }
    current = rotateMatrix(current);
  }

  return variants;
}

function strongestWeightCorner(weights: number[][]): Corner {
  const size = weights.length;
  const corners: Array<[Corner, number]> = [
    ["top-left", weights[0][0]],
    ["top-right", weights[0][size - 1]],
    ["bottom-left", weights[size - 1][0]],
    ["bottom-right", weights[size - 1][size - 1]],
  ];
  corners.sort((a, b) => b[1] - a[1]);
  return corners[0][0];
}

export function choosePreferredCorner(board: NumBoard): Corner {
  const max = getMaxTile(board);
  const size = board.length;
  const maxCorners: Array<[Corner, number]> = [
    ["top-left", board[0][0]],
    ["top-right", board[0][size - 1]],
    ["bottom-left", board[size - 1][0]],
    ["bottom-right", board[size - 1][size - 1]],
  ];

  const cornerWithMax = maxCorners.find(([, value]) => value === max);
  if (cornerWithMax) return cornerWithMax[0];

  let bestCorner: Corner = "top-left";
  let bestScore = -Infinity;
  for (const variant of SNAKE_VARIANTS) {
    const score = scoreSnakeVariant(board, variant.weights);
    if (score > bestScore) {
      bestScore = score;
      bestCorner = variant.corner;
    }
  }
  return bestCorner;
}

export function evaluate(board: NumBoard, options: EvaluationOptions = {}): number {
  const preferredCorner = options.preferredCorner ?? choosePreferredCorner(board);
  const riskWeight = options.riskWeight ?? 1;

  return (
    emptyBonus(board) +
    maxTileBonus(board) +
    cornerStability(board, preferredCorner, riskWeight) +
    monotonicityScore(board) +
    smoothnessScore(board) +
    mergePotential(board) +
    snakeWeight(board, preferredCorner) +
    edgeStability(board) +
    isolationPenalty(board, riskWeight) +
    failureRiskPenalty(board, riskWeight)
  );
}

function emptyBonus(board: NumBoard): number {
  const empty = countEmptyTiles(board);
  return empty * 250 + empty * empty * 120;
}

function maxTileBonus(board: NumBoard): number {
  const max = getMaxTile(board);
  return max > 0 ? Math.log2(max) * max * 0.35 : 0;
}

function cornerStability(
  board: NumBoard,
  preferredCorner: Corner,
  riskWeight: number
): number {
  const max = getMaxTile(board);
  const maxCorner = cornerForValue(board, max);
  if (maxCorner === preferredCorner) return max * 5;
  if (maxCorner) return max * 1.5;
  return -max * 3 * riskWeight;
}

function monotonicityScore(board: NumBoard): number {
  const size = board.length;
  let score = 0;

  for (let r = 0; r < size; r++) {
    let incScore = 0;
    let decScore = 0;
    for (let c = 0; c < size - 1; c++) {
      const a = logValue(board[r][c]);
      const b = logValue(board[r][c + 1]);
      if (a > b) incScore += b - a;
      else decScore += a - b;
    }
    score += Math.max(incScore, decScore);
  }

  for (let c = 0; c < size; c++) {
    let incScore = 0;
    let decScore = 0;
    for (let r = 0; r < size - 1; r++) {
      const a = logValue(board[r][c]);
      const b = logValue(board[r + 1][c]);
      if (a > b) incScore += b - a;
      else decScore += a - b;
    }
    score += Math.max(incScore, decScore);
  }

  return score * 120;
}

function smoothnessScore(board: NumBoard): number {
  const size = board.length;
  let penalty = 0;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] === 0) continue;
      const current = logValue(board[r][c]);

      if (c + 1 < size && board[r][c + 1] !== 0) {
        penalty -= Math.abs(current - logValue(board[r][c + 1]));
      }
      if (r + 1 < size && board[r + 1][c] !== 0) {
        penalty -= Math.abs(current - logValue(board[r + 1][c]));
      }
    }
  }

  return penalty * 45;
}

function mergePotential(board: NumBoard): number {
  const size = board.length;
  let score = 0;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const value = board[r][c];
      if (value === 0) continue;
      if (c + 1 < size && value === board[r][c + 1]) score += logValue(value) * 90;
      if (r + 1 < size && value === board[r + 1][c]) score += logValue(value) * 90;
    }
  }

  return score;
}

function snakeWeight(board: NumBoard, preferredCorner: Corner): number {
  const preferredVariants = SNAKE_VARIANTS.filter(
    (variant) => variant.corner === preferredCorner
  );
  const variants = preferredVariants.length > 0 ? preferredVariants : SNAKE_VARIANTS;
  let best = -Infinity;

  for (const variant of variants) {
    const score = scoreSnakeVariant(board, variant.weights);
    if (score > best) best = score;
  }

  return best * 130;
}

function scoreSnakeVariant(board: NumBoard, weights: number[][]): number {
  let score = 0;
  for (let r = 0; r < board.length; r++) {
    for (let c = 0; c < board[r].length; c++) {
      score += logValue(board[r][c]) * weights[r][c];
    }
  }
  return score;
}

function edgeStability(board: NumBoard): number {
  const size = board.length;
  let score = 0;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (r === 0 || r === size - 1 || c === 0 || c === size - 1) {
        score += logValue(board[r][c]) * 30;
      }
    }
  }

  return score;
}

function isolationPenalty(board: NumBoard, riskWeight: number): number {
  const size = board.length;
  let penalty = 0;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const value = board[r][c];
      if (value === 0) continue;

      const current = logValue(value);
      const hasFriendlyNeighbor = neighbors(board, r, c).some((neighbor) => {
        if (neighbor === 0) return true;
        return Math.abs(current - logValue(neighbor)) <= 1;
      });

      if (!hasFriendlyNeighbor) penalty -= current * 55 * riskWeight;
    }
  }

  return penalty;
}

function failureRiskPenalty(board: NumBoard, riskWeight: number): number {
  const empty = countEmptyTiles(board);
  const merges = countMergeOpportunities(board);

  if (empty === 0 && merges === 0) return -120000 * riskWeight;
  if (empty <= 1) return (-12000 + merges * 1500) * riskWeight;
  if (empty <= 3) return (-3500 + merges * 900) * riskWeight;
  if (empty <= 5) return (-700 + merges * 250) * riskWeight;
  return merges * 120;
}

function countMergeOpportunities(board: NumBoard): number {
  const size = board.length;
  let count = 0;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const value = board[r][c];
      if (value === 0) continue;
      if (c + 1 < size && value === board[r][c + 1]) count++;
      if (r + 1 < size && value === board[r + 1][c]) count++;
    }
  }

  return count;
}

function neighbors(board: NumBoard, row: number, col: number): number[] {
  const values: number[] = [];
  if (row > 0) values.push(board[row - 1][col]);
  if (row + 1 < board.length) values.push(board[row + 1][col]);
  if (col > 0) values.push(board[row][col - 1]);
  if (col + 1 < board[row].length) values.push(board[row][col + 1]);
  return values;
}

function cornerForValue(board: NumBoard, value: number): Corner | null {
  const size = board.length;
  const corners: Array<[Corner, number]> = [
    ["top-left", board[0][0]],
    ["top-right", board[0][size - 1]],
    ["bottom-left", board[size - 1][0]],
    ["bottom-right", board[size - 1][size - 1]],
  ];
  return corners.find(([, cornerValue]) => cornerValue === value)?.[0] ?? null;
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

function countEmptyTiles(board: NumBoard): number {
  let count = 0;
  for (const row of board) {
    for (const value of row) {
      if (value === 0) count++;
    }
  }
  return count;
}

function logValue(value: number): number {
  return value > 0 ? Math.log2(value) : 0;
}
