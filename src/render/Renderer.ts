// src/render/Renderer.ts
// Handles all DOM manipulation and animations.
// Renderer is purely a view layer — it does NOT contain game logic.

import type { Tile, MoveResult, BoardSnapshot } from "../types";
import type { Game } from "../game/Game";
import type { AutoPlayer } from "../autoplay/AutoPlayer";

const ANIMATION_DURATION_MS = 150;
const ANIMATION_BUFFER_MS = 20;
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

    game.setAnimationDuration(ANIMATION_DURATION_MS);

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
    const duration = normalizeDuration(result.animationDurationMs);

    // Move tiles to new positions
    this.setAllTileTiming(duration);
    for (const moved of result.movedTiles) {
      const el = this.tileElements.get(moved.id);
      if (el) {
        this.positionTile(el, moved.toRow, moved.toCol);
      }
    }

    // Wait for move animation
    await delay(duration);

    // Remove source tiles that were merged
    for (const merged of result.mergedTiles) {
      for (const srcId of merged.sourceIds) {
        const el = this.tileElements.get(srcId);
        if (el) {
          el.remove();
          this.tileElements.delete(srcId);
        }
      }

      const mergedTileData: Tile = {
        id: merged.resultId,
        value: merged.value,
        row: merged.row,
        col: merged.col,
      };
      const el = this.createTileElement(mergedTileData);
      this.setTileTiming(el, duration);
      if (duration > 0) {
        el.classList.add("tile-merged");
      }
      this.boardTiles.appendChild(el);
      this.tileElements.set(merged.resultId, el);
    }

    // Spawn new tile
    await delay(duration > 0 ? ANIMATION_BUFFER_MS : 0);
    if (result.spawnedTile) {
      const existing = this.tileElements.get(result.spawnedTile.id);
      if (!existing) {
        const el = this.createTileElement(result.spawnedTile);
        this.setTileTiming(el, duration);
        if (duration > 0) {
          el.classList.add("tile-new");
        }
        this.boardTiles.appendChild(el);
        this.tileElements.set(result.spawnedTile.id, el);
      }
    }
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

  private setAllTileTiming(durationMs: number): void {
    for (const el of this.tileElements.values()) {
      this.setTileTiming(el, durationMs);
    }
  }

  private setTileTiming(el: HTMLElement, durationMs: number): void {
    const duration = `${durationMs}ms`;
    el.style.transitionDuration = duration;
    el.style.animationDuration = duration;
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
    setText(
      "auto-search",
      status.lastSearchMs !== null ? `${Math.round(status.lastSearchMs)}ms` : "—"
    );
    setText(
      "auto-nodes",
      status.searchNodes > 0 ? status.searchNodes.toLocaleString() : "—"
    );
    setText(
      "auto-cache",
      status.cacheHitRate !== null ? `${Math.round(status.cacheHitRate * 100)}%` : "—"
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
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDuration(ms: number): number {
  if (!Number.isFinite(ms)) return ANIMATION_DURATION_MS;
  return Math.max(0, Math.round(ms));
}
