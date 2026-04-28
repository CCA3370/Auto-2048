// src/input/InputController.ts
// Handles all user input: keyboard, touch swipe, and on-screen buttons.
// All inputs route through game.requestMove(direction).
// NEVER directly mutates game state.

import type { Direction } from "../types";
import type { Game } from "../game/Game";

const SWIPE_THRESHOLD = 30; // minimum px for a swipe to register

export class InputController {
  private readonly game: Game;
  private onMove: ((dir: Direction) => void) | null = null;

  private touchStartX = 0;
  private touchStartY = 0;

  constructor(game: Game) {
    this.game = game;
    this.attachKeyboard();
    this.attachTouch();
    this.attachDirectionButtons();
  }

  onMoveRequest(cb: (dir: Direction) => void): void {
    this.onMove = cb;
  }

  private dispatch(direction: Direction): void {
    if (this.onMove) {
      this.onMove(direction);
    } else {
      // Default: call game directly
      this.game.requestMove(direction);
    }
  }

  private attachKeyboard(): void {
    window.addEventListener("keydown", (e: KeyboardEvent) => {
      let dir: Direction | null = null;

      switch (e.key) {
        case "ArrowUp":
        case "w":
        case "W":
          dir = "up";
          break;
        case "ArrowDown":
        case "s":
        case "S":
          dir = "down";
          break;
        case "ArrowLeft":
        case "a":
        case "A":
          dir = "left";
          break;
        case "ArrowRight":
        case "d":
        case "D":
          dir = "right";
          break;
      }

      if (dir) {
        e.preventDefault();
        this.dispatch(dir);
      }
    });
  }

  private attachTouch(): void {
    const board = document.getElementById("board-container");
    if (!board) return;

    board.addEventListener(
      "touchstart",
      (e: TouchEvent) => {
        const touch = e.touches[0];
        this.touchStartX = touch.clientX;
        this.touchStartY = touch.clientY;
      },
      { passive: true }
    );

    board.addEventListener(
      "touchend",
      (e: TouchEvent) => {
        const touch = e.changedTouches[0];
        const dx = touch.clientX - this.touchStartX;
        const dy = touch.clientY - this.touchStartY;

        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);

        if (Math.max(absDx, absDy) < SWIPE_THRESHOLD) return;

        let dir: Direction;
        if (absDx > absDy) {
          dir = dx > 0 ? "right" : "left";
        } else {
          dir = dy > 0 ? "down" : "up";
        }

        e.preventDefault();
        this.dispatch(dir);
      },
      { passive: false }
    );
  }

  private attachDirectionButtons(): void {
    document.querySelectorAll<HTMLButtonElement>(".btn-dir").forEach((btn) => {
      btn.addEventListener("click", () => {
        const dir = btn.dataset.dir as Direction | undefined;
        if (dir) this.dispatch(dir);
      });
    });
  }
}
