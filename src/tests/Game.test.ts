import { describe, it, expect } from "vitest";
import { Game } from "../game/Game";
import type { Direction } from "../types";

const DIRECTIONS: Direction[] = ["up", "down", "left", "right"];

function firstValidMove(game: Game): Direction {
  const direction = DIRECTIONS.find((dir) => game.canMove(dir));
  if (!direction) throw new Error("Expected a new game to have at least one valid move");
  return direction;
}

describe("Game requestMove lifecycle", () => {
  it("provides the spawned tile before move-start callbacks run", async () => {
    const game = new Game(4);
    const direction = firstValidMove(game);
    let seenSpawnedId: string | null | undefined;

    game.onMoveStart((result) => {
      seenSpawnedId = result.spawnedTile?.id ?? null;
    });

    const result = await game.requestMove(direction);

    expect(result.moved).toBe(true);
    expect(result.spawnedTile).not.toBeNull();
    expect(seenSpawnedId).toBe(result.spawnedTile?.id);
    expect(
      result.nextBoardSnapshot.tiles.some((tile) => tile.id === result.spawnedTile?.id)
    ).toBe(true);
  });

  it("waits for async move-start callbacks before resolving", async () => {
    const game = new Game(4);
    const direction = firstValidMove(game);
    let callbackCompleted = false;

    game.onMoveStart(async () => {
      await Promise.resolve();
      callbackCompleted = true;
    });

    await game.requestMove(direction);

    expect(callbackCompleted).toBe(true);
  });

  it("passes per-move animation duration to move-start callbacks", async () => {
    const game = new Game(4);
    const direction = firstValidMove(game);
    let seenDuration: number | null = null;

    game.onMoveStart((result) => {
      seenDuration = result.animationDurationMs;
    });

    const result = await game.requestMove(direction, { animationDurationMs: 0 });

    expect(result.animationDurationMs).toBe(0);
    expect(seenDuration).toBe(0);
  });

  it("does not expose win state after the player chooses to continue", () => {
    const game = new Game(4);
    const internals = game as unknown as { hasWon: boolean };

    internals.hasWon = true;
    expect(game.getBoardSnapshot().hasWon).toBe(true);

    game.continueAfterWin();

    expect(game.getBoardSnapshot().hasWon).toBe(false);
  });
});
