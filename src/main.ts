// src/main.ts
// Application entry point. Wires together Game, Renderer, InputController, AutoPlayer.

import "./styles/style.css";
import { Game } from "./game/Game";
import { Renderer } from "./render/Renderer";
import { InputController } from "./input/InputController";
import { AutoPlayer } from "./autoplay/AutoPlayer";
import type { Direction, MoveResult } from "./types";

// ── Instantiate core objects ─────────────────────────────────────────────────

const game = new Game(4);
const renderer = new Renderer(game);
const inputController = new InputController(game);
const autoPlayer = new AutoPlayer(game, {
  delayMs: 300,
  maxDepth: 4,
  useDynamicDepth: true,
  timeBudgetMs: 200,
});

// ── Input → Game ─────────────────────────────────────────────────────────────

// Human input queuing — prevent concurrent moves
let moveInProgress = false;

inputController.onMoveRequest(async (dir: Direction) => {
  if (moveInProgress) return;
  if (game.getBoardSnapshot().isGameOver) return;
  moveInProgress = true;
  await game.requestMove(dir);
  moveInProgress = false;
});

// ── Game → Renderer ──────────────────────────────────────────────────────────

game.onMoveStart(async (result: MoveResult) => {
  await renderer.animateMove(result);
});

game.onStateChange(() => {
  const snapshot = game.getBoardSnapshot();
  renderer.updateScores(snapshot, game.getSteps());
  renderer.updateAutoPlayerUI(autoPlayer);

  const continueButton = document.getElementById("btn-continue") as HTMLButtonElement;
  continueButton.disabled = !snapshot.hasWon;

  if (snapshot.isGameOver) {
    renderer.hideWinOverlay();
    renderer.showGameOverOverlay();
  } else if (snapshot.hasWon) {
    renderer.hideGameOverOverlay();
    renderer.showWinOverlay();
  } else {
    renderer.hideAllOverlays();
  }
});

game.onMoveEnd((result) => {
  if (!result.moved) return;

  const boardValues = result.nextBoardSnapshot.cells.map((row) =>
    row.map((value) => value ?? 0)
  );
  console.log("Current board:", boardValues);
});

// ── AutoPlayer → UI ──────────────────────────────────────────────────────────

autoPlayer.onStatusChange(() => {
  renderer.updateAutoPlayerUI(autoPlayer);
});

// ── Buttons ──────────────────────────────────────────────────────────────────

// New game
document.getElementById("btn-new-game")!.addEventListener("click", () => {
  autoPlayer.stop();
  game.startNewGame();
  renderer.render(game.getBoardSnapshot());
  renderer.hideAllOverlays();
  renderer.updateScores(game.getBoardSnapshot(), 0);
  renderer.updateAutoPlayerUI(autoPlayer);
});

// Continue after win
document.getElementById("btn-continue")!.addEventListener("click", () => {
  game.continueAfterWin();
  renderer.hideWinOverlay();
});

// Overlay buttons
document.getElementById("btn-overlay-continue")!.addEventListener("click", () => {
  game.continueAfterWin();
  renderer.hideWinOverlay();
});
document.getElementById("btn-overlay-new-win")!.addEventListener("click", () => {
  autoPlayer.stop();
  game.startNewGame();
  renderer.render(game.getBoardSnapshot());
  renderer.hideAllOverlays();
  renderer.updateScores(game.getBoardSnapshot(), 0);
  renderer.updateAutoPlayerUI(autoPlayer);
});
document.getElementById("btn-overlay-new-gameover")!.addEventListener("click", () => {
  autoPlayer.stop();
  game.startNewGame();
  renderer.render(game.getBoardSnapshot());
  renderer.hideAllOverlays();
  renderer.updateScores(game.getBoardSnapshot(), 0);
  renderer.updateAutoPlayerUI(autoPlayer);
});

// AutoPlayer controls
document.getElementById("btn-auto-start")!.addEventListener("click", () => {
  autoPlayer.start();
});
document.getElementById("btn-auto-pause")!.addEventListener("click", () => {
  autoPlayer.pause();
});
document.getElementById("btn-auto-stop")!.addEventListener("click", () => {
  autoPlayer.stop();
});
document.getElementById("btn-auto-step")!.addEventListener("click", async () => {
  await autoPlayer.stepOnce();
});

// Delay slider
const delaySlider = document.getElementById("delay-slider") as HTMLInputElement;
const delayValue = document.getElementById("delay-value")!;
delaySlider.addEventListener("input", () => {
  const val = parseInt(delaySlider.value, 10);
  delayValue.textContent = String(val);
  autoPlayer.setDelay(val);
});

// Depth slider
const depthSlider = document.getElementById("depth-slider") as HTMLInputElement;
const depthValue = document.getElementById("depth-value")!;
depthSlider.addEventListener("input", () => {
  const val = parseInt(depthSlider.value, 10);
  depthValue.textContent = String(val);
  autoPlayer.setMaxDepth(val);
});

// ── Initial render ────────────────────────────────────────────────────────────

renderer.updateScores(game.getBoardSnapshot(), 0);
renderer.updateAutoPlayerUI(autoPlayer);
