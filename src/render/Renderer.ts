// src/render/Renderer.ts
// Handles all DOM manipulation and animations.
// Renderer is purely a view layer — it does NOT contain game logic.

import type { Tile, MoveResult, BoardSnapshot } from "../types";
import type { Game } from "../game/Game";
import type { AutoPlayer } from "../autoplay/AutoPlayer";

const ANIMATION_DURATION_MS = 150;
const TILE_COLORS: Record<number, { bg: string; fg: string }> = {
  2:     { bg: "#eee4da", fg: "#776e65" },
  4:     { bg: "#ede0c8", fg: "#776e65" },
  8:     { bg: "#f2b179", fg: "#f9f6f2" },
  16:    { bg: "#f59563", fg: "#f9f6f2" },
  32:    { bg: "#f67c5f", fg: "#f9f6f2" },
  64:    { bg: "#f65e3b", fg: "#f9f6f2" },
  128:   { bg: "#edcf72", fg: "#f9f6f2" },
  256:   { bg: "#edcc61", fg: "#f9f6f2" },
  512:   { bg: "#edc850", fg: "#f9f6f2" },
  1024:  { bg: "#edc53f", fg: "#f9f6f2" },
  2048:  { bg: "#edc22e", fg: "#f9f6f2" },
};

function getTileColor(value: number): { bg: string; fg: string } {
  if (TILE_COLORS[value]) return TILE_COLORS[value];
  // For super tiles (4096+), use a deep purple/dark scheme
  return { bg: "#3d3a4a", fg: "#f9f6f2" };
}

function getTileFontSize(value: number): string {
  if (value < 100) return "clamp(1.8rem, 4vw, 2.4rem)";
  if (value < 1000) return "clamp(1.4rem, 3.5vw, 2rem)";
  if (value < 10000) return "clamp(1.1rem, 2.8vw, 1.6rem)";
  return "clamp(0.9rem, 2.2vw, 1.3rem)";
}

export class Renderer {
  private readonly boardGrid: HTMLElement;
  private readonly boardTiles: HTMLElement;
  private readonly size: number = 4;

  /** Map from tile id → DOM element */
  private tileElements: Map<string, HTMLElement> = new Map();

  constructor(game: Game) {
    this.boardGrid = document.getElementById("board-grid")!;
    this.boardTiles = document.getElementById("board-tiles")!;

    game.setAnimationDuration(ANIMATION_DURATION_MS + 20); // small buffer

    this.buildGrid();
    this.render(game.getBoardSnapshot());
  }

