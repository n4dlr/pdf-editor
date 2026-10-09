#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'This start script is for Linux only.\n' >&2
  exit 1
fi

for command_name in cargo; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing required command: %s. Run ./setup-linux.sh first.\n' "$command_name" >&2
    exit 1
  fi
done

cargo run --manifest-path native/Cargo.toml -- "$@"
