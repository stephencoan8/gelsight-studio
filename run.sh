#!/usr/bin/env bash
# One command for GelSight Studio.
#   ./run.sh         install, build, and serve at http://127.0.0.1:8000
#   ./run.sh dev     API plus a Vite dev server with reload
#   ./run.sh test    ruff, pytest, and the TypeScript check
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
PY="$ROOT/.venv/bin/python"
PIP="$ROOT/.venv/bin/pip"

if [[ ! -x "$PY" ]]; then
  python3 -m venv "$ROOT/.venv"
fi
"$PIP" install -q -r "$ROOT/requirements.txt"

cmd="${1:-serve}"
case "$cmd" in
  test)
    "$ROOT/.venv/bin/ruff" check gelsight studio backend tests
    "$PY" -m pytest -q
    (cd "$ROOT/frontend" && npm install && npm run lint && npm run build)
    ;;
  dev)
    (cd "$ROOT/frontend" && npm install)
    "$PY" -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 &
    trap 'kill %1' EXIT
    cd "$ROOT/frontend" && npm run dev
    ;;
  serve|*)
    (cd "$ROOT/frontend" && npm install && npm run build)
    exec "$PY" -m uvicorn backend.main:app --host "${STUDIO_HOST:-127.0.0.1}" --port "${STUDIO_PORT:-8000}"
    ;;
esac
