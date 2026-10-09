#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'This start script is for Linux only.\n' >&2
  exit 1
fi

for command_name in node npm cargo; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing required command: %s. Run ./setup-linux.sh first.\n' "$command_name" >&2
    exit 1
  fi
done

if [[ ! -d node_modules ]]; then
  printf 'Frontend dependencies are missing. Run ./setup-linux.sh first.\n' >&2
  exit 1
fi

npm run tauri -- dev
