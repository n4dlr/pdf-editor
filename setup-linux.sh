#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'This setup script is for Linux only.\n' >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  printf 'This script installs native egui prerequisites on Debian/Ubuntu (apt) only.\n' >&2
  printf 'Install CMake, Clang, X11/Wayland, OpenGL, fontconfig, and FreeType development packages for your distribution, then rerun.\n' >&2
  exit 1
fi

if ! command -v rustup >/dev/null 2>&1 || ! command -v cargo >/dev/null 2>&1; then
  printf 'Install the Rust stable toolchain with rustup from https://rustup.rs/, then rerun this script.\n' >&2
  exit 1
fi

sudo apt-get update
sudo apt-get install -y \
  build-essential \
  clang \
  cmake \
  curl \
  file \
  libfontconfig1-dev \
  libfreetype6-dev \
  libgl1-mesa-dev \
  libwayland-dev \
  libx11-dev \
  libxcb-render0-dev \
  libxcb-shape0-dev \
  libxcb-xfixes0-dev \
  libxcursor-dev \
  libxi-dev \
  libxkbcommon-dev \
  libxrandr-dev \
  pkg-config

rustup toolchain install stable
rustup default stable
cargo install cargo-deb --locked

printf '\nNative Linux build dependencies are ready.\n'
printf 'Run ./start-linux.sh to launch the desktop app, or ./build-linux.sh to create the .deb package.\n'
