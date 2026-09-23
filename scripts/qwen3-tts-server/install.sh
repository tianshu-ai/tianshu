#!/usr/bin/env bash
# Qwen3-TTS local server — one-click install & start for macOS Apple Silicon.
#
# Usage:
#   bash scripts/qwen3-tts-server/install.sh
#
# What it does:
#   1. Checks Python >= 3.10 is available
#   2. Creates a venv at ~/.tianshu/qwen-tts-venv (if not exists)
#   3. Installs mlx-audio + FastAPI dependencies
#   4. Downloads the Qwen3-TTS 0.6B MLX model (~1.2 GB, first run only)
#   5. Prints the command to start the server
#
# After install, start the server with:
#   ~/.tianshu/qwen-tts-venv/bin/python <this-dir>/server.py --port 50000

set -euo pipefail

VENV_DIR="${TIANSHU_TTS_VENV:-$HOME/.tianshu/qwen-tts-venv}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODEL_ID="mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16"
DEFAULT_VOICE="yujie"
PORT=50000

# ── Colors ────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
fail()  { echo -e "${RED}✗${NC} $*"; exit 1; }

# ── Step 1: Find Python >= 3.10 ──────────────────────────────
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   Qwen3-TTS Local Server Installer       ║"
echo "╚══════════════════════════════════════════╝"
echo ""

PYTHON=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" &>/dev/null; then
    ver=$("$candidate" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null || echo "0.0")
    major="${ver%%.*}"
    minor="${ver#*.}"
    if [ "$major" -ge 3 ] && [ "$minor" -ge 10 ]; then
      PYTHON="$candidate"
      break
    fi
  fi
done

if [ -z "$PYTHON" ]; then
  fail "Python >= 3.10 not found.
  macOS ships Python 3.9 which is too old for mlx-audio.
  Install a newer version:
    brew install python@3.11
  or use pyenv / mise / asdf."
fi

PYVER=$("$PYTHON" --version 2>&1)
info "Found $PYVER ($PYTHON)"

# ── Step 2: Check Apple Silicon ───────────────────────────────
ARCH=$(uname -m)
if [ "$ARCH" != "arm64" ]; then
  fail "MLX requires Apple Silicon (arm64). This machine is $ARCH."
fi
info "Apple Silicon detected"

# ── Step 3: Create venv ──────────────────────────────────────
if [ -d "$VENV_DIR" ] && [ -f "$VENV_DIR/bin/python" ]; then
  info "Venv already exists at $VENV_DIR"
else
  echo "Creating venv at $VENV_DIR ..."
  mkdir -p "$(dirname "$VENV_DIR")"
  "$PYTHON" -m venv "$VENV_DIR"
  info "Venv created"
fi

PIP="$VENV_DIR/bin/pip"
PY="$VENV_DIR/bin/python"

# ── Step 4: Install dependencies ─────────────────────────────
echo "Installing dependencies (mlx-audio, FastAPI, etc.) ..."
"$PIP" install --upgrade pip -q 2>/dev/null || true
"$PIP" install \
  mlx mlx-audio sounddevice soundfile numpy \
  fastapi uvicorn python-multipart \
  -q 2>&1 | tail -3

info "Dependencies installed"

# ── Step 5: Pre-download model ───────────────────────────────
echo "Pre-downloading model ($MODEL_ID) ..."
"$PY" -c "
from mlx_audio.tts import load_model
import mlx.core as mx
model = load_model(model_path='$MODEL_ID')
print(f'Model loaded: type={getattr(model.config, \"tts_model_type\", \"base\")}, sample_rate={model.sample_rate}')
# Warm up JIT
for r in model.generate(text='test', verbose=False):
    pass
mx.clear_cache()
print('Model downloaded, loaded, and verified.')
" 2>&1 | grep -v 'Warning\|warning\|Fetching\|transformers\]'

info "Model ready"

# ── Done ─────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════"
echo ""
info "Installation complete!"
echo ""
echo "  Start the TTS server:"
echo ""
echo "    $PY $SCRIPT_DIR/server.py --port $PORT --voice $DEFAULT_VOICE"
echo ""
echo "  Or run in background:"
echo ""
echo "    nohup $PY $SCRIPT_DIR/server.py --port $PORT --voice $DEFAULT_VOICE \\"
echo "      > /tmp/qwen3-tts-server.log 2>&1 &"
echo ""
echo "  Then set in Tianshu:"
echo "    TTS_PROVIDER=qwentts"
echo "    TTS_URL=http://localhost:$PORT"
echo ""
echo "  Or switch in Tianshu UI: Settings → Text to Speech → Qwen3-TTS (Local)"
echo ""
