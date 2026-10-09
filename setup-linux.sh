#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'This setup script is for Linux only.\n' >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  printf 'This script installs Tauri prerequisites on Debian/Ubuntu (apt) only.\n' >&2
  printf 'Install the equivalent Tauri v2 WebKitGTK, GTK, appindicator, librsvg, and build packages for your distribution, then rerun.\n' >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js 20 or newer is required. Install it from https://nodejs.org/ and rerun.\n' >&2
  exit 1
fi

node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' || {
  printf 'Node.js 20 or newer is required; found %s.\n' "$(node --version)" >&2
  exit 1
}

if ! command -v rustup >/dev/null 2>&1 || ! command -v cargo >/dev/null 2>&1; then
  printf 'Install the Rust stable toolchain with rustup from https://rustup.rs/, then rerun this script.\n' >&2
  exit 1
fi

sudo apt-get update
sudo apt-get install -y \
  build-essential \
  curl \
  file \
  libayatana-appindicator3-dev \
  libgtk-3-dev \
  libssl-dev \
  libwebkit2gtk-4.1-dev \
  libxdo-dev \
  libclang-dev \
  librsvg2-dev \
  patchelf \
  pkg-config

rustup toolchain install stable
rustup default stable
npm --prefix "$PROJECT_DIR" ci

printf '\nLinux dependencies are ready.\n'
printf 'Run ./start-linux.sh to start the Tauri desktop app, or npm run dev for browser development.\n'
