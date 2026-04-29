# Repository Guidelines

## Project Structure & Module Organization

This is a Vite + TypeScript implementation of 2048 with an Expectimax-based AutoPlayer.

- `src/main.ts` wires the game, renderer, input controller, and AutoPlayer to the DOM.
- `src/game/` contains core game state and move logic.
- `src/autoplay/` contains AutoPlayer orchestration, heuristics, and numeric-board simulation.
- `wasm-autoplayer/` contains the Rust crate that mirrors the AutoPlayer's pure compute path for WebAssembly.
- `src/render/` contains DOM rendering and animation code.
- `src/input/` handles keyboard or input events.
- `src/styles/style.css` contains application styling.
- `src/tests/` contains Vitest tests, currently focused on move logic and simulator behavior.
- `index.html`, `vite.config.ts`, and `tsconfig.json` define the app shell and build configuration.

## Build, Test, and Development Commands

- `npm install` installs dependencies from `package-lock.json`.
- `npm run dev` starts the Vite development server.
- `npm run build:wasm` builds the Rust/WASM AutoPlayer package into `public/wasm-autoplayer/`.
- `npm run build:app` runs TypeScript checks with `tsc`, then builds production assets into `dist/` without rebuilding WASM.
- `npm run build` builds the Rust/WASM package first, then builds the production Vite app.
- `npm run preview` serves the production build locally for inspection.
- `npm test` runs the Vitest suite once.
- `npm run test:wasm` runs Rust unit tests for the WASM search engine.

## Coding Style & Naming Conventions

Use TypeScript modules with strict typing enabled. Prefer named exports for reusable classes, functions, and types. Class names use `PascalCase` (`Game`, `Renderer`, `AutoPlayer`); functions, variables, and files that are not classes use `camelCase` (`moveLogic.ts`, `simulateMove`). Keep imports relative within `src/`.

Follow the existing formatting style: two-space indentation, double quotes, semicolons, and concise comments only where they clarify non-obvious behavior. The TypeScript configuration enforces `strict`, `noUnusedLocals`, `noUnusedParameters`, and switch fallthrough checks.

## Testing Guidelines

Tests use Vitest and live under `src/tests/`. Name test files with the `.test.ts` suffix, for example `moveLogic.test.ts`. Prefer deterministic unit tests for pure game logic and simulator behavior before adding DOM-dependent tests. Run `npm test` before submitting changes, and run `npm run build` when touching shared types, build config, or browser-facing code. Run `npm run test:wasm` when touching `wasm-autoplayer/`. `npm run build:wasm` requires Rust with the `wasm32-unknown-unknown` target and the project-local `wasm-pack` npm dependency installed.

## Commit & Pull Request Guidelines

The history mostly uses short imperative messages with conventional prefixes, such as `fix: restore merge and spawn tiles after animation` and `chore: update vite and vitest`. Use the same pattern when practical: `fix:`, `chore:`, `test:`, or `feat:`.

Pull requests should include a brief description, the user-visible behavior changed, and the commands run for verification. Link related issues when available. Include screenshots or short recordings for rendering, animation, or UI changes.
