#!/usr/bin/env bash
# Qwen3-TTS local server — cross-platform install for macOS (MLX) and Linux (PyTorch).
#
# Usage:
#   bash scripts/qwen3-tts-server/install.sh
#
# What it does:
#   1. Checks Python >= 3.10
#   2. Creates a venv at ~/.tianshu/qwen-tts-venv
#   3. Detects platform → installs mlx-audio (Mac) or qwen-tts (Linux)
#   4. Pre-downloads the model
#   5. Prints the command to start the server
#
# After install, start with:
#   ~/.tianshu/qwen-tts-venv/bin/python <this-dir>/server.py --port 50000

set -euo pipefail

VENV_DIR="${TIANSHU_TTS_VENV:-$HOME/.tianshu/qwen-tts-venv}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
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
  fail "Python >= 3.10 not found. Install python3.11+ via your package manager."
fi

PYVER=$("$PYTHON" --version 2>&1)
info "Found $PYVER ($PYTHON)"

# ── Step 2: Detect platform ──────────────────────────────────
OS=$(uname -s)
ARCH=$(uname -m)
BACKEND=""

if [ "$OS" = "Darwin" ] && [ "$ARCH" = "arm64" ]; then
  BACKEND="mlx"
  MODEL_ID="mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16"
  info "Apple Silicon detected → MLX backend"
elif [ "$OS" = "Linux" ]; then
  BACKEND="faster"  # default; install step falls back to pytorch if needed
  MODEL_ID="Qwen/Qwen3-TTS-12Hz-1.7B-Base"
  # Check for CUDA
  if command -v nvidia-smi &>/dev/null; then
    info "Linux + NVIDIA GPU detected → faster-qwen3-tts (CUDA Graph) preferred"
  else
    BACKEND="pytorch"
    warn "Linux without NVIDIA GPU → PyTorch CPU backend (slow, not recommended)"
  fi
else
  fail "Unsupported platform: $OS $ARCH. Requires Apple Silicon Mac or Linux."
fi

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
echo "Installing dependencies ..."
"$PIP" install --upgrade pip -q 2>/dev/null || true

if [ "$BACKEND" = "mlx" ]; then
  "$PIP" install \
    mlx mlx-audio sounddevice soundfile numpy \
    fastapi uvicorn python-multipart \
    -q 2>&1 | tail -3
  info "MLX dependencies installed"
elif [ "$BACKEND" = "faster" ]; then
  # Prefer faster-qwen3-tts (CUDA Graph acceleration, true streaming)
  if "$PIP" install \
    faster-qwen3-tts soundfile numpy \
    fastapi uvicorn python-multipart \
    -q 2>&1 | tail -3; then
    info "faster-qwen3-tts dependencies installed (CUDA Graph enabled)"
  else
    warn "faster-qwen3-tts install failed, falling back to qwen-tts"
    BACKEND="pytorch"
    "$PIP" install \
      qwen-tts soundfile numpy \
      fastapi uvicorn python-multipart \
      -q 2>&1 | tail -3
    # Try to install flash-attn for better performance (optional)
    echo "Installing FlashAttention 2 (optional, may take a few minutes) ..."
    MAX_JOBS=4 "$PIP" install flash-attn --no-build-isolation -q 2>&1 | tail -3 || {
      warn "FlashAttention 2 install failed (non-fatal). Using default attention."
    }
    info "PyTorch dependencies installed (fallback)"
  fi
else
  # PyTorch backend (CPU or explicit)
  "$PIP" install \
    qwen-tts soundfile numpy \
    fastapi uvicorn python-multipart \
    -q 2>&1 | tail -3

  # Try to install flash-attn for better performance (optional)
  if command -v nvidia-smi &>/dev/null; then
    echo "Installing FlashAttention 2 (optional, may take a few minutes) ..."
    MAX_JOBS=4 "$PIP" install flash-attn --no-build-isolation -q 2>&1 | tail -3 || {
      warn "FlashAttention 2 install failed (non-fatal). Using default attention."
    }
  fi
  info "PyTorch dependencies installed"
fi

# ── Step 5: Pre-download model ───────────────────────────────
echo "Pre-downloading model ($MODEL_ID) ..."

if [ "$BACKEND" = "mlx" ]; then
  "$PY" -c "
from mlx_audio.tts import load_model
import mlx.core as mx
model = load_model(model_path='$MODEL_ID')
print(f'Model loaded: type={getattr(model.config, \"tts_model_type\", \"base\")}, sr={model.sample_rate}')
for r in model.generate(text='test', verbose=False):
    pass
mx.clear_cache()
print('Model verified.')
" 2>&1 | grep -v 'Warning\|warning\|Fetching\|transformers\]'
elif [ "$BACKEND" = "faster" ]; then
  "$PY" -c "
from faster_qwen3_tts import FasterQwen3TTS
print('Loading faster-qwen3-tts model...')
model = FasterQwen3TTS.from_pretrained('$MODEL_ID')
print('Model downloaded and loaded (faster backend).')
" 2>&1 | grep -v 'Warning\|warning\|Fetching'
else
  "$PY" -c "
import torch
from qwen_tts import Qwen3TTSModel
device = 'cuda:0' if torch.cuda.is_available() else 'cpu'
dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
print(f'Loading on {device} with {dtype}...')
model = Qwen3TTSModel.from_pretrained('$MODEL_ID', device_map=device, dtype=dtype)
print('Model downloaded and loaded.')
" 2>&1 | grep -v 'Warning\|warning\|Fetching'
fi

info "Model ready"

# ── Done ─────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════"
echo ""
info "Installation complete! (backend: $BACKEND)"
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
echo "  Then set in Tianshu UI: Settings → Text to Speech → Qwen3-TTS (Local)"
echo ""
