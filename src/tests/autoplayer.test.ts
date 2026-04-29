import { describe, it, expect } from "vitest";
import {
  AutoPlayer,
  deriveSearchConfig,
  selectChanceCellsForSearch,
} from "../autoplay/AutoPlayer";
import { choosePreferredCorner, evaluate } from "../autoplay/heuristic";
import type { BoardSnapshot, Direction } from "../types";

function makeSnapshot(cells: number[][]): BoardSnapshot {
  return {
    size: 4,
    cells: cells.map((row) => row.map((value) => (value === 0 ? null : value))),
    tiles: [],
    score: 0,
    bestScore: 0,
    maxTile: Math.max(...cells.flat()),
    isGameOver: false,
    hasWon: false,
  };
}

class FakeGame {
  requestedMoves: Direction[] = [];

  constructor(private readonly snapshot: BoardSnapshot) {}

  getBoardSnapshot(): BoardSnapshot {
    return this.snapshot;
  }

  async requestMove(direction: Direction): Promise<unknown> {
    this.requestedMoves.push(direction);
    return {};
  }
}

describe("AutoPlayer search configuration", () => {
  it("scales search work with thinking strength", () => {
    const weak = deriveSearchConfig(1, 8);
    const strong = deriveSearchConfig(10, 8);

    expect(strong.depth).toBeGreaterThan(weak.depth);
    expect(strong.timeBudgetMs).toBeGreaterThan(weak.timeBudgetMs);
    expect(strong.chanceCellLimit).toBeGreaterThan(weak.chanceCellLimit);
  });

  it("searches deeper on crowded boards", () => {
    const open = deriveSearchConfig(6, 12);
    const crowded = deriveSearchConfig(6, 2);

    expect(crowded.depth).toBeGreaterThan(open.depth);
  });

  it("selects deterministic chance cells", () => {
    const board = [
      [64, 32, 16, 8],
      [4, 2, 4, 2],
      [0, 0, 8, 4],
      [0, 2, 0, 0],
    ];
    const config = deriveSearchConfig(5, 6);

    expect(selectChanceCellsForSearch(board, config)).toEqual(
      selectChanceCellsForSearch(board, config)
    );
    expect(selectChanceCellsForSearch(board, config).length).toBeLessThanOrEqual(
      config.chanceCellLimit
    );
  });
});

describe("AutoPlayer evaluation", () => {
  it("rewards keeping the max tile in the preferred corner", () => {
    const stable = [
      [1024, 512, 256, 128],
      [64, 32, 16, 8],
      [4, 2, 0, 0],
      [0, 0, 0, 0],
    ];
    const unstable = [
      [0, 512, 256, 128],
      [64, 32, 16, 8],
      [4, 2, 1024, 0],
      [0, 0, 0, 0],
    ];

    expect(choosePreferredCorner(stable)).toBe("top-left");
    expect(
      evaluate(stable, { preferredCorner: "top-left", riskWeight: 1.2 })
    ).toBeGreaterThan(
      evaluate(unstable, { preferredCorner: "top-left", riskWeight: 1.2 })
    );
  });

  it("avoids pulling the max tile out of its corner in a risky position", async () => {
    const snapshot = makeSnapshot([
      [1024, 512, 256, 128],
      [64, 32, 16, 8],
      [4, 2, 4, 2],
      [0, 0, 2, 0],
    ]);
    const fakeGame = new FakeGame(snapshot);
    const autoPlayer = new AutoPlayer(fakeGame as never, {
      thinkingStrength: 4,
      useDynamicDepth: false,
      maxDepth: 2,
    });

    await autoPlayer.stepOnce();

    expect(fakeGame.requestedMoves[0]).not.toBe("down");
  });
});
