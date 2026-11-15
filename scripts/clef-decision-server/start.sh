#!/usr/bin/env bash
# Start the Clef Decision Server.
#
# Usage:
#   bash scripts/clef-decision-server/start.sh [--background]

set -euo pipefail

VENV_DIR="${CLEF_VENV:-$HOME/.tianshu/clef-decision-venv}"
MODEL_DIR="${CLEF_MODEL_DIR:-$HOME/.tianshu/clef-models}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${CLEF_PORT:-8710}"
LOG_FILE="$HOME/.tianshu/clef-decision-server.log"

if [ -f "$VENV_DIR/bin/python" ]; then
  PY="$VENV_DIR/bin/python"
elif [ -f "$VENV_DIR/Scripts/python.exe" ]; then
  PY="$VENV_DIR/Scripts/python.exe"
else
  echo "❌ Clef not installed. Run install.sh first."
  exit 1
fi

# Find model dir — check install location, then common cache locations
find_model() {
  # Explicit env var
  if [ -n "${CLEF_MODEL_DIR:-}" ] && [ -f "$CLEF_MODEL_DIR/config.json" ]; then
    echo "$CLEF_MODEL_DIR"; return
  fi
  # ModelScope download location
  local ms="$MODEL_DIR/models/Cloudflare--clef-flash/snapshots/master"
  if [ -f "$ms/config.json" ]; then echo "$ms"; return; fi
  # HuggingFace cache
  local hf_dir="$HOME/.cache/huggingface/hub/models--Cloudflare--clef-flash/snapshots"
  if [ -d "$hf_dir" ]; then
    local snap=$(ls -t "$hf_dir" 2>/dev/null | head -1)
    if [ -n "$snap" ] && [ -f "$hf_dir/$snap/config.json" ]; then
      echo "$hf_dir/$snap"; return
    fi
  fi
  echo ""
}

MODEL_PATH=$(find_model)
if [ -z "$MODEL_PATH" ]; then
  echo "❌ Model not found. Run install.sh first."
  exit 1
fi

export CLEF_MODEL_DIR="$MODEL_PATH"

if [ "${1:-}" = "--background" ]; then
  echo "Starting Clef Decision Server in background (port $PORT, log: $LOG_FILE)"
  nohup "$PY" "$SCRIPT_DIR/server.py" --port "$PORT" > "$LOG_FILE" 2>&1 &
  echo "PID: $!"
else
  echo "Starting Clef Decision Server (port $PORT)"
  exec "$PY" "$SCRIPT_DIR/server.py" --port "$PORT"
fi
