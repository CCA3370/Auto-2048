import { afterEach, describe, expect, it } from "vitest";
import {
  findBestMoveForBoardAsync,
  type FindBestMoveOptions,
} from "../autoplay/AutoPlayer";
import {
  encodeBoardForWasm,
  resetWasmModuleLoaderForTests,
  setWasmModuleLoaderForTests,
  type WasmAutoplayerModule,
} from "../autoplay/wasmEngine";

describe("WASM AutoPlayer adapter", () => {
  afterEach(() => {
    resetWasmModuleLoaderForTests();
  });

  it("encodes NumBoard values into a compact flat array", () => {
    const encoded = encodeBoardForWasm([
      [2, 4, 8, 16],
      [32, 64, 128, 256],
      [512, 1024, 2048, 4096],
      [8192, 0, 0, 0],
    ]);

    expect(Array.from(encoded)).toEqual([
      2, 4, 8, 16,
      32, 64, 128, 256,
      512, 1024, 2048, 4096,
      8192, 0, 0, 0,
    ]);
    });

  it("uses a loaded WASM module decision when available", async () => {
    let receivedBoard: number[] = [];
    const receivedOptions: FindBestMoveOptions[] = [];
    const module: WasmAutoplayerModule = {
      find_best_move(board, options) {
        receivedBoard = Array.from(board);
        receivedOptions.push(options);
        return {
          bestDirection: 2,
          bestScore: 123,
          depth: 1,
          evaluatedMoves: [
            { direction: 0, score: 10, valid: true },
            { direction: 1, score: 20, valid: true },
            { direction: 2, score: 123, valid: true },
            { direction: 3, score: Number.NEGATIVE_INFINITY, valid: false },
          ],
          metrics: {
            nodes: 42,
            cacheHits: 3,
            cacheMisses: 5,
            chanceNodes: 7,
            durationMs: 1.5,
            timedOut: false,
          },
        };
      },
    };

    setWasmModuleLoaderForTests(async () => module);

    const decision = await findBestMoveForBoardAsync(
      [
        [2, 2, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      { thinkingStrength: 3 }
    );

    expect(receivedBoard.slice(0, 4)).toEqual([2, 2, 0, 0]);
    expect(receivedOptions[0]?.thinkingStrength).toBe(3);
    expect(decision?.bestDirection).toBe("left");
    expect(decision?.metrics.nodes).toBe(42);
  });

  it("falls back to the TypeScript search when WASM loading fails", async () => {
    setWasmModuleLoaderForTests(async () => {
      throw new Error("missing wasm package");
    });

    const decision = await findBestMoveForBoardAsync(
      [
        [2, 2, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      {
        thinkingStrength: 3,
        useDynamicDepth: false,
        maxDepth: 1,
      }
    );

    expect(decision?.bestDirection).toBe("left");
    expect(decision?.metrics.nodes).toBeGreaterThan(0);
  });
});