  private buildGrid(): void {
    this.boardGrid.innerHTML = "";
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        const cell = document.createElement("div");
        cell.className = "board-cell";
        this.boardGrid.appendChild(cell);
      }
    }
  }

  /** Full re-render from a board snapshot (e.g. after new game). */
  render(snapshot: BoardSnapshot): void {
    // Remove all existing tile elements
    this.tileElements.forEach((el) => el.remove());
    this.tileElements.clear();

    for (const tile of snapshot.tiles) {
      const el = this.createTileElement(tile);
      this.boardTiles.appendChild(el);
      this.tileElements.set(tile.id, el);
    }
  }

  /**
   * Animate a move result.
   * Called by onMoveStart. Returns after animations complete.
   */
  async animateMove(result: MoveResult): Promise<void> {
    if (!result.moved) return;

    const prev = result.previousBoardSnapshot;
    const movedSet = new Set(result.movedTiles.map((t) => t.id));
    const mergedSet = new Set(result.mergedTiles.flatMap((m) => [...m.sourceIds]));

    // Move tiles to new positions
    for (const moved of result.movedTiles) {
      const el = this.tileElements.get(moved.id);
      if (el) {
        this.positionTile(el, moved.toRow, moved.toCol);
      }
    }

    // Wait for move animation
    await delay(ANIMATION_DURATION_MS);

    // Remove source tiles that were merged
    for (const merged of result.mergedTiles) {
      for (const srcId of merged.sourceIds) {
        const el = this.tileElements.get(srcId);
        if (el) {
          el.remove();
          this.tileElements.delete(srcId);
        }
      }

      // Create the merged tile element
      const mergedTileData = result.nextBoardSnapshot.tiles.find(
        (t) => t.id === merged.resultId
      );
      if (mergedTileData) {
        const el = this.createTileElement(mergedTileData);
        el.classList.add("tile-merged");
        this.boardTiles.appendChild(el);
        this.tileElements.set(merged.resultId, el);
      }
    }

    // Remove tiles that were in prev but not in next (accounted above)
    const nextIds = new Set(result.nextBoardSnapshot.tiles.map((t) => t.id));
    for (const [id, el] of this.tileElements) {
      if (!nextIds.has(id)) {
        // moved tiles that should not appear anymore (merged sources already removed)
        if (!mergedSet.has(id)) {
          el.remove();
          this.tileElements.delete(id);
        }
      }
    }

    // Spawn new tile
    if (result.spawnedTile) {
      const existing = this.tileElements.get(result.spawnedTile.id);
      if (!existing) {
        const el = this.createTileElement(result.spawnedTile);
        el.classList.add("tile-new");
        this.boardTiles.appendChild(el);
        this.tileElements.set(result.spawnedTile.id, el);
      }
    }

    // Suppress unused variable warning
    void prev;
    void movedSet;
  }

  /** Create a tile DOM element positioned on the grid. */
  private createTileElement(tile: Tile): HTMLElement {
    const el = document.createElement("div");
    el.className = "tile";
    el.dataset.id = tile.id;

    const { bg, fg } = getTileColor(tile.value);
    el.style.backgroundColor = bg;
    el.style.color = fg;
    el.style.fontSize = getTileFontSize(tile.value);

    el.textContent = String(tile.value);
    this.positionTile(el, tile.row, tile.col);

    return el;
  }

  private positionTile(el: HTMLElement, row: number, col: number): void {
    el.style.setProperty("--row", String(row));
    el.style.setProperty("--col", String(col));
  }

  /** Update score, best score, max tile, steps. */
  updateScores(snapshot: BoardSnapshot, steps: number): void {
    setText("score", snapshot.score);
    setText("best-score", snapshot.bestScore);
    setText("max-tile", snapshot.maxTile);
    setText("steps", steps);
  }

  showWinOverlay(): void {
    const el = document.getElementById("overlay-win")!;
    el.classList.add("visible");
    el.setAttribute("aria-hidden", "false");
  }

  hideWinOverlay(): void {
    const el = document.getElementById("overlay-win")!;
    el.classList.remove("visible");
    el.setAttribute("aria-hidden", "true");
  }

  showGameOverOverlay(): void {
    const el = document.getElementById("overlay-gameover")!;
    el.classList.add("visible");
    el.setAttribute("aria-hidden", "false");
  }

  hideGameOverOverlay(): void {
    const el = document.getElementById("overlay-gameover")!;
    el.classList.remove("visible");
    el.setAttribute("aria-hidden", "true");
  }

  hideAllOverlays(): void {
    this.hideWinOverlay();
    this.hideGameOverOverlay();
  }

  updateAutoPlayerUI(autoPlayer: AutoPlayer): void {
    const status = autoPlayer.getStatus();

    setText("auto-state", status.state);
    setText("auto-direction", status.lastDirection ?? "—");
    setText("auto-depth", status.lastDepth !== null ? status.lastDepth : "—");
    setText(
      "auto-eval",
      status.lastScore !== null ? Math.round(status.lastScore).toLocaleString() : "—"
    );
    setText("auto-message", status.message);

    // Evaluated moves breakdown
    const container = document.getElementById("evaluated-moves")!;
    container.innerHTML = "";

    for (const move of status.evaluatedMoves) {
      const pill = document.createElement("div");
      pill.className = `eval-move${!move.valid ? " eval-invalid" : ""}${move.direction === status.lastDirection ? " eval-best" : ""}`;
      pill.textContent = `${move.direction[0].toUpperCase()}: ${
        move.valid ? Math.round(move.score).toLocaleString() : "×"
      }`;
      container.appendChild(pill);
    }

    // Button states
    const btnStart = document.getElementById("btn-auto-start") as HTMLButtonElement;
    const btnPause = document.getElementById("btn-auto-pause") as HTMLButtonElement;
    const btnStop = document.getElementById("btn-auto-stop") as HTMLButtonElement;
    const btnStep = document.getElementById("btn-auto-step") as HTMLButtonElement;

    const isRunning = status.state === "running" || status.state === "thinking";
    const isIdle = status.state === "idle" || status.state === "stopped";

    btnStart.disabled = isRunning;
    btnPause.disabled = !isRunning;
    btnStop.disabled = isIdle;
    btnStep.disabled = isRunning;
  }
}

function setText(id: string, value: string | number): void {
  const el = document.getElementById(id);
  if (el) el.textContent = String(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
