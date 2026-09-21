#!/usr/bin/env bash
# Start the Qwen3-TTS local server.
#
# Usage:
#   bash scripts/qwen3-tts-server/start.sh              # foreground
#   bash scripts/qwen3-tts-server/start.sh --background  # background with log
#   bash scripts/qwen3-tts-server/start.sh --stop        # kill running server
#   bash scripts/qwen3-tts-server/start.sh --status      # check if running
#
# Env overrides:
#   TIANSHU_TTS_VENV   — venv path (default: ~/.tianshu/qwen-tts-venv)
#   TIANSHU_TTS_PORT   — listen port (default: 50000)
#   TIANSHU_TTS_VOICE  — default voice (default: yujie)
#   TIANSHU_TTS_MODEL  — HuggingFace model id

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_PY="$SCRIPT_DIR/server.py"
VENV_DIR="${TIANSHU_TTS_VENV:-$HOME/.tianshu/qwen-tts-venv}"
PORT="${TIANSHU_TTS_PORT:-50000}"
VOICE="${TIANSHU_TTS_VOICE:-yujie}"
MODEL="${TIANSHU_TTS_MODEL:-mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16}"
LOG_FILE="${TIANSHU_TTS_LOG:-/tmp/qwen3-tts-server.log}"
PID_FILE="/tmp/qwen3-tts-server.pid"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
fail()  { echo -e "${RED}✗${NC} $*"; exit 1; }

# ── Find Python ───────────────────────────────────────────────
find_python() {
  if [ -f "$VENV_DIR/bin/python" ]; then
    echo "$VENV_DIR/bin/python"
    return
  fi
  for p in \
    /opt/homebrew/Caskroom/miniforge/base/envs/qwen-tts/bin/python \
    "$HOME/miniconda3/envs/qwen-tts/bin/python" \
    "$HOME/miniforge3/envs/qwen-tts/bin/python"; do
    if [ -x "$p" ]; then
      echo "$p"
      return
    fi
  done
  fail "No Python environment found. Run install.sh first:
  bash $SCRIPT_DIR/install.sh"
}

# ── Find running server ──────────────────────────────────────
find_pid() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return
    fi
    rm -f "$PID_FILE"
  fi
  pgrep -f "server.py.*--port $PORT" 2>/dev/null | head -1 || true
}

# ── Commands ──────────────────────────────────────────────────
cmd_status() {
  local pid
  pid=$(find_pid)
  if [ -n "$pid" ]; then
    info "Qwen3-TTS server is running (pid=$pid, port=$PORT)"
    if curl -s --connect-timeout 2 "http://localhost:$PORT/health" >/dev/null 2>&1; then
      curl -s "http://localhost:$PORT/health" 2>/dev/null | python3 -m json.tool 2>/dev/null || true
    fi
    return 0
  else
    warn "Qwen3-TTS server is not running"
    return 1
  fi
}

cmd_stop() {
  local pid
  pid=$(find_pid)
  if [ -z "$pid" ]; then
    warn "No running server found"
    return 0
  fi
  echo "Stopping server (pid=$pid) ..."
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      info "Server stopped"
      return 0
    fi
    sleep 0.5
  done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  info "Server killed"
}

cmd_start_foreground() {
  local py
  py=$(find_python)
  info "Starting Qwen3-TTS server (foreground)"
  echo "  Python: $py"
  echo "  Model:  $MODEL"
  echo "  Voice:  $VOICE"
  echo "  Port:   $PORT"
  echo ""
  exec "$py" "$SERVER_PY" --port "$PORT" --voice "$VOICE" --model "$MODEL"
}

cmd_start_background() {
  local existing
  existing=$(find_pid)
  if [ -n "$existing" ]; then
    warn "Server already running (pid=$existing), restarting..."
    cmd_stop
    sleep 1
  fi

  local py
  py=$(find_python)
  echo "Starting Qwen3-TTS server (background) ..."
  echo "  Python: $py"
  echo "  Model:  $MODEL"
  echo "  Voice:  $VOICE"
  echo "  Port:   $PORT"
  echo "  Log:    $LOG_FILE"

  nohup "$py" "$SERVER_PY" \
    --port "$PORT" --voice "$VOICE" --model "$MODEL" \
    > "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  disown "$pid" 2>/dev/null || true

  echo "Waiting for server to be ready ..."
  for i in $(seq 1 120); do
    if ! kill -0 "$pid" 2>/dev/null; then
      fail "Server process exited unexpectedly. Check: tail -f $LOG_FILE"
    fi
    if curl -s --connect-timeout 1 "http://localhost:$PORT/health" >/dev/null 2>&1; then
      echo ""
      info "Server is ready (pid=$pid, port=$PORT)"
      echo ""
      echo "  Health:  http://localhost:$PORT/health"
      echo "  Log:     tail -f $LOG_FILE"
      echo "  Stop:    bash $SCRIPT_DIR/start.sh --stop"
      return 0
    fi
    if (( i % 10 == 0 )); then
      echo -n " (${i}s)"
    else
      echo -n "."
    fi
    sleep 0.5
  done
  warn "Server started (pid=$pid) but not responding on port $PORT yet."
  echo "  It may still be loading the model. Check: tail -f $LOG_FILE"
}

# ── Main ──────────────────────────────────────────────────────
case "${1:-}" in
  --stop|-s)
    cmd_stop
    ;;
  --status)
    cmd_status
    ;;
  --background|--bg|-b)
    cmd_start_background
    ;;
  --help|-h)
    echo "Usage: $0 [--background|--stop|--status|--help]"
    echo ""
    echo "  (no args)     Start in foreground (Ctrl-C to stop)"
    echo "  --background  Start in background with log file"
    echo "  --stop        Stop running server"
    echo "  --status      Check if server is running"
    echo ""
    echo "Environment variables:"
    echo "  TIANSHU_TTS_PORT   Port (default: 50000)"
    echo "  TIANSHU_TTS_VOICE  Default voice (default: yujie)"
    echo "  TIANSHU_TTS_MODEL  HuggingFace model id"
    echo "  TIANSHU_TTS_VENV   Venv path (default: ~/.tianshu/qwen-tts-venv)"
    echo "  TIANSHU_TTS_LOG    Log file (default: /tmp/qwen3-tts-server.log)"
    ;;
  "")
    cmd_start_foreground
    ;;
  *)
    fail "Unknown option: $1. Use --help for usage."
    ;;
esac
