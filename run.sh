#!/usr/bin/env bash
# Surface Measurement is a static site. Processing runs in the browser.
#   ./run.sh         install, build, and preview at http://127.0.0.1:8000/surface-measurement/
#   ./run.sh dev     Vite with reload at http://127.0.0.1:5173/surface-measurement/
#   ./run.sh test    vitest and the TypeScript build
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/frontend"
npm install
cmd="${1:-serve}"
case "$cmd" in
  test)
    npm test
    npm run build
    ;;
  dev)
    exec npm run dev -- --host 127.0.0.1
    ;;
  serve|*)
    npm run build
    exec npm run preview -- --host 127.0.0.1 --port "${STUDIO_PORT:-8000}"
    ;;
esac
