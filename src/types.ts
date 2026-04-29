// src/types.ts
// Central type definitions for the 2048 AutoPlayer project.

import type { HeuristicPresetName } from "./autoplay/heuristic";

export type Direction = "up" | "down" | "left" | "right";

export interface Tile {
  /** Unique identifier used by the Renderer to track DOM elements and animate. */
  id: string;
  value: number;
  row: number;
  col: number;
  /** Marks a tile as the result of a merge in the current move; used for merge animation. */
  mergedFrom?: [string, string]; // ids of the two source tiles
  /** Whether this tile just spawned (for spawn animation). */
  isNew?: boolean;
}

export interface BoardSnapshot {
  size: number;
  /** 2D grid of values (null = empty). */
  cells: Array<Array<number | null>>;
  tiles: Tile[];
  score: number;
  bestScore: number;
  maxTile: number;
  isGameOver: boolean;
  hasWon: boolean;
}

export interface MovedTileInfo {
  id: string;
  fromRow: number;
  fromCol: number;
  toRow: number;
  toCol: number;
  value: number;
}

export interface MergedTileInfo {
  resultId: string;
  sourceIds: [string, string];
  row: number;
  col: number;
  value: number;
}

export interface MoveResult {
  direction: Direction;
  moved: boolean;
  scoreGained: number;
  movedTiles: MovedTileInfo[];
  mergedTiles: MergedTileInfo[];
  spawnedTile: Tile | null;
  previousBoardSnapshot: BoardSnapshot;
  nextBoardSnapshot: BoardSnapshot;
  animationDurationMs: number;
}

export interface MoveRequestOptions {
  animationDurationMs?: number;
}

export interface AutoPlayerOptions {
  delayMs: number;
  maxDepth: number;
  useDynamicDepth: boolean;
  timeBudgetMs: number;
  thinkingStrength: number;
  heuristicPreset: HeuristicPresetName;
}

export interface EvaluatedMove {
  direction: Direction;
  score: number;
  valid: boolean;
}

export interface AutoPlayerResult {
  direction: Direction;
  score: number;
  depth: number;
  evaluatedMoves: EvaluatedMove[];
}

export interface AutoPlayerStatus {
  state: "idle" | "thinking" | "running" | "paused" | "stopped";
  lastDirection: Direction | null;
  lastScore: number | null;
  lastDepth: number | null;
  steps: number;
  evaluatedMoves: EvaluatedMove[];
  message: string;
  thinkingStrength: number;
  lastSearchMs: number | null;
  searchNodes: number;
  cacheHitRate: number | null;
}
