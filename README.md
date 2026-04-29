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

## Rust/WASM Tooling

`npm run build:wasm` requires a working Rust toolchain with the
`wasm32-unknown-unknown` target. Install the target with:

```sh
rustup target add wasm32-unknown-unknown
```

The generated files in `public/wasm-autoplayer/` are build artifacts and are
not committed. If WASM assets are absent during local development, the
AutoPlayer still works through the TypeScript fallback.
