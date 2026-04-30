#!/bin/bash
# Installs rustup with the wasm32-unknown-unknown target for Vercel's build
# environment, which provides Rust via a non-rustup system installation that
# lacks this target.
set -euo pipefail

export PATH="/rust/bin:$HOME/.cargo/bin:$PATH"

if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
fi

if ! command -v rustup >/dev/null 2>&1; then
  echo "rustup is required but was not found after installation." >&2
  exit 1
fi

rustup target add wasm32-unknown-unknown
npm install
