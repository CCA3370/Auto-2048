#!/bin/bash
# Installs rustup with the wasm32-unknown-unknown target for Vercel's build
# environment, which provides Rust via a non-rustup system installation that
# lacks this target.
set -euo pipefail

curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
"$HOME/.cargo/bin/rustup" target add wasm32-unknown-unknown
npm install
