# Auto-2048

2048 with an Expectimax AutoPlayer. The browser UI is TypeScript/Vite; the
AutoPlayer can optionally load a Rust/WebAssembly search engine and falls back
to the TypeScript implementation if the WASM package is missing or fails to
initialize.

## Commands

- `npm install` installs JavaScript dependencies, including the local
  `wasm-pack` wrapper used by the WASM build script.
- `npm run build:wasm` builds `wasm-autoplayer/` into
  `public/wasm-autoplayer/` for static Vite serving.
- `npm run build:app` type-checks and builds only the TypeScript/Vite app.
- `npm run build` builds the WASM package first, then runs the production Vite
  build.
- `npm test` runs the Vitest suite.
- `npm run test:wasm` runs Rust unit tests for the WASM search engine.
- `cargo run --manifest-path wasm-autoplayer/Cargo.toml --bin autoplayer-cli -- --help`
  runs the native Rust AutoPlayer CLI without the browser or Vite stack.

## Native AutoPlayer CLI

The Rust engine can run outside the web app. The CLI writes JSON so it can be
used from scripts or benchmark jobs.

```sh
cargo run --manifest-path wasm-autoplayer/Cargo.toml --bin autoplayer-cli -- \
  decide --board "2,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0" --depth 1

cargo run --manifest-path wasm-autoplayer/Cargo.toml --bin autoplayer-cli -- \
  play --seed 3370 --strength 10 --depth 8 --max-moves 2000

cargo run --manifest-path wasm-autoplayer/Cargo.toml --bin autoplayer-cli -- \
  bench --seeds 1,2,3 --strategy strong:10:survival:8 --progress
```

The native engine uses a 64-bit bitboard internally, with each tile stored as a
4-bit exponent. That supports tiles through 32768 in the Rust/WASM search path.
For `bench --progress`, live score lines are written to stderr and the final
benchmark summary remains JSON on stdout.

### CUDA Rollout Backend

The native CLI can be built with an optional NVIDIA CUDA rollout backend. The
default backend is still CPU Expectimax; CUDA is only used when the CLI is run
with `--backend cuda-rollout`.

CUDA support is native-only and requires the CUDA Toolkit with `nvcc` available
through `PATH`, `CUDA_PATH`, or `NVCC`.

```sh
cargo build --release --features cuda \
  --manifest-path wasm-autoplayer/Cargo.toml \
  --bin autoplayer-cli

wasm-autoplayer/target/release/autoplayer-cli bench \
  --backend cuda-rollout \
  --gpu 0 \
  --rollouts 65536 \
  --rollout-steps 512 \
  --seeds 1,2,3 \
  --progress
```

CUDA mode evaluates each legal root move with batched deterministic rollouts on
the selected GPU, then chooses the move with the best rollout score. If the CUDA
feature is not compiled in, or CUDA initialization fails, the CLI returns an
explicit error and does not silently switch to CPU results. Use `--backend cpu`
for the regular Expectimax path.

## Rust/WASM Tooling

`npm run build:wasm` requires a working Rust toolchain with the
`wasm32-unknown-unknown` target. Install the target with:

```sh
rustup target add wasm32-unknown-unknown
```

The generated files in `public/wasm-autoplayer/` are build artifacts and are
not committed. If WASM assets are absent during local development, the
AutoPlayer still works through the TypeScript fallback.
