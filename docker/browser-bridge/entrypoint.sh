#!/bin/bash
set -e

# Validate required env
if [ -z "$TIANSHU_SERVER" ]; then
  echo "ERROR: TIANSHU_SERVER not set (e.g. https://tianshu.example.com:3456)"
  exit 1
fi

if [ -z "$TIANSHU_TOKEN" ]; then
  echo "ERROR: TIANSHU_TOKEN not set (pair token from tianshu)"
  exit 1
fi

echo "[browser-bridge] Starting Local Bridge → $TIANSHU_SERVER"
echo "[browser-bridge] Chrome: $(chromium --version 2>/dev/null || echo 'available via playwright')"
echo "[browser-bridge] Node: $(node --version)"
echo "[browser-bridge] Python: $(python3 --version)"

exec tianshu-local-bridge \
  --server "$TIANSHU_SERVER" \
  --token "$TIANSHU_TOKEN" \
  ${BRIDGE_NAME:+--name "$BRIDGE_NAME"}
