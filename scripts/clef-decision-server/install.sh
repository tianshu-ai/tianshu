#!/usr/bin/env bash
# Clef Decision Model local server — cross-platform install.
#
# Usage:
#   bash scripts/clef-decision-server/install.sh
#
# What it does:
#   1. Checks Python >= 3.10
#   2. Creates a venv at ~/.tianshu/clef-decision-venv
#   3. Installs PyTorch + transformers + accelerate
#   4. Downloads the model from ModelScope (China) or HuggingFace
#   5. Prints the command to start the server
#
# After install, start with:
#   ~/.tianshu/clef-decision-venv/bin/python <this-dir>/server.py --port 8710

set -euo pipefail

VENV_DIR="${CLEF_VENV:-$HOME/.tianshu/clef-decision-venv}"
MODEL_DIR="${CLEF_MODEL_DIR:-$HOME/.tianshu/clef-models}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_MODEL="clef-flash"
PORT=8710

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
echo "║   Clef Decision Server Installer          ║"
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
DEVICE=""

if [ "$OS" = "Darwin" ] && [ "$ARCH" = "arm64" ]; then
  DEVICE="mps"
  info "Apple Silicon detected → MPS backend"
elif [ "$OS" = "Linux" ]; then
  if command -v nvidia-smi &>/dev/null; then
    DEVICE="cuda"
    info "Linux + NVIDIA GPU detected → CUDA backend"
  else
    DEVICE="cpu"
    warn "Linux without GPU → CPU backend (slower, but works)"
  fi
else
  DEVICE="cpu"
  warn "Platform: $OS $ARCH → CPU backend"
fi

# ── Step 3: Create venv ──────────────────────────────────────
if [ -d "$VENV_DIR" ] && [ -f "$VENV_DIR/bin/python" -o -f "$VENV_DIR/Scripts/python.exe" ]; then
  info "Venv already exists at $VENV_DIR"
else
  echo "Creating venv at $VENV_DIR ..."
  mkdir -p "$(dirname "$VENV_DIR")"
  "$PYTHON" -m venv "$VENV_DIR"
  info "Venv created"
fi

if [ -f "$VENV_DIR/bin/pip" ]; then
  PIP="$VENV_DIR/bin/pip"
  PY="$VENV_DIR/bin/python"
else
  PIP="$VENV_DIR/Scripts/pip.exe"
  PY="$VENV_DIR/Scripts/python.exe"
fi

# ── Step 4: Install dependencies ─────────────────────────────
echo "Installing dependencies ..."
"$PIP" install --upgrade pip -q 2>/dev/null || true

"$PIP" install \
  torch transformers huggingface_hub accelerate \
  pillow torchvision modelscope \
  -q 2>&1 | tail -5

info "Dependencies installed"

# ── Step 5: Download model ───────────────────────────────────
MODEL_ID="Cloudflare/$DEFAULT_MODEL"

echo "Downloading model ($MODEL_ID) ..."
echo "Trying ModelScope first (faster in China) ..."

mkdir -p "$MODEL_DIR"

"$PY" -c "
import os, sys
model_id = '$MODEL_ID'
model_dir = '$MODEL_DIR'

# Try ModelScope first (faster in China)
try:
    from modelscope import snapshot_download
    path = snapshot_download(model_id, cache_dir=model_dir)
    print(f'Downloaded via ModelScope: {path}')
    sys.exit(0)
except Exception as e:
    print(f'ModelScope failed: {e}, trying HuggingFace...')

# Fallback to HuggingFace
try:
    from huggingface_hub import snapshot_download
    # Try China mirror first
    os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
    path = snapshot_download(model_id, cache_dir=os.path.join(model_dir, 'hf'))
    print(f'Downloaded via HuggingFace: {path}')
except Exception as e:
    print(f'HuggingFace also failed: {e}')
    print('You can download manually and set CLEF_MODEL_DIR.')
    sys.exit(1)
" 2>&1 | tail -10

info "Model ready"

# ── Done ─────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════"
echo ""
info "Installation complete! (device: $DEVICE)"
echo ""
echo "  Start the decision server:"
echo ""
echo "    $PY $SCRIPT_DIR/server.py --port $PORT"
echo ""
echo "  Or run in background:"
echo ""
echo "    nohup $PY $SCRIPT_DIR/server.py --port $PORT \\"
echo "      > ~/.tianshu/clef-decision-server.log 2>&1 &"
echo ""
echo "  Then enable in Tianshu UI: Settings → Decision Model → Enable"
echo ""
