#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'This build script is for Linux only.\n' >&2
  exit 1
fi

for command_name in cargo cargo-deb; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing required command: %s. Run ./setup-linux.sh first.\n' "$command_name" >&2
    exit 1
  fi
done

cargo build --release --manifest-path native/Cargo.toml
cargo deb --manifest-path native/Cargo.toml --no-build

mkdir -p artifacts
package="$(find native/target/debian -maxdepth 1 -type f -name '*.deb' -print -quit)"
if [[ -z "$package" ]]; then
  printf 'cargo-deb finished without producing a .deb package.\n' >&2
  exit 1
fi
cp -- "$package" artifacts/SuperPDFStudio_Linux.deb
printf 'Debian package created: %s/artifacts/SuperPDFStudio_Linux.deb\n' "$PROJECT_DIR"
